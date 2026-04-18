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

if (!SUPABASE_URL || !SUPABASE_KEY || !ADMIN_PASSWORD) {
  console.warn(
    'Missing required environment variables. Check SUPABASE_URL, SUPABASE_KEY and ADMIN_PASSWORD.'
  );
}

const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_KEY || 'placeholder-key');
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

async function listLinks() {
  const { data, error } = await supabase
    .from('links')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data || [];
}

function getBaseUrl(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/+$/, '');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/go/:slug', async (req, res) => {
  const slug = normalizeSlug(req.params.slug);

  try {
    const { data, error } = await supabase
      .from('links')
      .select('destination_url, restaurant_name, slug')
      .eq('slug', slug)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return res.status(404).send('Link not found.');
    }

    return res.redirect(302, data.destination_url);
  } catch (error) {
    console.error('Redirect error:', error);
    return res.status(500).send('Failed to resolve redirect.');
  }
});

app.get('/admin', async (req, res) => {
  const authenticated = isAdminAuthenticated(req);

  if (!authenticated) {
    return res.render('admin', {
      authenticated: false,
      error: null,
      success: null,
      links: [],
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: {}
    });
  }

  try {
    const links = await listLinks();
    return res.render('admin', {
      authenticated: true,
      error: null,
      success: null,
      links,
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: {}
    });
  } catch (error) {
    console.error('Admin list error:', error);
    return res.status(500).render('admin', {
      authenticated: true,
      error: 'Nao foi possivel carregar os links.',
      success: null,
      links: [],
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: {}
    });
  }
});

app.post('/admin/login', (req, res) => {
  const password = normalizeInput(req.body.password || '');

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).render('admin', {
      authenticated: false,
      error: 'Password invalida.',
      success: null,
      links: [],
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: {}
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
    const links = await listLinks().catch(() => []);
    return res.status(400).render('admin', {
      authenticated: true,
      error: 'Preenche nome do restaurante, slug e URL.',
      success: null,
      links,
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: { restaurant_name, slug, destination_url }
    });
  }

  try {
    const { error } = await supabase.from('links').insert({
      restaurant_name,
      slug,
      destination_url
    });

    if (error) {
      throw error;
    }

    return res.redirect('/admin');
  } catch (error) {
    console.error('Create link error:', error);
    const links = await listLinks().catch(() => []);
    return res.status(400).render('admin', {
      authenticated: true,
      error: error.message || 'Nao foi possivel criar o link.',
      success: null,
      links,
      baseUrl: getBaseUrl(req),
      editingId: null,
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
    const links = await listLinks().catch(() => []);
    return res.status(400).render('admin', {
      authenticated: true,
      error: 'Todos os campos sao obrigatorios para editar.',
      success: null,
      links,
      baseUrl: getBaseUrl(req),
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

    return res.redirect('/admin');
  } catch (error) {
    console.error('Update link error:', error);
    const links = await listLinks().catch(() => []);
    return res.status(400).render('admin', {
      authenticated: true,
      error: error.message || 'Nao foi possivel editar o link.',
      success: null,
      links,
      baseUrl: getBaseUrl(req),
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
    const links = await listLinks().catch(() => []);
    return res.status(400).render('admin', {
      authenticated: true,
      error: error.message || 'Nao foi possivel apagar o link.',
      success: null,
      links,
      baseUrl: getBaseUrl(req),
      editingId: null,
      formData: {}
    });
  }
});

app.use((req, res) => {
  res.status(404).send('Page not found.');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
