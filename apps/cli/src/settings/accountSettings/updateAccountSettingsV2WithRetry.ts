import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

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
  AccountSettingsPersistedObjectSchema,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountSettings,
  type AccountSettingsPersistedObject,
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

function parsePersistedAccountSettingsObject(raw: unknown): AccountSettingsPersistedObject {
  const parsed = AccountSettingsPersistedObjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Account settings content must be a JSON object');
  }
  return parsed.data;
}

function hasOwnRecordKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function mergeMutationResultWithRawBase(params: Readonly<{
  rawBase: AccountSettingsPersistedObject;
  mutatedRaw: AccountSettingsPersistedObject;
}>): AccountSettingsPersistedObject {
  const runtimeDefaults = accountSettingsParse({});
  const parsedBase = accountSettingsParse(params.rawBase);
  const next: Record<string, unknown> = {};

  for (const [key, baseValue] of Object.entries(params.rawBase)) {
    if (!hasOwnRecordKey(params.mutatedRaw, key)) {
      next[key] = baseValue;
      continue;
    }

    const mutatedValue = params.mutatedRaw[key];
    const parsedBaseValue = parsedBase[key];
    const looksLikeParserMaterializedValue =
      !isDeepStrictEqual(baseValue, parsedBaseValue)
      && isDeepStrictEqual(mutatedValue, parsedBaseValue);

    next[key] = looksLikeParserMaterializedValue ? baseValue : mutatedValue;
  }

  for (const [key, mutatedValue] of Object.entries(params.mutatedRaw)) {
    if (hasOwnRecordKey(params.rawBase, key)) continue;

    const isRuntimeDefaultAddition =
      hasOwnRecordKey(runtimeDefaults, key)
      && isDeepStrictEqual(mutatedValue, runtimeDefaults[key]);

    if (!isRuntimeDefaultAddition) {
      next[key] = mutatedValue;
    }
  }

  return parsePersistedAccountSettingsObject(next);
}

async function parseSettingsFromContent(params: Readonly<{
  content: AccountSettingsStoredContentEnvelope | null;
  credentials: Credentials;
}>): Promise<{ raw: AccountSettingsPersistedObject; envelopeKind: 'plain' | 'encrypted' }> {
  if (!params.content) {
    return { raw: {}, envelopeKind: 'encrypted' };
  }

  if (params.content.t === 'plain') {
    return { raw: parsePersistedAccountSettingsObject(params.content.v), envelopeKind: 'plain' };
  }

  const ciphertext = params.content.c;
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: resolveMaterial(params.credentials),
    ciphertext,
  });
  if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
    return { raw: parsePersistedAccountSettingsObject(opened.value), envelopeKind: 'encrypted' };
  }

  const decrypted = await decryptAccountSettingsCiphertext({ credentials: params.credentials, ciphertext });
  if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
    return { raw: parsePersistedAccountSettingsObject(decrypted), envelopeKind: 'encrypted' };
  }

  throw new Error('Failed to decrypt account settings ciphertext');
}

export type AccountSettingsUpdateV2Deps = Readonly<{
  fetchSettings?: () => Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  updateSettings?: (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>) => Promise<AccountSettingsV2UpdateResponse>;
  randomBytes?: (n: number) => Uint8Array;
  nowMs?: () => number;
  resolveCachePath?: (credentials: Credentials) => string;
  writeCache?: (path: string, cache: AccountSettingsCache) => Promise<void>;
}>;

export type UpdateAccountSettingsV2WithRetryParams = Readonly<{
  credentials: Credentials;
  mutate: (
    settings: Readonly<Record<string, unknown>>,
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  deps?: AccountSettingsUpdateV2Deps;
  maxAttempts?: number;
}>;

export async function updateAccountSettingsV2WithRetry(
  _params: UpdateAccountSettingsV2WithRetryParams,
): Promise<{ version: number; settings?: AccountSettings }> {
  const params = _params;
  const maxAttempts = Number.isFinite(params.maxAttempts) && (params.maxAttempts as number) > 0 ? Math.floor(params.maxAttempts as number) : 3;
  const randomBytes = params.deps?.randomBytes ?? resolveDefaultRandomBytes();
  const nowMs = params.deps?.nowMs ?? (() => Date.now());
  const resolveCachePath = params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath;
  const writeCache = params.deps?.writeCache ?? writeAccountSettingsCacheAtomic;

  const writeCacheSnapshot = async (settingsContent: AccountSettingsStoredContentEnvelope | null, settingsVersion: number): Promise<void> => {
    const cachePath = resolveCachePath(params.credentials);
    try {
      await writeCache(cachePath, {
        version: 2,
        cachedAt: nowMs(),
        settingsContent,
        settingsVersion,
      });
    } catch (error) {
      logger.debug('[accountSettings] cache write failed after settings refresh/update (ignored)', serializeAxiosErrorForLog(error));
    }
  };

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
    const nextRaw = mergeMutationResultWithRawBase({
      rawBase: parsed.raw,
      mutatedRaw: parsePersistedAccountSettingsObject(await params.mutate(parsed.raw)),
    });
    const nextSettings = accountSettingsParse(nextRaw);

    if (isDeepStrictEqual(nextRaw, parsed.raw)) {
      await writeCacheSnapshot(content, version);
      return { version, settings: nextSettings };
    }

    const nextContent: AccountSettingsStoredContentEnvelope =
      parsed.envelopeKind === 'plain'
        ? { t: 'plain', v: nextRaw }
        : {
          t: 'encrypted',
          c: sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: resolveMaterial(params.credentials),
            payload: nextRaw,
            randomBytes,
          }),
        };

    const response = await updateSettings({ expectedVersion: version, content: nextContent });
    if (response.success === true) {
      await writeCacheSnapshot(nextContent, response.version);
      return { version: response.version, settings: nextSettings };
    }

    // Version mismatch: retry using the returned currentContent/version.
    content = response.currentContent;
    version = response.currentVersion;
  }

  throw new Error('Failed to update account settings: max retries exceeded');
}
