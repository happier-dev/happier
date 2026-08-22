import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';

import type { AgentId } from '@happier-dev/agents';
import {
  accountSettingsParse,
  AccountSettingsV2GetResponseSchema,
  normalizeCodexBackendMode,
  type AccountSettings,
  type AccountSettingsV2GetResponse,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { Credentials, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { decryptAccountSettingsCiphertext } from '@/settings/accountSettingsClient';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';
import { applyAccountSettingsToProcessEnv } from '@/settings/applyAccountSettingsToProcessEnv';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';

import {
  type AccountSettingsCache,
  type AccountSettingsCacheV1,
  type AccountSettingsCacheWriteOptions,
  type AccountSettingsContentEnvelope,
  readAccountSettingsCache,
  resolveAccountSettingsCachePath,
  writeAccountSettingsCacheAtomic,
} from './accountSettingsCache';
import {
  commitActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests,
} from './activeAccountSettingsSnapshot';
import { resolveAccountSettingsHttpBaseUrl } from './resolveAccountSettingsHttpBaseUrl';
import { AccountSettingsStaleError } from './accountSettingsRefreshError';
import {
  isAccountSettingsVersionAtLeast,
  normalizeAccountSettingsVersionHint,
} from './accountSettingsVersion';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';
import {
  isAccountSettingsEncryptionMaterialUnavailableError,
  requireAccountSettingsEncryptionCredentials,
} from './accountSettingsEncryptionMaterial';

export type AccountSettingsBootstrapMode = 'blocking' | 'fast';
export type AccountSettingsRefreshMode = 'auto' | 'force';

export type AccountSettingsContext = Readonly<{
  source: 'network' | 'cache' | 'none';
  settings: AccountSettings;
  rawSettings?: Readonly<Record<string, unknown>>;
  settingsVersion: number;
  loadedAtMs: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
  scopeKey?: string;
  whenRefreshed: Promise<AccountSettingsContext> | null;
}>;

type ApplyAccountSettingsV2UpdateDeps = Readonly<{
  resolveCachePath: (credentials: StoredCredentials) => string;
  decryptCiphertext: (args: { credentials: Credentials; ciphertext: string }) => Promise<Record<string, unknown> | null>;
}>;

type AccountSettingsLiveApplyError = Error & Readonly<{
  code: 'ACCOUNT_SETTINGS_DECRYPT_FAILED' | 'ACCOUNT_SETTINGS_SCOPE_CHANGED' | 'ACCOUNT_SETTINGS_SOURCE_STALE';
}>;

function createAccountSettingsLiveApplyError(
  code: AccountSettingsLiveApplyError['code'],
  message: string,
): AccountSettingsLiveApplyError {
  return Object.assign(new Error(message), { code });
}

function isAccountSettingsContentUnavailableError(error: unknown): boolean {
  if (isAccountSettingsEncryptionMaterialUnavailableError(error)) return true;
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ACCOUNT_SETTINGS_DECRYPT_FAILED'
    || error.code === 'ACCOUNT_SETTINGS_SCOPE_CHANGED'
    || error.code === 'ACCOUNT_SETTINGS_SOURCE_STALE';
}

function contextFromActiveSnapshot(active: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>): AccountSettingsContext {
  return {
    ...active,
    whenRefreshed: null,
  };
}

function readRawAccountSettingsObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

class AccountSettingsV2RequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Failed to fetch /v2/account/settings (${status})`);
    this.status = status;
  }
}

async function requestAccountSettingsV2(credentials: StoredCredentials): Promise<AccountSettingsV2GetResponse> {
  const response = await axios.get(`${resolveAccountSettingsHttpBaseUrl()}/v2/account/settings`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new AccountSettingsV2RequestError(response.status);
  }
  return AccountSettingsV2GetResponseSchema.parse(response.data);
}

function resolveLiveApplyDisposition(params: Readonly<{
  active: ReturnType<typeof getActiveAccountSettingsSnapshot>;
  activeAtStart: ReturnType<typeof getActiveAccountSettingsSnapshot>;
  activeLifetimeToken: number;
  activeLifetimeTokenAtStart: number;
  scopeKey: string;
  settingsVersion: number;
}>): AccountSettingsContext | null {
  const {
    active,
    activeAtStart,
    activeLifetimeToken,
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion,
  } = params;
  if (activeLifetimeToken !== activeLifetimeTokenAtStart) {
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      'The active account lifetime changed before the live settings update could be applied.',
    );
  }
  if (!active) return null;
  if (active.scopeKey && active.scopeKey !== scopeKey) {
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      'The active account changed before the live settings update could be applied.',
    );
  }
  if (!active.scopeKey && active !== activeAtStart) {
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      'The unscoped active account settings snapshot changed before the live update could be applied.',
    );
  }
  if (active.scopeKey === scopeKey && active.settingsVersion >= settingsVersion) {
    return contextFromActiveSnapshot(active);
  }
  return null;
}

function migrateAccountSettingsForCodexAppServerDefault(settings: AccountSettings): AccountSettings {
  const schemaVersion = settings.schemaVersion;
  if (!Number.isFinite(schemaVersion) || schemaVersion >= 6) return settings;
  const existingCodexBackendMode = normalizeCodexBackendMode(settings.codexBackendMode);
  return {
    ...settings,
    schemaVersion: 6,
    codexBackendMode: existingCodexBackendMode ?? 'appServer',
  };
}

/**
 * Apply an authoritative user-scoped settings projection to this process.
 * Live updates intentionally do not write the durable cache; bootstrap remains its sole owner.
 */
export async function applyAccountSettingsV2Update(params: Readonly<{
  credentials: StoredCredentials;
  update: AccountSettingsV2GetResponse;
  shouldCommit?: () => boolean;
  nowMs?: number;
  deps?: Partial<ApplyAccountSettingsV2UpdateDeps>;
}>): Promise<AccountSettingsContext> {
  const nowMs = params.nowMs ?? Date.now();
  const resolveCachePath = params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath;
  const decryptCiphertext = params.deps?.decryptCiphertext ?? (async ({ credentials, ciphertext }) => (
    decryptAccountSettingsCiphertext({ credentials, ciphertext })
  ));
  const cachePath = resolveCachePath(params.credentials);
  const scopeKey = createAccountSettingsScopeKey({ cachePath, token: params.credentials.token });
  const activeAtStart = getActiveAccountSettingsSnapshot();
  const activeLifetimeTokenAtStart = getActiveAccountSettingsSnapshotLifetimeToken();
  const reusableAtStart = resolveLiveApplyDisposition({
    active: activeAtStart,
    activeAtStart,
    activeLifetimeToken: activeLifetimeTokenAtStart,
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion: params.update.version,
  });
  if (reusableAtStart) return reusableAtStart;

  const content = params.update.content;
  let rawSettings: unknown = null;
  if (content?.t === 'plain') {
    rawSettings = content.v;
  } else if (content?.t === 'encrypted') {
    const encryptionCredentials = requireAccountSettingsEncryptionCredentials(params.credentials);
    rawSettings = await decryptCiphertext({
      credentials: encryptionCredentials,
      ciphertext: content.c,
    });
    if (!rawSettings) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_DECRYPT_FAILED',
        'The live account settings payload could not be decrypted.',
      );
    }
  }
  const settings = migrateAccountSettingsForCodexAppServerDefault(accountSettingsParse(rawSettings ?? {}));

  if (params.shouldCommit && !params.shouldCommit()) {
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SOURCE_STALE',
      'The live account settings source closed before the update could be committed.',
    );
  }
  const reusableBeforeCommit = resolveLiveApplyDisposition({
    active: getActiveAccountSettingsSnapshot(),
    activeAtStart,
    activeLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion: params.update.version,
  });
  if (reusableBeforeCommit) return reusableBeforeCommit;

  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  const committed = commitActiveAccountSettingsSnapshot({
    source: 'network',
    settings,
    rawSettings: readRawAccountSettingsObject(rawSettings),
    settingsVersion: params.update.version,
    loadedAtMs: nowMs,
    settingsSecretsReadKeys,
    scopeKey,
  });
  const committedContext = contextFromActiveSnapshot(committed.snapshot);
  if (!committed.didCommit) return committedContext;

  const committedLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  if (
    getActiveAccountSettingsSnapshot() !== committed.snapshot
    || getActiveAccountSettingsSnapshotLifetimeToken() !== committedLifetimeToken
  ) {
    const active = getActiveAccountSettingsSnapshot();
    if (active?.scopeKey === scopeKey) return contextFromActiveSnapshot(active);
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      'The active account changed before the live settings update side effects could be applied.',
    );
  }
  applyAccountSettingsToProcessEnv({ settings: committed.snapshot.settings });
  if (
    getActiveAccountSettingsSnapshot() === committed.snapshot
    && getActiveAccountSettingsSnapshotLifetimeToken() === committedLifetimeToken
  ) {
    rememberInMemoryAccountSettingsContext(
      scopeKey,
      committedContext,
      committedLifetimeToken,
      committed.snapshot,
    );
    return committedContext;
  }
  const active = getActiveAccountSettingsSnapshot();
  if (active?.scopeKey === scopeKey) return contextFromActiveSnapshot(active);
  throw createAccountSettingsLiveApplyError(
    'ACCOUNT_SETTINGS_SCOPE_CHANGED',
    'The active account changed while the live settings update side effects were applied.',
  );
}

/** Request-only convergence for a live session; no durable cache reads or writes. */
export async function refreshActiveAccountSettingsFromServer(params: Readonly<{
  credentials: StoredCredentials;
  minSettingsVersion?: number | null;
  shouldCommit?: () => boolean;
  nowMs?: number;
}>): Promise<AccountSettingsContext> {
  const update = await requestAccountSettingsV2(params.credentials);
  const minimum = normalizeAccountSettingsVersionHint(params.minSettingsVersion);
  if (!shouldTreatVersionAsFresh(update.version, minimum)) {
    throw new AccountSettingsStaleError();
  }
  return applyAccountSettingsV2Update({
    credentials: params.credentials,
    update,
    shouldCommit: params.shouldCommit,
    nowMs: params.nowMs,
  });
}

type BootstrapDeps = Readonly<{
  resolveCachePath: (credentials: StoredCredentials) => string;
  readCache: (path: string) => Promise<AccountSettingsCache | null>;
  writeCache: (
    path: string,
    cache: AccountSettingsCache,
    options?: AccountSettingsCacheWriteOptions,
  ) => Promise<void>;
  fetchFromServer: (args: { credentials: StoredCredentials }) => Promise<
    | { settingsCiphertext: string | null; settingsVersion: number }
    | { settingsContent: AccountSettingsContentEnvelope | null; settingsVersion: number }
  >;
  decryptCiphertext: (args: { credentials: Credentials; ciphertext: string }) => Promise<Record<string, unknown> | null>;
  applySideEffects: (args: {
    settings: AccountSettings;
    agentId?: AgentId;
    backendTarget?: BackendTargetRefV1;
    source: AccountSettingsContext['source'];
    settingsVersion: number;
    loadedAtMs: number;
  }) => void;
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

function shouldTreatCacheAsFresh(cache: AccountSettingsCache, nowMs: number, ttlMs: number): boolean {
  if (ttlMs <= 0) return false;
  const age = nowMs - cache.cachedAt;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

function shouldTreatVersionAsFresh(current: number | null | undefined, minimum: number | null): boolean {
  return isAccountSettingsVersionAtLeast(current, minimum);
}

type InMemoryAccountSettingsContext = Readonly<{
  context: AccountSettingsContext;
  lifetimeToken: number;
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
}>;

const inMemoryByScopeKey = new Map<string, InMemoryAccountSettingsContext>();

function activeSnapshotPublicationIsCurrent(params: Readonly<{
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
  lifetimeToken: number;
}>): boolean {
  return getActiveAccountSettingsSnapshot() === params.snapshot
    && getActiveAccountSettingsSnapshotLifetimeToken() === params.lifetimeToken;
}

function rememberInMemoryAccountSettingsContext(
  scopeKey: string,
  context: AccountSettingsContext,
  lifetimeToken: number,
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>,
): void {
  inMemoryByScopeKey.set(scopeKey, Object.freeze({ context, lifetimeToken, snapshot }));
}

export function resetInMemoryAccountSettingsContextForTests(): void {
  inMemoryByScopeKey.clear();
  resetActiveAccountSettingsSnapshotForTests();
}

export async function bootstrapAccountSettingsContext(params: Readonly<{
  credentials: StoredCredentials;
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  mode?: AccountSettingsBootstrapMode;
  refresh?: AccountSettingsRefreshMode;
  /**
   * When false, ignore `HAPPIER_ACCOUNT_SETTINGS_MODE` (defense-in-depth for
   * security-sensitive surfaces like external MCP, where the spawning client
   * may control process env).
   */
  honorAccountSettingsModeEnv?: boolean;
  minSettingsVersion?: number;
  /**
   * Live callers may retain a narrower Account incumbent while a refresh is
   * in flight. The canonical publication owner checks this immediately before
   * every active-snapshot commit.
   */
  shouldCommit?: () => boolean;
  nowMs?: number;
  ttlMs?: number;
  deps?: Partial<BootstrapDeps>;
}>): Promise<AccountSettingsContext> {
  const nowMs = typeof params.nowMs === 'number' ? params.nowMs : Date.now();
  const ttlMs = typeof params.ttlMs === 'number' ? params.ttlMs : readTtlMsFromEnvOrDefault();
  const refresh = params.refresh ?? 'auto';
  const mode = params.mode ?? 'blocking';
  const minSettingsVersion = normalizeAccountSettingsVersionHint(params.minSettingsVersion);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);

  const deps: BootstrapDeps = {
    resolveCachePath: params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath,
    readCache: params.deps?.readCache ?? readAccountSettingsCache,
    writeCache: params.deps?.writeCache ?? writeAccountSettingsCacheAtomic,
    fetchFromServer: params.deps?.fetchFromServer ?? (async ({ credentials }) => {
      try {
        const update = await requestAccountSettingsV2(credentials);
        return { settingsContent: update.content, settingsVersion: update.version };
      } catch (err) {
        if (!(err instanceof AccountSettingsV2RequestError) || err.status !== 404) throw err;
        const response = await axios.get(`${resolveAccountSettingsHttpBaseUrl()}/v1/account/settings`, {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
      }
    }),
    decryptCiphertext: params.deps?.decryptCiphertext ?? (async ({ credentials, ciphertext }) => {
      return decryptAccountSettingsCiphertext({ credentials, ciphertext });
    }),
    applySideEffects: params.deps?.applySideEffects ?? (({ settings, agentId, backendTarget }) => {
      if (agentId || backendTarget) {
        assertBackendEnabledByAccountSettings({ agentId, backendTarget, settings });
      }
      applyAccountSettingsToProcessEnv({ settings });
    }),
  };

  const cachePath = deps.resolveCachePath(params.credentials);
  const scopeKey = createAccountSettingsScopeKey({ cachePath, token: params.credentials.token });
  const activeAtBootstrapStart = getActiveAccountSettingsSnapshot();
  const activeLifetimeTokenAtBootstrapStart = getActiveAccountSettingsSnapshotLifetimeToken();
  type PublishedAccountSettingsContext = Readonly<{
    context: AccountSettingsContext;
    didCommit: boolean;
    snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
    lifetimeToken: number;
  }>;
  const currentPublicationForScope = (): PublishedAccountSettingsContext | null => {
    const active = getActiveAccountSettingsSnapshot();
    if (!active || active.scopeKey !== scopeKey) return null;
    return {
      context: contextFromActiveSnapshot(active),
      didCommit: false,
      snapshot: active,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    };
  };
  const applyPublicationSideEffects = (
    publication: PublishedAccountSettingsContext,
  ): PublishedAccountSettingsContext => {
    if (!activeSnapshotPublicationIsCurrent(publication)) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SCOPE_CHANGED',
        'The active account changed before Settings bootstrap side effects could be applied.',
      );
    }
    deps.applySideEffects({
      settings: publication.context.settings,
      agentId: params.agentId,
      backendTarget: params.backendTarget,
      source: publication.context.source,
      settingsVersion: publication.context.settingsVersion,
      loadedAtMs: publication.context.loadedAtMs,
    });
    if (!activeSnapshotPublicationIsCurrent(publication)) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SCOPE_CHANGED',
        'The active account changed while Settings bootstrap side effects were applied.',
      );
    }
    rememberInMemoryAccountSettingsContext(
      scopeKey,
      publication.context,
      publication.lifetimeToken,
      publication.snapshot,
    );
    return publication;
  };
  const publishContext = (candidate: AccountSettingsContext): Readonly<{
    context: AccountSettingsContext;
    didCommit: boolean;
    snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
    lifetimeToken: number;
  }> => {
    if (params.shouldCommit?.() === false) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SOURCE_STALE',
        'The Account Settings publication lifetime ended before Settings bootstrap could be committed.',
      );
    }
    if (getActiveAccountSettingsSnapshotLifetimeToken() !== activeLifetimeTokenAtBootstrapStart) {
      const currentPublication = currentPublicationForScope();
      if (!currentPublication) {
        throw createAccountSettingsLiveApplyError(
          'ACCOUNT_SETTINGS_SCOPE_CHANGED',
          'The active account lifetime changed before Settings bootstrap could be committed.',
        );
      }
      if (!shouldTreatVersionAsFresh(currentPublication.context.settingsVersion, minSettingsVersion)) {
        throw new AccountSettingsStaleError();
      }
      return applyPublicationSideEffects(currentPublication);
    }
    const activeBeforeCommit = getActiveAccountSettingsSnapshot();
    if (
      activeBeforeCommit !== activeAtBootstrapStart
      && activeBeforeCommit?.scopeKey !== scopeKey
    ) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SCOPE_CHANGED',
        'The active account changed before Settings bootstrap could be committed.',
      );
    }
    const committed = commitActiveAccountSettingsSnapshot({
      source: candidate.source,
      settings: candidate.settings,
      ...(candidate.rawSettings ? { rawSettings: candidate.rawSettings } : {}),
      settingsVersion: candidate.settingsVersion,
      loadedAtMs: candidate.loadedAtMs,
      settingsSecretsReadKeys: candidate.settingsSecretsReadKeys,
      scopeKey,
    });
    const context = contextFromActiveSnapshot(committed.snapshot);
    if (!shouldTreatVersionAsFresh(context.settingsVersion, minSettingsVersion)) {
      throw new AccountSettingsStaleError();
    }
    return applyPublicationSideEffects({
      context,
      didCommit: committed.didCommit,
      snapshot: committed.snapshot,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    });
  };

  const honorModeEnv = params.honorAccountSettingsModeEnv !== false;
  const modeFromEnv = honorModeEnv ? readAccountSettingsModeFromEnv() : 'auto';
  if (modeFromEnv === 'never') {
    if (minSettingsVersion !== null && minSettingsVersion > 0) {
      throw new AccountSettingsStaleError();
    }
    const settings = accountSettingsParse({});
    const ctx: AccountSettingsContext = {
      source: 'none',
      settings,
      rawSettings: {},
      settingsVersion: 0,
      loadedAtMs: nowMs,
      settingsSecretsReadKeys,
      whenRefreshed: null,
    };
    return publishContext(ctx).context;
  }

  const active = getActiveAccountSettingsSnapshot();
  const activeLifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
  const inMemory = inMemoryByScopeKey.get(scopeKey);
  const existing = active?.scopeKey === scopeKey
    ? (
      inMemory?.snapshot === active && inMemory.lifetimeToken === activeLifetimeToken
        ? inMemory.context
        : contextFromActiveSnapshot(active)
    )
    : null;
  if (
    refresh === 'auto'
    && existing
    && shouldTreatCacheAsFresh({ version: 2, cachedAt: existing.loadedAtMs, settingsContent: null, settingsVersion: existing.settingsVersion }, nowMs, ttlMs)
    && shouldTreatVersionAsFresh(existing.settingsVersion, minSettingsVersion)
  ) {
    const currentPublication = currentPublicationForScope();
    if (!currentPublication) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SCOPE_CHANGED',
        'The active account changed before fresh Settings could be reused.',
      );
    }
    return applyPublicationSideEffects(currentPublication).context;
  }

  const readCache = await deps.readCache(cachePath);
  const cache =
    readCache?.version === 2 && readCache.settingsContent?.t === 'plain'
      ? null
      : readCache;

  const parseFromContent = async (content: AccountSettingsContentEnvelope | null): Promise<Readonly<{
    rawSettings: Readonly<Record<string, unknown>>;
    settings: AccountSettings;
  }>> => {
    if (!content) {
      return {
        rawSettings: {},
        settings: migrateAccountSettingsForCodexAppServerDefault(accountSettingsParse({})),
      };
    }
    if (content.t === 'plain') {
      const rawSettings = readRawAccountSettingsObject(content.v);
      return {
        rawSettings,
        settings: migrateAccountSettingsForCodexAppServerDefault(accountSettingsParse(rawSettings)),
      };
    }
    const ciphertext = typeof content.c === 'string' ? content.c : '';
    const encryptionCredentials = requireAccountSettingsEncryptionCredentials(params.credentials);
    const decrypted = await deps.decryptCiphertext({ credentials: encryptionCredentials, ciphertext });
    if (!decrypted) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_DECRYPT_FAILED',
        'The account settings payload could not be decrypted.',
      );
    }
    return {
      rawSettings: decrypted,
      settings: migrateAccountSettingsForCodexAppServerDefault(accountSettingsParse(decrypted)),
    };
  };

  const cacheContent: AccountSettingsContentEnvelope | null =
    cache && (cache as any).version === 2
      ? ((cache as any).settingsContent ?? null)
      : (cache && (cache as any).settingsCiphertext
        ? { t: 'encrypted', c: (cache as any).settingsCiphertext as string }
        : null);

  const useCache = async (): Promise<AccountSettingsContext> => {
    const parsed = await parseFromContent(cacheContent);
    const settingsVersion = cache?.settingsVersion ?? 0;
    const ctx: AccountSettingsContext = {
      source: cache ? 'cache' : 'none',
      settings: parsed.settings,
      rawSettings: parsed.rawSettings,
      settingsVersion,
      loadedAtMs: nowMs,
      settingsSecretsReadKeys,
      whenRefreshed: null,
    };
    return publishContext(ctx).context;
  };

  const fetchAndPersist = async (): Promise<AccountSettingsContext> => {
    const fetched = await deps.fetchFromServer({ credentials: params.credentials }) as any;
    const settingsVersion = typeof fetched.settingsVersion === 'number' ? fetched.settingsVersion : 0;
    const settingsContent: AccountSettingsContentEnvelope | null =
      'settingsContent' in fetched
        ? (fetched.settingsContent ?? null)
        : (fetched.settingsCiphertext ? { t: 'encrypted', c: fetched.settingsCiphertext } : null);
    const parsed = await parseFromContent(settingsContent);
    const candidate: AccountSettingsContext = {
      source: 'network',
      settings: parsed.settings,
      rawSettings: parsed.rawSettings,
      settingsVersion,
      loadedAtMs: nowMs,
      settingsSecretsReadKeys,
      whenRefreshed: null,
    };
    if (!shouldTreatVersionAsFresh(candidate.settingsVersion, minSettingsVersion)) {
      throw new AccountSettingsStaleError();
    }
    const publication = publishContext(candidate);
    if (!publication.didCommit) return publication.context;

    if (settingsContent?.t !== 'plain') {
      try {
        await deps.writeCache(cachePath, {
          version: 2,
          cachedAt: nowMs,
          settingsContent,
          settingsVersion,
        }, {
          shouldCommit: () => params.shouldCommit?.() !== false
            && activeSnapshotPublicationIsCurrent(publication),
        });
      } catch (err) {
        logger.debug('[accountSettings] cache write failed; continuing without persistence', serializeAxiosErrorForLog(err));
      }
    }
    const activeAfterWrite = getActiveAccountSettingsSnapshot();
    if (activeAfterWrite?.scopeKey === scopeKey) {
      return contextFromActiveSnapshot(activeAfterWrite);
    }
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SCOPE_CHANGED',
      'The active account changed while Settings bootstrap was writing its cache.',
    );
  };

  const cacheFresh = cache
    ? shouldTreatCacheAsFresh(cache, nowMs, ttlMs) && shouldTreatVersionAsFresh(cache.settingsVersion, minSettingsVersion)
    : false;
  const shouldForceFetch = refresh === 'force';
  const effectiveMode = minSettingsVersion !== null ? 'blocking' : mode;

  if (effectiveMode === 'fast') {
    const base = await useCache();
    const needsRefresh = shouldForceFetch || !cacheFresh;
    if (!needsRefresh) return base;

    // Fire refresh immediately; expose promise for long-running processes.
    const whenRefreshed = fetchAndPersist().catch(async (err) => {
      if (minSettingsVersion !== null || isAccountSettingsContentUnavailableError(err)) {
        throw err;
      }
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
    if (minSettingsVersion !== null || isAccountSettingsContentUnavailableError(err)) {
      throw err;
    }
    logger.debug('[accountSettings] fetch failed; falling back to cache', serializeAxiosErrorForLog(err));
    return useCache();
  }
}
