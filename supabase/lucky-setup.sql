-- Lucky Green: counts reads each day so the lucky-read function can stop at its daily limit.
create table if not exists lucky_reads (day date primary key, n int not null default 0);
alter table lucky_reads enable row level security;

create or replace function lucky_take_read(p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into lucky_reads (day, n) values (current_date, 1)
  on conflict (day) do update set n = lucky_reads.n + 1
  returning n into v;
  return v <= p_limit;
end $$;

revoke all on function lucky_take_read(int) from public, anon, authenticated;
