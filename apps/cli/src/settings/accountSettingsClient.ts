import axios from 'axios';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { decodeBase64, decrypt } from '@/api/encryption';
import { logger } from '@/ui/logger';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

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

function isAccountSettingsDebugEnabled(): boolean {
  const raw = typeof process.env.HAPPIER_DEBUG_ACCOUNT_SETTINGS === 'string'
    ? process.env.HAPPIER_DEBUG_ACCOUNT_SETTINGS.trim().toLowerCase()
    : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export async function decryptAccountSettingsCiphertext(params: Readonly<{
  credentials: Credentials;
  ciphertext: string;
}>): Promise<Record<string, unknown> | null> {
  const { credentials, ciphertext } = params;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material:
      credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: credentials.encryption.secret }
        : { type: 'dataKey', machineKey: credentials.encryption.machineKey },
    ciphertext,
  });
  if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: protocol open success', {
        encryptionType: credentials.encryption.type,
        format: opened.format,
        keyCount: Object.keys(opened.value as Record<string, unknown>).length,
      });
    }
    return opened.value as Record<string, unknown>;
  }

  const key =
    credentials.encryption.type === 'legacy'
      ? credentials.encryption.secret
      : credentials.encryption.machineKey;
  const variant = credentials.encryption.type === 'legacy' ? 'legacy' : 'dataKey';

  try {
    const decoded = decodeBase64(ciphertext);
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: start', {
        encryptionType: credentials.encryption.type,
        variant,
        decodedLength: decoded.length,
        firstByte: decoded.length ? decoded[0] : null,
        looksLikeAesV0: decoded.length ? decoded[0] === 0 : null,
      });
    }
    const decrypted = decrypt(key, variant, decoded) as unknown;
    if (!decrypted || typeof decrypted !== 'object' || Array.isArray(decrypted)) return null;
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: success', {
        encryptionType: credentials.encryption.type,
        variant,
        keyCount: Object.keys(decrypted as Record<string, unknown>).length,
      });
    }
    return decrypted as Record<string, unknown>;
  } catch {
    if (isAccountSettingsDebugEnabled()) {
      logger.debug('[accountSettings] decrypt: threw', {
        encryptionType: credentials.encryption.type,
        variant,
      });
    }
    return null;
  }
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
  if (isAccountSettingsDebugEnabled()) {
    logger.debug('[accountSettings] fetch: start', {
      mode,
      serverUrl: configuration.serverUrl,
      activeServerId: configuration.activeServerId,
      cachePath,
      encryptionType: params.credentials.encryption.type,
    });
  }

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
    if (isAccountSettingsDebugEnabled()) {
      const decoded = (() => {
        try { return decodeBase64(settingsCiphertext); } catch { return null; }
      })();
      logger.debug('[accountSettings] fetch: network result', {
        settingsVersion,
        ciphertextLength: settingsCiphertext.length,
        decodedLength: decoded?.length ?? null,
        firstByte: decoded && decoded.length ? decoded[0] : null,
        decrypted: Boolean(decrypted),
        decryptedKeyCount: decrypted ? Object.keys(decrypted).length : 0,
        hint:
          params.credentials.encryption.type === 'dataKey' && decoded && decoded.length && decoded[0] !== 0 && !decrypted
            ? 'ciphertext does not look like AES-v0; if this is a legacy account, reconnect terminal so CLI receives legacy credentials'
            : null,
      });
    }
    return { source: 'network', settings: decrypted ?? {}, settingsVersion };
  } catch {
    const cached = await readCache(cachePath);
    if (!cached || !cached.settingsCiphertext) return { source: 'none', settings: {}, settingsVersion: 0 };

    const decrypted = await decryptAccountSettingsCiphertext({ credentials: params.credentials, ciphertext: cached.settingsCiphertext });
    if (isAccountSettingsDebugEnabled()) {
      const decoded = (() => {
        try { return decodeBase64(cached.settingsCiphertext ?? ''); } catch { return null; }
      })();
      logger.debug('[accountSettings] fetch: cache result', {
        settingsVersion: cached.settingsVersion,
        ciphertextLength: cached.settingsCiphertext?.length ?? 0,
        decodedLength: decoded?.length ?? null,
        firstByte: decoded && decoded.length ? decoded[0] : null,
        decrypted: Boolean(decrypted),
        decryptedKeyCount: decrypted ? Object.keys(decrypted).length : 0,
      });
    }
    return { source: 'cache', settings: decrypted ?? {}, settingsVersion: cached.settingsVersion };
  }
}
