import { expect, it } from 'vitest';
import { rankByTitleMatch } from './storeSearchRank';

const titles = (rows: readonly { title: string }[]) => rows.map(row => row.title);

it('leads with what is called what was asked for, and keeps the catalog order within each rank', () => {
  const rows = ['Adminer', 'Budibase', 'pgAdmin', 'Postgres', 'PostgreSQL with PgDog', 'Supabase Postgres'].map(title => ({ title }));
  expect(titles(rankByTitleMatch(rows, ' postgres '))).toEqual(['Postgres', 'PostgreSQL with PgDog', 'Supabase Postgres', 'Adminer', 'Budibase', 'pgAdmin']);
});

it('returns the same rows when nothing is asked for or nothing moves', () => {
  const rows = [{ title: 'Adminer' }, { title: 'Budibase' }];
  expect(rankByTitleMatch(rows, '')).toBe(rows);
  expect(rankByTitleMatch(rows, 'postgres')).toBe(rows);
});
