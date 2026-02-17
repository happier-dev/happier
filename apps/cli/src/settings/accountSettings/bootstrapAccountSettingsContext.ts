import axios from 'axios';

import type { AgentId } from '@happier-dev/agents';
import { accountSettingsParse, type AccountSettings } from '@happier-dev/protocol';

import { createHash } from 'node:crypto';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { decryptAccountSettingsCiphertext } from '@/settings/accountSettingsClient';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';
import { applyAccountSettingsToProcessEnv } from '@/settings/applyAccountSettingsToProcessEnv';
import { applyProviderSpawnExtrasToProcessEnv } from '@/settings/providerSettings';

import {
  type AccountSettingsCacheV1,
  readAccountSettingsCache,
  resolveAccountSettingsCachePath,
  writeAccountSettingsCacheAtomic,
} from './accountSettingsCache';
import { setActiveAccountSettingsSnapshot } from './activeAccountSettingsSnapshot';

export type AccountSettingsBootstrapMode = 'blocking' | 'fast';
export type AccountSettingsRefreshMode = 'auto' | 'force';

export type AccountSettingsContext = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  settingsVersion: number;
  loadedAtMs: number;
  whenRefreshed: Promise<AccountSettingsContext> | null;
}>;

type BootstrapDeps = Readonly<{
  resolveCachePath: () => string;
  readCache: (path: string) => Promise<AccountSettingsCacheV1 | null>;
  writeCache: (path: string, cache: AccountSettingsCacheV1) => Promise<void>;
  fetchFromServer: (args: { credentials: Credentials }) => Promise<{ settingsCiphertext: string | null; settingsVersion: number }>;
  decryptCiphertext: (args: { credentials: Credentials; ciphertext: string }) => Promise<Record<string, unknown> | null>;
  applySideEffects: (args: { settings: AccountSettings; agentId?: AgentId; source: AccountSettingsContext['source']; settingsVersion: number; loadedAtMs: number }) => void;
}>;

function readAccountSettingsModeFromEnv(): 'auto' | 'never' {
  const raw = typeof process.env.HAPPIER_ACCOUNT_SETTINGS_MODE === 'string'
    ? process.env.HAPPIER_ACCOUNT_SETTINGS_MODE.trim().toLowerCase()
    : '';
  if (raw === 'never') return 'never';
  return 'auto';
}

function readTtlMsFromEnvOrDefault(): number {
  const raw = typeof process.env.HAPPIER_ACCOUNT_SETTINGS_TTL_MS === 'string'
    ? process.env.HAPPIER_ACCOUNT_SETTINGS_TTL_MS.trim()
    : '';
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  return 5 * 60_000;
}

