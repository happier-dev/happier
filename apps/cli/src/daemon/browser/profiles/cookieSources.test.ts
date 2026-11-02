import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { listBrowserCookieSources, readBrowserCookieSource } from './cookieSources';

describe('native browser cookie source', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('reads only the chosen Firefox profile and sites on %s without modifying the source', async platform => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cookie-source-'));
    try {
      const root = platform === 'linux' ? join(home, '.mozilla', 'firefox')
        : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Firefox')
          : join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox');
      const profile = join(root, 'chosen');
      await mkdir(profile, { recursive: true });
      await writeFile(join(root, 'profiles.ini'), '[Profile0]\nName=Chosen\nIsRelative=1\nPath=chosen\n[Profile1]\nName=Other\nIsRelative=1\nPath=other\n');
      const file = join(profile, 'cookies.sqlite');
      const db = openSqliteDatabaseSync(file);
      db.exec('PRAGMA user_version = 12');
      db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT)');
      const insert = db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('.example.test', 'session', 'COOKIE_SENTINEL', '/', 4102444800, 1, 1, 1, '');
      insert.run('unrelated.test', 'session', 'UNRELATED_SENTINEL', '/', 4102444800, 1, 1, 1, '');
      insert.run('.example.test', 'partitioned', 'PARTITION_SENTINEL', '/', 4102444800, 1, 1, 1, '^partitionKey=%28https%2Cexample.test%29');
      db.close();
      const before = await readFile(file);
      const result = await readBrowserCookieSource({ homeDirectory: home, platform, appDataDirectory: join(home, 'AppData', 'Roaming'),
        profileId: createHash('sha256').update(profile).digest('hex'), sites: ['https://login.example.test'] });
      expect(result).toMatchObject({ status: 'ready', cookies: [
        { domain: '.example.test', name: 'session', value: 'COOKIE_SENTINEL', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 4102444800 },
      ], skipped: [{ domain: '.example.test', name: 'partitioned', code: 'partition_unsupported' }] });
      expect(JSON.stringify(result)).not.toContain('UNRELATED_SENTINEL');
      expect(await readFile(file)).toEqual(before);
      expect(await listBrowserCookieSources({ homeDirectory: home, platform, appDataDirectory: join(home, 'AppData', 'Roaming') }))
        .toMatchObject({ sources: [{ label: 'Chosen', browser: 'firefox' }, { label: 'Other', browser: 'firefox' }],
          unsupported: [{ browser: 'chromium', code: 'source_format_unsupported' }, { browser: 'safari', code: 'source_format_unsupported' }] });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('preserves modern Firefox millisecond expiry and unset SameSite and skips explicit partition cookies', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cookie-modern-'));
    try {
      const root = join(home, '.mozilla', 'firefox');
      const profile = join(root, 'chosen');
      await mkdir(profile, { recursive: true });
      await writeFile(join(root, 'profiles.ini'), '[Profile0]\nIsRelative=1\nPath=chosen\n');
      const db = openSqliteDatabaseSync(join(profile, 'cookies.sqlite'));
      db.exec('PRAGMA user_version = 17');
      db.exec('CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, originAttributes TEXT, isPartitionedAttributeSet INTEGER)');
      const insert = db.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('example.test', 'session', 'COOKIE_SENTINEL', '/', 4102444800000, 1, 1, 256, '', 0);
      insert.run('example.test', 'partitioned', 'PARTITION_SENTINEL', '/', 4102444800000, 1, 1, 0, '', 1);
      insert.run('example.test', 'malformed', 'MALFORMED_SENTINEL', '/', 4102444800000, 2, 1, 1, '', 0);
      db.close();
      const result = await readBrowserCookieSource({ homeDirectory: home, platform: 'linux',
        profileId: createHash('sha256').update(profile).digest('hex'), sites: ['https://example.test'] });
      expect(result).toEqual({ status: 'ready', cookies: [{ name: 'session', domain: 'example.test', value: 'COOKIE_SENTINEL',
        path: '/', expires: 4102444800, secure: true, httpOnly: true }],
        skipped: [{ name: 'partitioned', domain: 'example.test', status: 'skipped', code: 'partition_unsupported' },
          { name: 'malformed', domain: 'example.test', status: 'skipped', code: 'source_format_unsupported' }] });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('returns closed unavailable outcomes for protected formats, cancellation and unknown profiles', async () => {
    expect(await readBrowserCookieSource({ browser: 'chromium', profileId: 'x', sites: [] }))
      .toEqual({ status: 'unavailable', code: 'source_format_unsupported' });
    expect(await readBrowserCookieSource({ browser: 'safari', profileId: 'x', sites: [] }))
      .toEqual({ status: 'unavailable', code: 'source_format_unsupported' });
    expect(await readBrowserCookieSource({ profileId: 'x', sites: [], signal: AbortSignal.abort() }))
      .toEqual({ status: 'unavailable', code: 'canceled' });
    expect(await readBrowserCookieSource({ homeDirectory: '/no-cookie-source-fixture', profileId: 'x', sites: [] }))
      .toEqual({ status: 'unavailable', code: 'source_unavailable' });
  });
});
