require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || '';
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Lisbon';
const HISTORY_DAYS = 14;

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_PASSWORD) {
  console.warn(
    'Missing required environment variables. Check SUPABASE_URL, SUPABASE_KEY and ADMIN_PASSWORD.'
  );
}

const supabase = createClient(
  SUPABASE_URL || 'https://placeholder.supabase.co',
  SUPABASE_KEY || 'placeholder-key'
);
const ADMIN_COOKIE = 'admin_auth';
const ADMIN_COOKIE_VALUE = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const separatorIndex = pair.indexOf('=');

      if (separatorIndex === -1) {
        return acc;
      }

      const key = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function isAdminAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(ADMIN_PASSWORD) && cookies[ADMIN_COOKIE] === ADMIN_COOKIE_VALUE;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).redirect('/admin');
  }

  next();
}

function normalizeInput(value = '') {
  return value.trim();
}

function normalizeSlug(value = '') {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

function normalizeToken(value = '') {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

function escapeRegExp(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateCardDefaults(restaurantName, index) {
  const baseLabel = restaurantName.trim() || 'Cartao';
  const label = `${baseLabel} ${index}`;
  return {
    label,
    public_token: normalizeToken(label)
  };
}

function getNextCardIndex(existingTokens, baseSlug) {
  let highestIndex = 0;
  const regex = new RegExp(`^${escapeRegExp(baseSlug)}-(\\d+)$`);

  for (const token of existingTokens || []) {
    const match = token.match(regex);
    if (match && match[1]) {
      highestIndex = Math.max(highestIndex, Number(match[1]));
    }
  }

  return highestIndex + 1;
}

function normalizeBoolean(value = '') {
  return value === 'true' || value === 'on' || value === '1';
}

function generateCardToken() {
  return `card-${crypto.randomBytes(4).toString('hex')}`;
}

function getBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/+$/, '');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

function formatDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getDateDaysAgo(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

function getRestaurantStatus(opensToday, opensLast7Days) {
  if (opensToday > 0) {
    return { status: 'active', label: 'Ativo agora', color: 'emerald' };
  }
  if (opensLast7Days > 0) {
    return { status: 'paused', label: 'Pausa', color: 'amber' };
  }
  return { status: 'offline', label: 'Sem atividade', color: 'slate' };
}

function buildHistorySeries(rows, keyField, targetId) {
  const map = new Map(
    rows
      .filter((row) => row[keyField] === targetId)
      .map((row) => [row.stat_date, Number(row.open_count) || 0])
  );

  const labels = [];
  const values = [];

  for (let daysAgo = HISTORY_DAYS - 1; daysAgo >= 0; daysAgo -= 1) {
    const dateKey = formatDateKey(getDateDaysAgo(daysAgo));
    labels.push(dateKey.slice(5));
    values.push(map.get(dateKey) || 0);
  }

  return { labels, values };
}

function buildMetricMap(rows, keyField) {
  const todayKey = formatDateKey(new Date());
  const sevenDaysAgoKey = formatDateKey(getDateDaysAgo(6));
  const metricMap = {};

  for (const row of rows || []) {
    if (!metricMap[row[keyField]]) {
      metricMap[row[keyField]] = {
        opensToday: 0,
        opensLast7Days: 0,
        opensLast14Days: 0
      };
    }

    if (row.stat_date === todayKey) {
      metricMap[row[keyField]].opensToday += row.open_count;
    }

    if (row.stat_date >= sevenDaysAgoKey) {
      metricMap[row[keyField]].opensLast7Days += row.open_count;
    }

    metricMap[row[keyField]].opensLast14Days += row.open_count;
  }

  return metricMap;
}

async function loadAdminData(selectedLinkId, selectedCardId) {
  const historyStartDate = formatDateKey(getDateDaysAgo(HISTORY_DAYS - 1));

  const [
    { data: links, error: linksError },
    { data: cards, error: cardsError },
    { data: linkStatsRows, error: linkStatsError },
    { data: cardStatsRows, error: cardStatsError }
  ] = await Promise.all([
    supabase.from('links').select('*').order('created_at', { ascending: false }),
    supabase.from('cards').select('*').order('created_at', { ascending: true }),
    supabase
      .from('daily_link_stats')
      .select('link_id, stat_date, open_count')
      .gte('stat_date', historyStartDate)
      .order('stat_date', { ascending: true }),
    supabase
      .from('daily_card_stats')
      .select('card_id, stat_date, open_count')
      .gte('stat_date', historyStartDate)
      .order('stat_date', { ascending: true })
  ]);

  if (linksError) {
    throw linksError;
  }

  if (cardsError) {
    throw cardsError;
  }

  if (linkStatsError) {
    throw linkStatsError;
  }

  if (cardStatsError) {
    throw cardStatsError;
  }

  const cardsByLinkId = {};

  for (const card of cards || []) {
    if (!cardsByLinkId[card.link_id]) {
      cardsByLinkId[card.link_id] = [];
    }

    cardsByLinkId[card.link_id].push(card);
  }

  const linkMetricMap = buildMetricMap(linkStatsRows || [], 'link_id');
  const cardMetricMap = buildMetricMap(cardStatsRows || [], 'card_id');

  const linksWithMetrics = (links || []).map((link) => {
    const restaurantCards = cardsByLinkId[link.id] || [];
    const activeCards = restaurantCards.filter((card) => card.is_active);
    const opensToday = linkMetricMap[link.id]?.opensToday || 0;
    const opensLast7Days = linkMetricMap[link.id]?.opensLast7Days || 0;
    const statusInfo = getRestaurantStatus(opensToday, opensLast7Days);

    return {
      ...link,
      card_count: activeCards.length,
      total_cards: restaurantCards.length,
      opens_today: opensToday,
      opens_last_7_days: opensLast7Days,
      opens_last_14_days: linkMetricMap[link.id]?.opensLast14Days || 0,
      status: statusInfo.status,
      status_label: statusInfo.label,
      status_color: statusInfo.color
    };
  });

  const effectiveSelectedLinkId =
    selectedLinkId && linksWithMetrics.some((link) => link.id === selectedLinkId)
      ? selectedLinkId
      : linksWithMetrics[0]?.id || null;

  const selectedLink =
    linksWithMetrics.find((link) => link.id === effectiveSelectedLinkId) || null;

  const selectedLinkCards = (cardsByLinkId[effectiveSelectedLinkId] || []).map((card) => ({
    ...card,
    opens_today: cardMetricMap[card.id]?.opensToday || 0,
    opens_last_7_days: cardMetricMap[card.id]?.opensLast7Days || 0,
    opens_last_14_days: cardMetricMap[card.id]?.opensLast14Days || 0
  }));

  const effectiveSelectedCardId =
    selectedCardId && selectedLinkCards.some((card) => card.id === selectedCardId)
      ? selectedCardId
      : selectedLinkCards[0]?.id || null;

  const selectedCard =
    selectedLinkCards.find((card) => card.id === effectiveSelectedCardId) || null;

  const selectedLinkHistory = selectedLink
    ? buildHistorySeries(linkStatsRows || [], 'link_id', selectedLink.id)
    : { labels: [], values: [] };

  const selectedCardHistory = selectedCard
    ? buildHistorySeries(cardStatsRows || [], 'card_id', selectedCard.id)
    : { labels: [], values: [] };

  const overview = {
    totalLinks: linksWithMetrics.length,
    totalCards: (cards || []).length,
    totalActiveCards: (cards || []).filter((card) => card.is_active).length,
    totalOpensToday: linksWithMetrics.reduce((sum, link) => sum + link.opens_today, 0),
    totalOpensLast7Days: linksWithMetrics.reduce((sum, link) => sum + link.opens_last_7_days, 0)
  };

  return {
    links: linksWithMetrics,
    cards: selectedLinkCards,
    overview,
    selectedLink,
    selectedCard,
    selectedLinkHistory,
    selectedCardHistory
  };
}

function emptyOverview() {
  return {
    totalLinks: 0,
    totalCards: 0,
    totalActiveCards: 0,
    totalOpensToday: 0,
    totalOpensLast7Days: 0
  };
}

function renderAdmin(req, res, data) {
  return res.render('admin', {
    authenticated: data.authenticated,
    error: data.error || null,
    success: data.success || null,
    links: data.links || [],
    cards: data.cards || [],
    overview: data.overview || emptyOverview(),
    selectedLink: data.selectedLink || null,
    selectedCard: data.selectedCard || null,
    selectedLinkHistory: data.selectedLinkHistory || { labels: [], values: [] },
    selectedCardHistory: data.selectedCardHistory || { labels: [], values: [] },
    baseUrl: getBaseUrl(req),
    editingId: data.editingId || null,
    editingCardId: data.editingCardId || null,
    formData: data.formData || {},
    cardFormData: data.cardFormData || {}
  });
}

async function renderAdminWithData(req, res, options) {
  const adminData = await loadAdminData(options.selectedLinkId || null, options.selectedCardId || null).catch(
    () => null
  );

  return renderAdmin(req, res, {
    authenticated: true,
    error: options.error || null,
    success: options.success || null,
    links: adminData?.links || [],
    cards: adminData?.cards || [],
    overview: adminData?.overview || emptyOverview(),
    selectedLink: adminData?.selectedLink || null,
    selectedCard: adminData?.selectedCard || null,
    selectedLinkHistory: adminData?.selectedLinkHistory || { labels: [], values: [] },
    selectedCardHistory: adminData?.selectedCardHistory || { labels: [], values: [] },
    editingId: options.editingId || null,
    editingCardId: options.editingCardId || null,
    formData: options.formData || {},
    cardFormData: options.cardFormData || {}
  });
}

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/go/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  const cardToken = normalizeToken(req.query.card || '');

  try {
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('id, destination_url, slug')
      .eq('slug', slug)
      .maybeSingle();

    if (linkError) {
      throw linkError;
    }

    if (!link) {
      return res.status(404).send('Link not found.');
    }

    const { error: linkStatsError } = await supabase.rpc('increment_daily_link_open', {
      p_link_id: link.id
    });

    if (linkStatsError) {
      console.error('Daily link stats update error:', linkStatsError);
    }

    if (cardToken) {
      const { data: card, error: cardError } = await supabase
        .from('cards')
        .select('id, is_active')
        .eq('link_id', link.id)
        .eq('public_token', cardToken)
        .maybeSingle();

      if (cardError) {
        console.error('Card lookup error:', cardError);
      } else if (card && card.is_active) {
        const { error: cardStatsError } = await supabase.rpc('increment_daily_card_open', {
          p_card_id: card.id
        });

        if (cardStatsError) {
          console.error('Daily card stats update error:', cardStatsError);
        }
      }
    }

    return res.redirect(302, link.destination_url);
  } catch (error) {
    console.error('Redirect error:', error);
    return res.status(500).send('Failed to resolve redirect.');
  }
});

app.get('/admin', async (req, res) => {
  const authenticated = isAdminAuthenticated(req);

  if (!authenticated) {
    return renderAdmin(req, res, {
      authenticated: false
    });
  }

  try {
    const adminData = await loadAdminData(req.query.link || null, req.query.card || null);
    return renderAdmin(req, res, {
      authenticated: true,
      ...adminData
    });
  } catch (error) {
    console.error('Admin load error:', error);
    return renderAdmin(req, res, {
      authenticated: true,
      error: 'Nao foi possivel carregar os dados.'
    });
  }
});

app.post('/admin/login', (req, res) => {
  const password = normalizeInput(req.body.password || '');

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return renderAdmin(req, res, {
      authenticated: false,
      error: 'Password invalida.'
    });
  }

  res.cookie(ADMIN_COOKIE, ADMIN_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 12
  });

  return res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.redirect('/admin');
});

