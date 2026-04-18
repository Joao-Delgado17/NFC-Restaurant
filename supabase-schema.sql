create extension if not exists pgcrypto;

create table if not exists public.links (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  restaurant_name text not null,
  slug text not null unique,
  destination_url text not null
);

create unique index if not exists links_slug_key on public.links (slug);
