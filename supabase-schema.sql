create extension if not exists pgcrypto;

create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  restaurant_name text not null,
  slug text not null unique,
  destination_url text not null
);

create unique index if not exists links_slug_key on public.links (slug);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  link_id uuid not null references public.links (id) on delete cascade,
  public_token text,
  label text,
  is_active boolean not null default true
);

alter table public.cards add column if not exists public_token text;
alter table public.cards add column if not exists label text;
alter table public.cards add column if not exists is_active boolean not null default true;

update public.cards
set public_token = 'card-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
where public_token is null or length(trim(public_token)) = 0;

alter table public.cards alter column public_token set not null;

create unique index if not exists cards_public_token_key on public.cards (public_token);
create index if not exists cards_link_id_idx on public.cards (link_id);
create index if not exists cards_link_id_active_idx on public.cards (link_id, is_active);

create table if not exists public.daily_link_stats (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  link_id uuid not null references public.links (id) on delete cascade,
  stat_date date not null,
  open_count integer not null default 0,
  unique (link_id, stat_date)
);

create index if not exists daily_link_stats_link_id_idx on public.daily_link_stats (link_id);
create index if not exists daily_link_stats_stat_date_idx on public.daily_link_stats (stat_date desc);

create table if not exists public.daily_card_stats (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  card_id uuid not null references public.cards (id) on delete cascade,
  stat_date date not null,
  open_count integer not null default 0,
  unique (card_id, stat_date)
);

create index if not exists daily_card_stats_card_id_idx on public.daily_card_stats (card_id);
create index if not exists daily_card_stats_stat_date_idx on public.daily_card_stats (stat_date desc);

create or replace function public.increment_daily_link_open(
  p_link_id uuid,
  p_stat_date date default (timezone('Europe/Lisbon', now()))::date
)
returns void
language plpgsql
as $$
begin
  insert into public.daily_link_stats (link_id, stat_date, open_count)
  values (p_link_id, p_stat_date, 1)
  on conflict (link_id, stat_date)
  do update set open_count = public.daily_link_stats.open_count + 1;
end;
$$;

create or replace function public.increment_daily_card_open(
  p_card_id uuid,
  p_stat_date date default (timezone('Europe/Lisbon', now()))::date
)
returns void
language plpgsql
as $$
begin
  insert into public.daily_card_stats (card_id, stat_date, open_count)
  values (p_card_id, p_stat_date, 1)
  on conflict (card_id, stat_date)
  do update set open_count = public.daily_card_stats.open_count + 1;
end;
$$;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  full_name text not null,
  email text,
  phone text,
  company text,
  role text,
  social_link text,
  quantity integer not null default 1,
  notes text,
  status text not null default 'pending'
);

create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_created_at_idx on public.orders (created_at desc);

alter table public.orders add column if not exists attachment_urls text[];

insert into storage.buckets (id, name, public)
values ('order-attachments', 'order-attachments', true)
on conflict (id) do nothing;