app.post('/admin/links', requireAdmin, async (req, res) => {
  const restaurant_name = normalizeInput(req.body.restaurant_name || '');
  const slug = normalizeSlug(req.body.slug || '');
  const destination_url = normalizeInput(req.body.destination_url || '');

  if (!restaurant_name || !slug || !destination_url) {
    return renderAdminWithData(req, res.status(400), {
      error: 'Preenche nome do restaurante, slug e URL.',
      formData: { restaurant_name, slug, destination_url }
    });
  }

  try {
    const { data: createdLink, error } = await supabase
      .from('links')
      .insert({
        restaurant_name,
        slug,
        destination_url
      })
      .select('id')
      .single();

    if (error) {
      throw error;
    }

    return res.redirect(`/admin?link=${createdLink.id}`);
  } catch (error) {
    console.error('Create link error:', error);
    return renderAdminWithData(req, res.status(400), {
      error: error.message || 'Nao foi possivel criar o link.',
      formData: { restaurant_name, slug, destination_url }
    });
  }
});

app.post('/admin/links/:id/update', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const restaurant_name = normalizeInput(req.body.restaurant_name || '');
  const slug = normalizeSlug(req.body.slug || '');
  const destination_url = normalizeInput(req.body.destination_url || '');

  if (!restaurant_name || !slug || !destination_url) {
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: id,
      error: 'Todos os campos do restaurante sao obrigatorios.',
      editingId: id,
      formData: { restaurant_name, slug, destination_url }
    });
  }

  try {
    const { error } = await supabase
      .from('links')
      .update({
        restaurant_name,
        slug,
        destination_url
      })
      .eq('id', id);

    if (error) {
      throw error;
    }

    return res.redirect(`/admin?link=${id}`);
  } catch (error) {
    console.error('Update link error:', error);
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: id,
      error: error.message || 'Nao foi possivel editar o restaurante.',
      editingId: id,
      formData: { restaurant_name, slug, destination_url }
    });
  }
});

