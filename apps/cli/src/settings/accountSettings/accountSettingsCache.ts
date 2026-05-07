import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';

export type AccountSettingsCacheV1 = Readonly<{
  version: 1;
  cachedAt: number;
  settingsCiphertext: string | null;
  settingsVersion: number;
}>;

export type AccountSettingsContentEnvelope =
  | Readonly<{ t: 'plain'; v: unknown }>
  | Readonly<{ t: 'encrypted'; c: string }>;

export type AccountSettingsCacheV2 = Readonly<{
  version: 2;
  cachedAt: number;
  settingsContent: AccountSettingsContentEnvelope | null;
  settingsVersion: number;
}>;

export type AccountSettingsCache = AccountSettingsCacheV1 | AccountSettingsCacheV2;

function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  return chmod(path, 0o600).catch(() => {});
}

function hashCacheScopePart(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function resolveAccountSettingsCacheAccountScope(token: string | null | undefined): string | null {
  const normalizedToken = String(token ?? '').trim();
  if (!normalizedToken) return null;

  const payload = decodeJwtPayload(normalizedToken);
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  if (sub) return `sub-${hashCacheScopePart(sub)}`;

  return `token-${hashCacheScopePart(normalizedToken)}`;
}

export function resolveAccountSettingsCachePath(credentials?: Readonly<{ token?: string | null }>): string {
  const accountScope = resolveAccountSettingsCacheAccountScope(credentials?.token);
  if (!accountScope) {
    return join(configuration.activeServerDir, 'account.settings.cache.json');
  }
  return join(
    configuration.activeServerDir,
    'account-settings-cache',
    'by-account',
    accountScope,
    'account.settings.cache.json',
  );
}

export async function readAccountSettingsCache(path: string): Promise<AccountSettingsCache | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as any;
    if (v.version === 1) {
      if (typeof v.cachedAt !== 'number' || !Number.isFinite(v.cachedAt)) return null;
      if (typeof v.settingsVersion !== 'number' || !Number.isFinite(v.settingsVersion)) return null;
      if (!(typeof v.settingsCiphertext === 'string' || v.settingsCiphertext === null)) return null;
      return v as AccountSettingsCacheV1;
    }
    if (v.version === 2) {
      if (typeof v.cachedAt !== 'number' || !Number.isFinite(v.cachedAt)) return null;
      if (typeof v.settingsVersion !== 'number' || !Number.isFinite(v.settingsVersion)) return null;
      const content = v.settingsContent;
      if (content === null) {
        return v as AccountSettingsCacheV2;
      }
      if (!content || typeof content !== 'object') return null;
      if (content.t === 'encrypted') {
        if (typeof content.c !== 'string') return null;
        return v as AccountSettingsCacheV2;
      }
      if (content.t === 'plain') {
        return v as AccountSettingsCacheV2;
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

async function acquireLock(lockFile: string): Promise<{ close: () => Promise<void> }> {
  const LOCK_RETRY_INTERVAL_MS = 100;
  const STALE_LOCK_TIMEOUT_MS = 10_000;
  // Ensure we keep retrying long enough to observe a lock becoming stale and removable.
  const MAX_LOCK_ATTEMPTS = 120;

  let attempts = 0;
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      const fh = await open(lockFile, 'wx');
      return {
        close: async () => {
          try {
            await fh.close();
          } finally {
            await unlink(lockFile).catch(() => {});
          }
        },
      };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      attempts += 1;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
      try {
        const stats = await stat(lockFile);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
          await unlink(lockFile).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  }
  throw new Error('Failed to acquire account settings cache lock');
}

export async function writeAccountSettingsCacheAtomic(path: string, cache: AccountSettingsCache): Promise<void> {
  const lockFile = `${path}.lock`;
  const tmpFile = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireLock(lockFile);
  try {
    await writeFile(tmpFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
    await rename(tmpFile, path);
    await bestEffortChmod0600(path);
  } finally {
    // If `rename` fails we don't want to leave a partially-written tmp file around.
    // If `rename` succeeds the tmp file no longer exists; ignore ENOENT.
    await unlink(tmpFile).catch(() => {});
    await lock.close();
  }
}
