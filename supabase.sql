create extension if not exists pgcrypto;

create table if not exists public.gates (
  id text primary key,
  command text not null default 'NONE' check (command in ('OPEN', 'CLOSE', 'NONE')),
  command_id bigint not null default 0,
  ack_id bigint not null default 0,
  result text not null default 'DONE' check (result in ('PENDING', 'DONE', 'ERROR')),
  last_seen timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.gate_devices (
  gate_id text primary key references public.gates(id) on delete cascade,
  token_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.logs (
  id bigint generated always as identity primary key,
  gate_id text references public.gates(id) on delete set null,
  command text,
  command_id bigint,
  result text,
  source text,
  created_at timestamptz not null default now()
);

insert into public.gates(id)
values ('gate1'), ('gate2')
on conflict (id) do nothing;

alter table public.gates enable row level security;
alter table public.gate_devices enable row level security;
alter table public.logs enable row level security;

drop policy if exists "authenticated can read gates" on public.gates;
create policy "authenticated can read gates"
on public.gates for select
to authenticated
using (true);

drop policy if exists "authenticated can read logs" on public.logs;
create policy "authenticated can read logs"
on public.logs for select
to authenticated
using (true);

create or replace function public.send_gate_command(
  p_gate_id text,
  p_command text,
  p_command_id bigint
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'auth required';
  end if;

  if p_command not in ('OPEN', 'CLOSE') then
    raise exception 'bad command';
  end if;

  update public.gates
  set command = p_command,
      command_id = p_command_id,
      result = 'PENDING',
      updated_at = now()
  where id = p_gate_id;

  if not found then
    raise exception 'gate not found';
  end if;

  insert into public.logs(gate_id, command, command_id, result, source)
  values (p_gate_id, p_command, p_command_id, 'PENDING', 'web');
end;
$$;

grant execute on function public.send_gate_command(text, text, bigint) to authenticated;

create or replace function public.device_get_gate(
  p_gate_id text,
  p_device_token text
)
returns table (
  id text,
  command text,
  command_id bigint,
  ack_id bigint,
  result text,
  last_seen timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1
    from public.gate_devices
    where gate_id = p_gate_id
      and token_hash = encode(digest(p_device_token, 'sha256'), 'hex')
  ) then
    raise exception 'bad device token';
  end if;

  return query
  select g.id, g.command, g.command_id, g.ack_id, g.result, g.last_seen, g.updated_at
  from public.gates g
  where g.id = p_gate_id;
end;
$$;

grant execute on function public.device_get_gate(text, text) to anon;

create or replace function public.device_ack_gate(
  p_gate_id text,
  p_device_token text,
  p_command_id bigint,
  p_result text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_command text;
begin
  if p_result not in ('DONE', 'ERROR') then
    raise exception 'bad result';
  end if;

  if not exists (
    select 1
    from public.gate_devices
    where gate_id = p_gate_id
      and token_hash = encode(digest(p_device_token, 'sha256'), 'hex')
  ) then
    raise exception 'bad device token';
  end if;

  select command into current_command
  from public.gates
  where id = p_gate_id;

  update public.gates
  set ack_id = p_command_id,
      result = p_result,
      command = 'NONE',
      last_seen = now(),
      updated_at = now()
  where id = p_gate_id;

  insert into public.logs(gate_id, command, command_id, result, source)
  values (p_gate_id, current_command, p_command_id, p_result, 'esp8266');
end;
$$;

grant execute on function public.device_ack_gate(text, text, bigint, text) to anon;

create or replace function public.device_heartbeat(
  p_gate_id text,
  p_device_token text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (
    select 1
    from public.gate_devices
    where gate_id = p_gate_id
      and token_hash = encode(digest(p_device_token, 'sha256'), 'hex')
  ) then
    raise exception 'bad device token';
  end if;

  update public.gates
  set last_seen = now(),
      updated_at = now()
  where id = p_gate_id;
end;
$$;

grant execute on function public.device_heartbeat(text, text) to anon;

-- После выбора токенов устройств выполни вручную:
-- insert into public.gate_devices(gate_id, token_hash)
-- values
--   ('gate1', encode(digest('REPLACE_GATE1_DEVICE_TOKEN', 'sha256'), 'hex')),
--   ('gate2', encode(digest('REPLACE_GATE2_DEVICE_TOKEN', 'sha256'), 'hex'))
-- on conflict (gate_id) do update set token_hash = excluded.token_hash;