app.post('/admin/links/:id/delete', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('links').delete().eq('id', req.params.id);

    if (error) {
      throw error;
    }

    return res.redirect('/admin');
  } catch (error) {
    console.error('Delete link error:', error);
    return renderAdminWithData(req, res.status(400), {
      error: error.message || 'Nao foi possivel apagar o restaurante.'
    });
  }
});

app.post('/admin/links/:id/cards', requireAdmin, async (req, res) => {
  const linkId = req.params.id;
  const quantity = Math.max(1, Math.min(50, Number(normalizeInput(req.body.quantity || '1')) || 1));
  const label = normalizeInput(req.body.label || '');
  const public_token = normalizeToken(req.body.public_token || '');
  const is_active = normalizeBoolean(req.body.is_active || 'true');

  try {
    const { data: link, error: linkError } = await supabase
      .from('links')
      .select('restaurant_name')
      .eq('id', linkId)
      .maybeSingle();

    if (linkError) {
      throw linkError;
    }

    const restaurantName = link?.restaurant_name || 'Cartao';
    const cardsToInsert = [];
    const baseSlug = normalizeToken(restaurantName);

    if (quantity > 1) {
      const { data: existingCards, error: existingError } = await supabase
        .from('cards')
        .select('public_token')
        .eq('link_id', linkId);

      if (existingError) {
        throw existingError;
      }

      let nextIndex = getNextCardIndex((existingCards || []).map((card) => card.public_token), baseSlug);

      for (let i = 0; i < quantity; i += 1) {
        const defaults = generateCardDefaults(restaurantName, nextIndex + i);
        cardsToInsert.push({
          link_id: linkId,
          label: defaults.label,
          public_token: defaults.public_token,
          is_active
        });
      }
    } else {
      const defaults = generateCardDefaults(restaurantName, 1);
      cardsToInsert.push({
        link_id: linkId,
        label: label || defaults.label,
        public_token: public_token || normalizeToken(label || defaults.label),
        is_active
      });
    }

    const { data: createdCards, error } = await supabase
      .from('cards')
      .insert(cardsToInsert)
      .select('id');

    if (error) {
      throw error;
    }

    return renderAdminWithData(req, res, {
      selectedLinkId: linkId,
      success: quantity > 1 ? `Criados ${createdCards.length} cartoes automaticamente.` : 'Cartao criado com sucesso.'
    });
  } catch (error) {
    console.error('Create card error:', error);
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: linkId,
      error: error.message || 'Nao foi possivel criar o cartao.',
      cardFormData: { label, public_token, is_active, quantity }
    });
  }
});

