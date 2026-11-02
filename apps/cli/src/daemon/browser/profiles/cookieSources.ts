import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { BrowserCookieV1Schema, type BrowserCookieV1, type BrowserCookieSourceResultV1, type BrowserLoginImportRecordV1 } from '@happier-dev/protocol/browser/profile/v1';

type SourceEnvironment = Readonly<{
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  appDataDirectory?: string;
}>;

function firefoxRoot(input: SourceEnvironment): string | null {
  const home = input.homeDirectory ?? homedir();
  switch (input.platform ?? process.platform) {
    case 'linux': return join(home, '.mozilla', 'firefox');
    case 'darwin': return join(home, 'Library', 'Application Support', 'Firefox');
    case 'win32': return join(input.appDataDirectory ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox');
    default: return null;
  }
}
async function firefoxProfiles(input: SourceEnvironment) {
  const root = firefoxRoot(input);
  if (!root) return [];
  const ini = await readFile(join(root, 'profiles.ini'), 'utf8');
  const sections: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      current = /^\[Profile[^\]]*\]$/.test(line) ? {} : null;
      if (current) sections.push(current);
    } else if (current && !line.startsWith(';') && !line.startsWith('#')) {
      const separator = line.indexOf('=');
      if (separator > 0) current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return sections.filter(section => Boolean(section.Path)).map(section => {
    const directory = section.IsRelative === '0' ? resolve(section.Path) : resolve(root, section.Path);
    return { browser: 'firefox' as const, profileId: createHash('sha256').update(directory).digest('hex'),
      label: section.Name || 'Firefox', directory };
  });
}

/** Called only by an opened import confirmation, never by an Action/catalog mount. */
export async function listBrowserCookieSources(input: SourceEnvironment = {}) {
  try {
    return { sources: (await firefoxProfiles(input)).map(({ directory: _directory, ...source }) => source),
      unsupported: [
        { browser: 'chromium' as const, code: 'source_format_unsupported' as const },
        { browser: 'safari' as const, code: 'source_format_unsupported' as const },
      ] };
  } catch {
    return { sources: [], unsupported: [
      { browser: 'firefox' as const, code: 'source_unavailable' as const },
      { browser: 'chromium' as const, code: 'source_format_unsupported' as const },
      { browser: 'safari' as const, code: 'source_format_unsupported' as const },
    ] };
  }
}

export async function readBrowserCookieSource(input: SourceEnvironment & Readonly<{
  browser?: 'firefox' | 'chromium' | 'safari';
  profileId: string;
  sites: readonly string[];
  signal?: AbortSignal;
}>): Promise<BrowserCookieSourceResultV1> {
  if (input.signal?.aborted) return { status: 'unavailable', code: 'canceled' };
  if (input.browser && input.browser !== 'firefox') return { status: 'unavailable', code: 'source_format_unsupported' };
  let database: ReturnType<typeof openSqliteDatabaseSync> | undefined;
  try {
    const profile = (await firefoxProfiles(input)).find(candidate => candidate.profileId === input.profileId);
    if (!profile) return { status: 'unavailable', code: 'source_unavailable' };
    const domains = new Set<string>();
    for (const site of input.sites) {
      const url = new URL(site);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { status: 'unavailable', code: 'source_format_unsupported' };
      const host = url.hostname;
      domains.add(host);
      const labels = host.split('.');
      for (let index = 0; index < labels.length; index++) domains.add(`.${labels.slice(index).join('.')}`);
    }
    if (domains.size === 0) return { status: 'ready', cookies: [], skipped: [] };
    input.signal?.throwIfAborted();
    database = openSqliteDatabaseSync(join(profile.directory, 'cookies.sqlite'), { readOnly: true });
    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
    const version = versionRow?.user_version;
    // Firefox schema 16 changed expiry from seconds to milliseconds. Unknown
    // formats cannot be interpreted by column names alone.
    if (typeof version !== 'number' || version < 10 || version > 17) {
      return { status: 'unavailable', code: 'source_format_unsupported' };
    }
    const partitionColumn = version >= 13 ? 'isPartitionedAttributeSet' : '0 AS isPartitionedAttributeSet';
    // One selected-profile query, with a single JSON operand rather than a local parameter cap.
    const rows = database.prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes, ${partitionColumn} FROM moz_cookies WHERE host IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...domains]));
    const cookies: BrowserCookieV1[] = [];
    const skipped: BrowserLoginImportRecordV1[] = [];
    for (const value of rows) {
      input.signal?.throwIfAborted();
      if (!value || typeof value !== 'object') return { status: 'unavailable', code: 'source_format_unsupported' };
      const row = value as Record<string, unknown>;
      const metadata = { domain: typeof row.host === 'string' ? row.host : '', name: typeof row.name === 'string' ? row.name : '' };
      if (row.originAttributes !== '' || row.isPartitionedAttributeSet !== 0) {
        skipped.push({ ...metadata, status: 'skipped', code: 'partition_unsupported' });
        continue;
      }
      const expires = typeof row.expiry === 'number' ? row.expiry / (version >= 16 ? 1000 : 1) : undefined;
      if (expires === undefined || expires <= Date.now() / 1000) {
        skipped.push({ ...metadata, status: 'skipped', code: 'expired' });
        continue;
      }
      const sameSite = row.sameSite === 0 ? 'None' : row.sameSite === 1 ? 'Lax' : row.sameSite === 2 ? 'Strict' : undefined;
      if ((!sameSite && row.sameSite !== 256)
        || (row.isSecure !== 0 && row.isSecure !== 1) || (row.isHttpOnly !== 0 && row.isHttpOnly !== 1)) {
        skipped.push({ ...metadata, status: 'skipped', code: 'source_format_unsupported' });
        continue;
      }
      const cookie = BrowserCookieV1Schema.safeParse({ ...metadata, value: row.value, path: row.path,
        expires, secure: row.isSecure === 1, httpOnly: row.isHttpOnly === 1, ...(sameSite ? { sameSite } : {}) });
      if (!cookie.success) { skipped.push({ ...metadata, status: 'skipped', code: 'source_format_unsupported' }); continue; }
      cookies.push(cookie.data);
    }
    return { status: 'ready', cookies, skipped };
  } catch (error) {
    // Native messages can contain database paths and values. Return only our closed reason code.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return { status: 'unavailable', code: input.signal?.aborted ? 'canceled'
      : code === 'EACCES' || code === 'EPERM' ? 'permission_denied'
        : code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'source_locked' : 'source_unavailable' };
  } finally {
    // A close failure must not replace the value-free native outcome with OS text.
    try { database?.close(); } catch { /* The reader never mutates the source. */ }
  }
}
