import { randomBytes as nodeRandomBytes } from 'node:crypto';

import type { Credentials } from '@/persistence';

import axios from 'axios';

import { configuration } from '@/configuration';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { decryptAccountSettingsCiphertext } from '@/settings/accountSettingsClient';
import {
  accountSettingsParse,
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateResponseSchema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import {
  resolveAccountSettingsCachePath,
  writeAccountSettingsCacheAtomic,
  type AccountSettingsCache,
} from './accountSettingsCache';
import { resolveAccountSettingsHttpBaseUrl } from './resolveAccountSettingsHttpBaseUrl';

function resolveMaterial(credentials: Credentials): { type: 'legacy'; secret: Uint8Array } | { type: 'dataKey'; machineKey: Uint8Array } {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function resolveDefaultRandomBytes(): (n: number) => Uint8Array {
  return (n) => new Uint8Array(nodeRandomBytes(n));
}

async function parseSettingsFromContent(params: Readonly<{
  content: AccountSettingsStoredContentEnvelope | null;
  credentials: Credentials;
}>): Promise<{ raw: Record<string, unknown>; envelopeKind: 'plain' | 'encrypted' }> {
  if (!params.content) {
    return { raw: accountSettingsParse({}), envelopeKind: 'encrypted' };
  }

  if (params.content.t === 'plain') {
    return { raw: params.content.v as any, envelopeKind: 'plain' };
  }

  const ciphertext = params.content.c;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: resolveMaterial(params.credentials),
    ciphertext,
  });
  if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
    return { raw: opened.value as Record<string, unknown>, envelopeKind: 'encrypted' };
  }

  const decrypted = await decryptAccountSettingsCiphertext({ credentials: params.credentials, ciphertext });
  if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
    return { raw: decrypted as Record<string, unknown>, envelopeKind: 'encrypted' };
  }

  throw new Error('Failed to decrypt account settings ciphertext');
}

export async function updateAccountSettingsV2WithRetry(_params: Readonly<{
  credentials: Credentials;
  mutate: (settings: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  deps?: Readonly<{
    fetchSettings?: () => Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
    updateSettings?: (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>) => Promise<AccountSettingsV2UpdateResponse>;
    randomBytes?: (n: number) => Uint8Array;
    nowMs?: () => number;
    resolveCachePath?: () => string;
    writeCache?: (path: string, cache: AccountSettingsCache) => Promise<void>;
  }>;
  maxAttempts?: number;
}>): Promise<{ version: number }> {
  const params = _params;
  const maxAttempts = Number.isFinite(params.maxAttempts) && (params.maxAttempts as number) > 0 ? Math.floor(params.maxAttempts as number) : 3;
  const randomBytes = params.deps?.randomBytes ?? resolveDefaultRandomBytes();
  const nowMs = params.deps?.nowMs ?? (() => Date.now());
  const resolveCachePath = params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath;
  const writeCache = params.deps?.writeCache ?? writeAccountSettingsCacheAtomic;

  const fetchSettings = params.deps?.fetchSettings ?? (async () => {
    const accountSettingsBaseUrl = resolveAccountSettingsHttpBaseUrl();
    const response = await axios.get(`${accountSettingsBaseUrl}/v2/account/settings`, {
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (response.status === 404) {
      throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Failed to fetch /v2/account/settings (${response.status})`);
    }
    const parsed = AccountSettingsV2GetResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new Error('Failed to parse account settings v2 response');
    return { content: parsed.data.content, version: parsed.data.version };
  });

  const updateSettings = params.deps?.updateSettings ?? (async (req) => {
    const accountSettingsBaseUrl = resolveAccountSettingsHttpBaseUrl();
    const response = await axios.post(`${accountSettingsBaseUrl}/v2/account/settings`, {
      content: req.content,
      expectedVersion: req.expectedVersion,
    }, {
      headers: {
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
    });
    if (response.status === 404) {
      throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
    }
    const parsed = AccountSettingsV2UpdateResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error(`Failed to parse account settings v2 update response (${response.status})`);
    }
    return parsed.data;
  });

  let fetched = await fetchSettings();
  let content = fetched.content;
  let version = fetched.version;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const parsed = await parseSettingsFromContent({ content, credentials: params.credentials });
    const nextRaw = params.mutate(parsed.raw);

    const nextContent: AccountSettingsStoredContentEnvelope =
      parsed.envelopeKind === 'plain'
        ? { t: 'plain', v: accountSettingsParse(nextRaw) }
        : {
          t: 'encrypted',
          c: sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: resolveMaterial(params.credentials),
            payload: accountSettingsParse(nextRaw),
            randomBytes,
          }),
        };

    const response = await updateSettings({ expectedVersion: version, content: nextContent });
    if (response.success === true) {
      const cachePath = resolveCachePath();
      try {
        await writeCache(cachePath, {
          version: 2,
          cachedAt: nowMs(),
          settingsContent: nextContent,
          settingsVersion: response.version,
        });
      } catch (error) {
        logger.debug('[accountSettings] cache write failed after update (ignored)', serializeAxiosErrorForLog(error));
      }
      return { version: response.version };
    }

    // Version mismatch: retry using the returned currentContent/version.
    content = response.currentContent;
    version = response.currentVersion;
  }

  throw new Error('Failed to update account settings: max retries exceeded');
}
