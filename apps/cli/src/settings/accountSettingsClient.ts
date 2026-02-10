import axios from 'axios';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '@/api/encryption';

type AccountSettingsCacheV1 = Readonly<{
  version: 1;
  cachedAt: number;
  settingsCiphertext: string | null;
  settingsVersion: number;
}>;

function bestEffortChmod0600(path: string): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  return chmod(path, 0o600).catch(() => {});
}

function resolveAccountSettingsCachePath(): string {
  return join(configuration.activeServerDir, 'account.settings.cache.json');
}

export async function decryptAccountSettingsCiphertext(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): Promise<Record<string, unknown> | null> {
  const { credentials, ciphertext } = params;
  const key =
    credentials.encryption.type === 'legacy'
      ? credentials.encryption.secret
      : credentials.encryption.machineKey;
  const variant = credentials.encryption.type === 'legacy' ? 'legacy' : 'dataKey';

  let decrypted: unknown;
  try {
    const decoded = decodeBase64(ciphertext);
    decrypted = decrypt(key, variant, decoded);
  } catch {
    return null;
  }
  if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
  return decrypted as Record<string, unknown>;
}

async function readCache(path: string): Promise<AccountSettingsCacheV1 | null> {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const v = raw as any;
    if (v.version !== 1) return null;
    if (typeof v.cachedAt !== 'number' || !Number.isFinite(v.cachedAt)) return null;
    if (typeof v.settingsVersion !== 'number' || !Number.isFinite(v.settingsVersion)) return null;
    if (!(typeof v.settingsCiphertext === 'string' || v.settingsCiphertext === null)) return null;
    return v as AccountSettingsCacheV1;
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: AccountSettingsCacheV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await bestEffortChmod0600(path);
}

function readAccountSettingsMode(): 'auto' | 'never' {
  const raw = typeof process.env.HAPPIER_ACCOUNT_SETTINGS_MODE === 'string'
    ? process.env.HAPPIER_ACCOUNT_SETTINGS_MODE.trim().toLowerCase()
    : '';
  if (raw === 'never') return 'never';
  return 'auto';
}

export type AccountSettingsSnapshot = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: Record<string, unknown>;
  settingsVersion: number;
}>;

export async function fetchAccountSettingsSnapshot(params: Readonly<{
  credentials: Credentials;
}>): Promise<AccountSettingsSnapshot> {
  const mode = readAccountSettingsMode();
  if (mode === 'never') return { source: 'none', settings: {}, settingsVersion: 0 };

  const cachePath = resolveAccountSettingsCachePath();

  try {
    const response = await axios.get(`${configuration.serverUrl}/v1/account/settings`, {
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });

    const body = response.data as { settings: string | null; settingsVersion: number };
    const settingsVersion = typeof body?.settingsVersion === 'number' && Number.isFinite(body.settingsVersion) ? body.settingsVersion : 0;
    const settingsCiphertext = typeof body?.settings === 'string' ? body.settings : null;

    await writeCache(cachePath, {
      version: 1,
      cachedAt: Date.now(),
      settingsCiphertext,
      settingsVersion,
    });

    if (!settingsCiphertext) return { source: 'network', settings: {}, settingsVersion };

    const decrypted = await decryptAccountSettingsCiphertext({ credentials: params.credentials, ciphertext: settingsCiphertext });
    return { source: 'network', settings: decrypted ?? {}, settingsVersion };
  } catch {
    const cached = await readCache(cachePath);
    if (!cached || !cached.settingsCiphertext) return { source: 'none', settings: {}, settingsVersion: 0 };

    const decrypted = await decryptAccountSettingsCiphertext({ credentials: params.credentials, ciphertext: cached.settingsCiphertext });
    return { source: 'cache', settings: decrypted ?? {}, settingsVersion: cached.settingsVersion };
  }
}