app.post('/admin/cards/:id/update', requireAdmin, async (req, res) => {
  const cardId = req.params.id;
  const linkId = normalizeInput(req.body.link_id || '');
  const label = normalizeInput(req.body.label || '');
  const public_token = normalizeToken(req.body.public_token || '');
  const is_active = normalizeBoolean(req.body.is_active || '');

  if (!linkId || !public_token) {
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: linkId || null,
      selectedCardId: cardId,
      error: 'O cartao precisa de um token publico.',
      editingCardId: cardId,
      cardFormData: { label, public_token, is_active }
    });
  }

  try {
    const { error } = await supabase
      .from('cards')
      .update({
        label,
        public_token,
        is_active
      })
      .eq('id', cardId);

    if (error) {
      throw error;
    }

    return res.redirect(`/admin?link=${linkId}&card=${cardId}`);
  } catch (error) {
    console.error('Update card error:', error);
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: linkId,
      selectedCardId: cardId,
      error: error.message || 'Nao foi possivel editar o cartao.',
      editingCardId: cardId,
      cardFormData: { label, public_token, is_active }
    });
  }
});

app.post('/admin/cards/:id/delete', requireAdmin, async (req, res) => {
  const linkId = normalizeInput(req.body.link_id || '');

  try {
    const { error } = await supabase.from('cards').delete().eq('id', req.params.id);

    if (error) {
      throw error;
    }

    return res.redirect(linkId ? `/admin?link=${linkId}` : '/admin');
  } catch (error) {
    console.error('Delete card error:', error);
    return renderAdminWithData(req, res.status(400), {
      selectedLinkId: linkId || null,
      error: error.message || 'Nao foi possivel apagar o cartao.'
    });
  }
});

app.use((req, res) => {
  res.status(404).send('Page not found.');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