function shouldTreatCacheAsFresh(cache: AccountSettingsCacheV1, nowMs: number, ttlMs: number): boolean {
  if (ttlMs <= 0) return false;
  const age = nowMs - cache.cachedAt;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

function tokenScopeKey(token: string): string {
  // Avoid keeping raw access tokens in memory map keys.
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

const inMemoryByScopeKey = new Map<string, AccountSettingsContext>();

export function resetInMemoryAccountSettingsContextForTests(): void {
  inMemoryByScopeKey.clear();
}

export async function bootstrapAccountSettingsContext(params: Readonly<{
  credentials: Credentials;
  agentId?: AgentId;
  mode?: AccountSettingsBootstrapMode;
  refresh?: AccountSettingsRefreshMode;
  nowMs?: number;
  ttlMs?: number;
  deps?: Partial<BootstrapDeps>;
}>): Promise<AccountSettingsContext> {
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const ttlMs = typeof params.ttlMs === 'number' ? params.ttlMs : readTtlMsFromEnvOrDefault();
  const refresh = params.refresh ?? 'auto';
  const mode = params.mode ?? 'blocking';

  const deps: BootstrapDeps = {
    resolveCachePath: params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath,
    readCache: params.deps?.readCache ?? readAccountSettingsCache,
    writeCache: params.deps?.writeCache ?? writeAccountSettingsCacheAtomic,
    fetchFromServer: params.deps?.fetchFromServer ?? (async ({ credentials }) => {
      const response = await axios.get(`${configuration.serverUrl}/v1/account/settings`, {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      });
      const body = response.data as { settings: string | null; settingsVersion: number };
      const settingsVersion = typeof body?.settingsVersion === 'number' && Number.isFinite(body.settingsVersion)
        ? body.settingsVersion
        : 0;
      const settingsCiphertext = typeof body?.settings === 'string' ? body.settings : null;
      return { settingsCiphertext, settingsVersion };
    }),
    decryptCiphertext: params.deps?.decryptCiphertext ?? (async ({ credentials, ciphertext }) => {
      return decryptAccountSettingsCiphertext({ credentials, ciphertext });
    }),
    applySideEffects: params.deps?.applySideEffects ?? (({ settings, agentId, source, settingsVersion, loadedAtMs }) => {
      setActiveAccountSettingsSnapshot({ source, settings, settingsVersion, loadedAtMs });
      if (agentId) {
        assertBackendEnabledByAccountSettings({ agentId, settings });
        applyProviderSpawnExtrasToProcessEnv({ agentId, settings });
      }
      applyAccountSettingsToProcessEnv({ settings });
    }),
  };

  const cachePath = deps.resolveCachePath();
  const scopeKey = `${cachePath}::${tokenScopeKey(params.credentials.token)}`;

  const modeFromEnv = readAccountSettingsModeFromEnv();
  if (modeFromEnv === 'never') {
    const settings = accountSettingsParse({});
    const ctx: AccountSettingsContext = { source: 'none', settings, settingsVersion: 0, loadedAtMs: nowMs, whenRefreshed: null };
    deps.applySideEffects({ settings, agentId: params.agentId, source: 'none', settingsVersion: 0, loadedAtMs: nowMs });
    inMemoryByScopeKey.set(scopeKey, ctx);
    return ctx;
  }

  const existing = inMemoryByScopeKey.get(scopeKey) ?? null;
  if (refresh === 'auto' && existing && shouldTreatCacheAsFresh({ version: 1, cachedAt: existing.loadedAtMs, settingsCiphertext: null, settingsVersion: existing.settingsVersion }, nowMs, ttlMs)) {
    return existing;
  }

  const cache = await deps.readCache(cachePath);

  const parseFromCiphertext = async (ciphertext: string | null): Promise<AccountSettings> => {
    if (!ciphertext) return accountSettingsParse({});
    const decrypted = await deps.decryptCiphertext({ credentials: params.credentials, ciphertext });
    return accountSettingsParse(decrypted ?? {});
  };

  const useCache = async (): Promise<AccountSettingsContext> => {
    const settings = await parseFromCiphertext(cache?.settingsCiphertext ?? null);
    const settingsVersion = cache?.settingsVersion ?? 0;
    const ctx: AccountSettingsContext = { source: cache ? 'cache' : 'none', settings, settingsVersion, loadedAtMs: nowMs, whenRefreshed: null };
    deps.applySideEffects({ settings, agentId: params.agentId, source: ctx.source, settingsVersion, loadedAtMs: nowMs });
    inMemoryByScopeKey.set(scopeKey, ctx);
    return ctx;
  };

  const fetchAndPersist = async (): Promise<AccountSettingsContext> => {
    const { settingsCiphertext, settingsVersion } = await deps.fetchFromServer({ credentials: params.credentials });
    const settings = await parseFromCiphertext(settingsCiphertext);
    try {
      await deps.writeCache(cachePath, {
        version: 1,
        cachedAt: nowMs,
        settingsCiphertext,
        settingsVersion,
      });
    } catch (err) {
      logger.debug('[accountSettings] cache write failed; continuing without persistence', serializeAxiosErrorForLog(err));
    }
    const ctx: AccountSettingsContext = { source: 'network', settings, settingsVersion, loadedAtMs: nowMs, whenRefreshed: null };
    deps.applySideEffects({ settings, agentId: params.agentId, source: 'network', settingsVersion, loadedAtMs: nowMs });
    inMemoryByScopeKey.set(scopeKey, ctx);
    return ctx;
  };

  const cacheFresh = cache ? shouldTreatCacheAsFresh(cache, nowMs, ttlMs) : false;
  const shouldForceFetch = refresh === 'force';

  if (mode === 'fast') {
    const base = await useCache();
    const needsRefresh = shouldForceFetch || !cacheFresh;
    if (!needsRefresh) return base;

    // Fire refresh immediately; expose promise for long-running processes.
    const whenRefreshed = fetchAndPersist().catch(async (err) => {
      logger.debug('[accountSettings] background refresh failed; using cache', serializeAxiosErrorForLog(err));
      return base;
    });
    return { ...base, whenRefreshed };
  }

  // blocking mode
  if (!shouldForceFetch && cacheFresh) {
    return useCache();
  }

  try {
    return await fetchAndPersist();
  } catch (err) {
    logger.debug('[accountSettings] fetch failed; falling back to cache', serializeAxiosErrorForLog(err));
    return useCache();
  }
}
