import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import { HttpStatusError } from '@/api/client/httpStatusError';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { waitForAccountEncryptionObservation } from '@happier-dev/sync-client';

import type { AgentId } from '@happier-dev/agents';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import type { AccountSettings, AccountSettingsV2GetResponse, BackendTargetRefV1 } from '@happier-dev/protocol';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import type { PromptLibraryCatalogSnapshotV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { RemoteHostCatalogSnapshotV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { ConnectedPresentationCatalogSnapshotV1, ConnectedAcknowledgementsCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import type { Credentials, StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { decryptAccountSettingsCiphertext } from '@/settings/accountSettingsClient';
import { assertBackendEnabledByAccountSettings } from '@/settings/backendEnabled';
import { applyAccountSettingsToProcessEnv } from '@/settings/applyAccountSettingsToProcessEnv';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import type {
  SavedSecretCatalogResourceInputV1,
  SavedSecretCatalogState,
} from '@/settings/secrets/savedSecretCatalog';

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
  type ActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';
import { resolveAccountSettingsHttpBaseUrl } from './resolveAccountSettingsHttpBaseUrl';
import { AccountSettingsContentInvalidError, AccountSettingsStaleError, isAccountSettingsContentInvalidError } from './accountSettingsRefreshError';
import {
  assertAccountEncryptionModeAllowedByEffectiveClientRequirement,
  isClientE2eeRequiredError,
} from './resolveEffectiveClientEncryptionRequirement';
import {
  isAccountSettingsVersionAtLeast,
  normalizeAccountSettingsVersionHint,
} from './accountSettingsVersion';
import { createAccountSettingsScopeKey } from './accountSettingsScopeKey';
import { ACCOUNT_SETTINGS_REQUEST_TIMEOUT_MS } from './accountSettingsRequestTimeout';
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
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: SavedSecretCatalogState;
  profileCatalog?: ProfileCatalogSnapshotV1;
  providerConnectionsCatalog?: ProviderConnectionsCatalogSnapshotV1;
  promptLibraryCatalog?: PromptLibraryCatalogSnapshotV1;
  acpCatalog?: AcpCatalogSnapshotV1;
  mcpServerCatalog?: McpServerCatalogSnapshotV1;
  connectedConfigurationCatalog?: ConnectedAccountCatalogSnapshotV1;
  connectedPurposeCatalog?: ConnectedAccountCatalogSnapshotV1;
  remoteHostCatalog?: RemoteHostCatalogSnapshotV1;
  notificationChannelCatalog?: NotificationChannelCatalogSnapshotV1;
  connectedPresentationCatalog?: ConnectedPresentationCatalogSnapshotV1;
  connectedAcknowledgementsCatalog?: ConnectedAcknowledgementsCatalogSnapshotV1;
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

function createAccountSettingsScopeChangedError(
  branch: 'live_lifetime_before_commit' | 'live_scope_before_commit' | 'live_unscoped_before_commit'
    | 'live_side_effects_before' | 'live_side_effects_after'
    | 'bootstrap_side_effects_before' | 'bootstrap_side_effects_after'
    | 'bootstrap_lifetime_before_commit' | 'bootstrap_scope_before_commit'
    | 'bootstrap_reuse' | 'bootstrap_cache_write',
  message: string,
) {
  logger.infoFile('[accountSettings] Scope refused', { branch });
  return Object.assign(createAccountSettingsLiveApplyError('ACCOUNT_SETTINGS_SCOPE_CHANGED', message), { branch });
}

function isAccountSettingsContentUnavailableError(error: unknown): boolean {
  if (isAccountSettingsEncryptionMaterialUnavailableError(error) || isAccountSettingsContentInvalidError(error)) return true;
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

// Schema rejection is a data refusal, independent of network/cache fallback policy.
function parseBootstrapAccountSettings(raw: unknown): AccountSettings {
  try {
    return accountSettingsParse(raw);
  } catch (error) {
    throw new AccountSettingsContentInvalidError(error);
  }
}

function readRawAccountSettingsObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

class AccountSettingsV2RequestError extends HttpStatusError {
  readonly status: number;

  constructor(status: number) {
    super(status, `Failed to fetch /v2/account/settings (${status})`);
    this.status = status;
  }
}

async function requestAccountSettingsV2(
  credentials: StoredCredentials,
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET';
    path: string;
  }>) => Readonly<Record<string, string>> | null,
  signal?: AbortSignal,
): Promise<AccountSettingsV2GetResponse> {
  const path = '/v2/account/settings';
  const authorizationHeaders = resolveAuthorizationHeaders?.({ method: 'GET', path })
    ?? (resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${credentials.token}` });
  if (!authorizationHeaders) throw new Error('External Action authorization unavailable');
  const response = await axios.get(`${resolveAccountSettingsHttpBaseUrl()}/v2/account/settings`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      ...authorizationHeaders,
      'Content-Type': 'application/json',
    },
    signal,
    timeout: ACCOUNT_SETTINGS_REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new AccountSettingsV2RequestError(response.status);
  }
  try {
    return AccountSettingsV2GetResponseSchema.parse(response.data);
  } catch (error) {
    throw new AccountSettingsContentInvalidError(error);
  }
}

function settingsKeyMaterialChangedDuringRead(
  activeAtStart: ActiveAccountSettingsSnapshot | null,
  active: ActiveAccountSettingsSnapshot | null,
  settingsSecretsReadKeys: readonly Uint8Array[],
): boolean {
  return active !== null && active !== activeAtStart
    && (!activeAtStart || !isDeepStrictEqual(activeAtStart.settingsSecretsReadKeys, active.settingsSecretsReadKeys))
    && !isDeepStrictEqual(active.settingsSecretsReadKeys, settingsSecretsReadKeys);
}

function isFirstSameScopePublication(params: Readonly<{
  activeAtStart: ActiveAccountSettingsSnapshot | null;
  active: ActiveAccountSettingsSnapshot | null;
  activeLifetimeTokenAtStart: number;
  activeLifetimeToken: number;
  scopeKey: string;
  settingsSecretsReadKeys: readonly Uint8Array[];
}>): boolean {
  // One entry from an empty incumbent is not retirement. A clear, different
  // Account entry or key retirement advances the existing token further.
  return params.activeAtStart === null
    && params.activeLifetimeToken === params.activeLifetimeTokenAtStart + 1
    && params.active?.scopeKey === params.scopeKey
    && isDeepStrictEqual(params.active.settingsSecretsReadKeys, params.settingsSecretsReadKeys);
}

function resolveLiveApplyDisposition(params: Readonly<{
  active: ReturnType<typeof getActiveAccountSettingsSnapshot>;
  activeAtStart: ReturnType<typeof getActiveAccountSettingsSnapshot>;
  activeLifetimeToken: number;
  activeLifetimeTokenAtStart: number;
  scopeKey: string;
  settingsVersion: number;
  settingsSecretsReadKeys: readonly Uint8Array[];
}>): AccountSettingsContext | null {
  const {
    active,
    activeAtStart,
    activeLifetimeToken,
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion,
  } = params;
  if (activeLifetimeToken !== activeLifetimeTokenAtStart && !isFirstSameScopePublication(params)) {
    throw createAccountSettingsScopeChangedError(
      'live_lifetime_before_commit',
      'The active account lifetime changed before the live settings update could be applied.',
    );
  }
  if (!active) return null;
  const incompatibleIncumbent = active.scopeKey === scopeKey && active.settingsVersion >= settingsVersion
    && !isDeepStrictEqual(active.settingsSecretsReadKeys, params.settingsSecretsReadKeys);
  if ((active.scopeKey && active.scopeKey !== scopeKey)
    || settingsKeyMaterialChangedDuringRead(activeAtStart, active, params.settingsSecretsReadKeys)
    || incompatibleIncumbent) {
    throw createAccountSettingsScopeChangedError(
      'live_scope_before_commit',
      'The active account changed before the live settings update could be applied.',
    );
  }
  if (!active.scopeKey && active !== activeAtStart) {
    throw createAccountSettingsScopeChangedError(
      'live_unscoped_before_commit',
      'The unscoped active account settings snapshot changed before the live update could be applied.',
    );
  }
  if (active.scopeKey === scopeKey && active.settingsVersion >= settingsVersion) {
    return contextFromActiveSnapshot(active);
  }
  return null;
}

/**
 * Apply an authoritative user-scoped settings projection to this process.
 * Live updates intentionally do not write the durable cache; bootstrap remains its sole owner.
 */
export async function applyAccountSettingsV2Update(params: Readonly<{
  credentials: StoredCredentials;
  update: AccountSettingsV2GetResponse;
  publication?: 'active' | 'invocation';
  expectedAccountEncryptionMode?: 'plain' | 'e2ee';
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
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  const reusableAtStart = params.publication === 'invocation' ? null : resolveLiveApplyDisposition({
    active: activeAtStart,
    activeAtStart,
    activeLifetimeToken: activeLifetimeTokenAtStart,
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion: params.update.version,
    settingsSecretsReadKeys,
  });
  if (reusableAtStart) return reusableAtStart;

  const content = params.update.content;
  if (content && params.expectedAccountEncryptionMode
    && (params.expectedAccountEncryptionMode === 'plain' ? content.t !== 'plain' : content.t !== 'encrypted')) {
    throw new AccountSettingsContentInvalidError(new Error('account_settings_mode_mismatch'));
  }
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
  const settings = accountSettingsParse(rawSettings ?? {});
  if (content?.t === 'plain') {
    assertAccountEncryptionModeAllowedByEffectiveClientRequirement('plain', settings);
  }

  if (params.shouldCommit && !params.shouldCommit()) {
    throw createAccountSettingsLiveApplyError(
      'ACCOUNT_SETTINGS_SOURCE_STALE',
      'The live account settings source closed before the update could be committed.',
    );
  }
  if (params.publication === 'invocation') {
    return { source: 'network', settings, rawSettings: readRawAccountSettingsObject(rawSettings),
      settingsVersion: params.update.version, loadedAtMs: nowMs, scopeKey,
      settingsSecretsReadKeys, whenRefreshed: null };
  }
  const reusableBeforeCommit = resolveLiveApplyDisposition({
    active: getActiveAccountSettingsSnapshot(),
    activeAtStart,
    activeLifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
    activeLifetimeTokenAtStart,
    scopeKey,
    settingsVersion: params.update.version,
    settingsSecretsReadKeys,
  });
  if (reusableBeforeCommit) return reusableBeforeCommit;

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
  const publication = { snapshot: committed.snapshot, lifetimeToken: committedLifetimeToken };
  if (!activeSnapshotPublicationIsCurrent(publication)) {
    const active = getActiveAccountSettingsSnapshot();
    if (active?.scopeKey === scopeKey) return contextFromActiveSnapshot(active);
    throw createAccountSettingsScopeChangedError(
      'live_side_effects_before',
      'The active account changed before the live settings update side effects could be applied.',
    );
  }
  applyAccountSettingsToProcessEnv({ settings: committed.snapshot.settings });
  const active = getActiveAccountSettingsSnapshot();
  if (active && activeSnapshotPublicationIsCurrent(publication)) {
    const context = contextFromActiveSnapshot(active);
    rememberInMemoryAccountSettingsContext(
      scopeKey,
      context,
      committedLifetimeToken,
      active,
    );
    return context;
  }
  if (active?.scopeKey === scopeKey) return contextFromActiveSnapshot(active);
  throw createAccountSettingsScopeChangedError(
    'live_side_effects_after',
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
  fetchFromServer: (args: { credentials: StoredCredentials; signal?: AbortSignal }) => Promise<
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

type RequesterSettingsRead = Readonly<{
  settingsContent: AccountSettingsContentEnvelope | null;
  settingsVersion: number;
  parsed: Readonly<{ rawSettings: Readonly<Record<string, unknown>>; settings: AccountSettings }>;
}>;

// Only outstanding reads live here. Each requester still admits its own
// version floor and publication, with independent cancellation/currentness.
const requesterSettingsReads = new Map<string, {
  pending: Promise<RequesterSettingsRead>;
  controller: AbortController;
  readers: number;
}>();

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
  lifetimeToken: number;
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
  /** Last accepted observation; equal revisions do not republish the snapshot. */
  validatedAtMs: number;
}>;

const inMemoryByScopeKey = new Map<string, InMemoryAccountSettingsContext>();

function sameSettingsPublication(left: ActiveAccountSettingsSnapshot, right: ActiveAccountSettingsSnapshot): boolean {
  // Catalog refreshes replace the aggregate snapshot, not the accepted
  // preference observation. They must not discard its existing freshness.
  return left.scopeKey === right.scopeKey && left.source === right.source
    && left.settingsVersion === right.settingsVersion && left.settings === right.settings
    && left.rawSettings === right.rawSettings && left.settingsSecretsReadKeys === right.settingsSecretsReadKeys;
}

function activeSnapshotPublicationIsCurrent(params: Readonly<{
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>;
  lifetimeToken: number;
}>): boolean {
  const active = getActiveAccountSettingsSnapshot();
  // Catalog subscribers can replace the aggregate synchronously during
  // publication. They do not retire unchanged Settings in this Account lifetime.
  return active !== null && sameSettingsPublication(active, params.snapshot)
    && getActiveAccountSettingsSnapshotLifetimeToken() === params.lifetimeToken;
}

function rememberInMemoryAccountSettingsContext(
  scopeKey: string,
  context: AccountSettingsContext,
  lifetimeToken: number,
  snapshot: NonNullable<ReturnType<typeof getActiveAccountSettingsSnapshot>>,
  validatedAtMs?: number,
): void {
  const previous = inMemoryByScopeKey.get(scopeKey);
  const previousValidation = previous?.lifetimeToken === lifetimeToken && sameSettingsPublication(previous.snapshot, snapshot)
    ? previous.validatedAtMs : context.loadedAtMs;
  inMemoryByScopeKey.set(scopeKey, Object.freeze({ lifetimeToken, snapshot,
    validatedAtMs: Math.max(previousValidation, validatedAtMs ?? context.loadedAtMs) }));
}

export function resetInMemoryAccountSettingsContextForTests(): void {
  inMemoryByScopeKey.clear();
  resetActiveAccountSettingsSnapshotForTests();
}

export async function bootstrapAccountSettingsContext(params: Readonly<{
  credentials: StoredCredentials;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET';
    path: string;
  }>) => Readonly<Record<string, string>> | null;
  agentId?: AgentId;
  backendTarget?: BackendTargetRefV1;
  mode?: AccountSettingsBootstrapMode;
  refresh?: AccountSettingsRefreshMode;
  /** Propagate refresh failures when the caller requires network authority, independently of a known Settings floor. */
  allowCacheFallback?: boolean;
  /** Finite requester admission reads must not retarget the daemon's Account or process defaults. */
  publication?: 'active' | 'invocation';
  caller?: 'requester_session_admission' | 'requester_action_admission' | 'requester_settings_recovery';
  expectedAccountEncryptionMode?: 'plain' | 'e2ee';
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

  // File-only phase facts deliberately exclude Account content, paths and errors.
  const bootstrapId = randomUUID();
  const bootstrapStartedAt = performance.now();
  const beginPhase = (phase: 'cache_read' | 'network_read' | 'content_parse' | 'publication' | 'cache_write') => {
    const startedAt = performance.now();
    const record = (status: 'started' | 'completed' | 'failed') => logger.infoFile('[accountSettings] Bootstrap phase', {
      bootstrapId, caller: params.caller ?? params.publication ?? 'active', phase, status,
      durationMs: Math.round(performance.now() - startedAt),
      elapsedMs: Math.round(performance.now() - bootstrapStartedAt),
    });
    record('started');
    return record;
  };
  const observePhase = async <T>(phase: Parameters<typeof beginPhase>[0], work: () => Promise<T>): Promise<T> => {
    const record = beginPhase(phase);
    try {
      const result = await work();
      record('completed');
      return result;
    } catch (error) {
      record('failed');
      throw error;
    }
  };

  const deps: BootstrapDeps = {
    resolveCachePath: params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath,
    readCache: params.deps?.readCache ?? readAccountSettingsCache,
    writeCache: params.deps?.writeCache ?? writeAccountSettingsCacheAtomic,
    fetchFromServer: params.deps?.fetchFromServer ?? (async ({ credentials, signal }) => {
      try {
        const update = await requestAccountSettingsV2(credentials, params.resolveAuthorizationHeaders, signal);
        return { settingsContent: update.content, settingsVersion: update.version };
      } catch (err) {
        if (!(err instanceof AccountSettingsV2RequestError) || err.status !== 404) throw err;
        const path = '/v1/account/settings';
        const fallbackAuthorizationHeaders = params.resolveAuthorizationHeaders?.({
          method: 'GET',
          path,
        }) ?? (params.resolveAuthorizationHeaders
          ? null
          : { Authorization: `Bearer ${credentials.token}` });
        if (!fallbackAuthorizationHeaders) throw new Error('External Action authorization unavailable');
        const response = await axios.get(`${resolveAccountSettingsHttpBaseUrl()}${path}`, {
          headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            ...fallbackAuthorizationHeaders,
            'Content-Type': 'application/json',
          },
          signal,
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
    if (!active || active.scopeKey !== scopeKey
      || settingsKeyMaterialChangedDuringRead(activeAtBootstrapStart, active, settingsSecretsReadKeys)) return null;
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
      throw createAccountSettingsScopeChangedError(
        'bootstrap_side_effects_before',
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
      throw createAccountSettingsScopeChangedError(
        'bootstrap_side_effects_after',
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
    if (params.publication === 'invocation') {
      if (params.shouldCommit?.() === false) {
        throw createAccountSettingsLiveApplyError('ACCOUNT_SETTINGS_SOURCE_STALE', 'Requester policy admission is no longer current.');
      }
      const context = { ...candidate, scopeKey };
      return { context, didCommit: false, snapshot: context,
        lifetimeToken: activeLifetimeTokenAtBootstrapStart };
    }
    if (params.shouldCommit?.() === false) {
      throw createAccountSettingsLiveApplyError(
        'ACCOUNT_SETTINGS_SOURCE_STALE',
        'The Account Settings publication lifetime ended before Settings bootstrap could be committed.',
      );
    }
    const activeBeforeCommit = getActiveAccountSettingsSnapshot();
    const lifetimeBeforeCommit = getActiveAccountSettingsSnapshotLifetimeToken();
    const firstSameScopePublication = isFirstSameScopePublication({
      activeAtStart: activeAtBootstrapStart, active: activeBeforeCommit,
      activeLifetimeTokenAtStart: activeLifetimeTokenAtBootstrapStart, activeLifetimeToken: lifetimeBeforeCommit,
      scopeKey, settingsSecretsReadKeys,
    });
    if (lifetimeBeforeCommit !== activeLifetimeTokenAtBootstrapStart && !firstSameScopePublication) {
      const currentPublication = currentPublicationForScope();
      if (!currentPublication) {
        throw createAccountSettingsScopeChangedError(
          'bootstrap_lifetime_before_commit',
          'The active account lifetime changed before Settings bootstrap could be committed.',
        );
      }
      if (!shouldTreatVersionAsFresh(currentPublication.context.settingsVersion, minSettingsVersion)) {
        throw new AccountSettingsStaleError();
      }
      return applyPublicationSideEffects(currentPublication);
    }
    // Refreshing the captured incumbent's preferences does not change its
    // Account and cannot veto an explicit bootstrap into the requested scope.
    if (
      activeBeforeCommit !== activeAtBootstrapStart
      && ((activeBeforeCommit?.scopeKey !== scopeKey
          && (!activeBeforeCommit?.scopeKey || activeBeforeCommit.scopeKey !== activeAtBootstrapStart?.scopeKey))
        || settingsKeyMaterialChangedDuringRead(activeAtBootstrapStart, activeBeforeCommit, settingsSecretsReadKeys))
    ) {
      throw createAccountSettingsScopeChangedError(
        'bootstrap_scope_before_commit',
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
  const inMemoryIsCurrent = inMemory?.lifetimeToken === activeLifetimeToken
    && active !== null && sameSettingsPublication(inMemory.snapshot, active);
  const existing = active?.scopeKey === scopeKey
    ? contextFromActiveSnapshot(active)
    : null;
  if (
    refresh === 'auto'
    && existing
    && isDeepStrictEqual(existing.settingsSecretsReadKeys, settingsSecretsReadKeys)
    && shouldTreatCacheAsFresh({ version: 2, cachedAt: inMemoryIsCurrent ? inMemory.validatedAtMs : existing.loadedAtMs,
      settingsContent: null, settingsVersion: existing.settingsVersion }, nowMs, ttlMs)
    && shouldTreatVersionAsFresh(existing.settingsVersion, minSettingsVersion)
  ) {
    const currentPublication = currentPublicationForScope();
    if (!currentPublication) {
      throw createAccountSettingsScopeChangedError(
        'bootstrap_reuse',
        'The active account changed before fresh Settings could be reused.',
      );
    }
    return params.publication === 'invocation'
      ? currentPublication.context
      : applyPublicationSideEffects(currentPublication).context;
  }

  const readCache = await observePhase('cache_read', () => deps.readCache(cachePath));
  const cache =
    readCache?.version === 2 && readCache.settingsContent?.t === 'plain'
      ? null
      : readCache;

  const parseFromContent = async (content: AccountSettingsContentEnvelope | null): Promise<Readonly<{
    rawSettings: Readonly<Record<string, unknown>>;
    settings: AccountSettings;
  }>> => {
    const parseSettings = (raw: Readonly<Record<string, unknown>>): AccountSettings => {
      // Reuse only the current Account owner's already-admitted projection.
      // Fresh HTTP/decryption and publication still run; changed raw content or
      // a different Account/Home scope must go through the canonical parser.
      const active = getActiveAccountSettingsSnapshot();
      return active?.scopeKey === scopeKey && active.rawSettings !== undefined
        && isDeepStrictEqual(active.rawSettings, raw)
        ? active.settings
        : parseBootstrapAccountSettings(raw);
    };
    if (content && params.expectedAccountEncryptionMode
      && (params.expectedAccountEncryptionMode === 'plain' ? content.t !== 'plain' : content.t !== 'encrypted')) {
      throw new AccountSettingsContentInvalidError(new Error('account_settings_mode_mismatch'));
    }
    if (!content) {
      return {
        rawSettings: {},
        settings: accountSettingsParse({}),
      };
    }
    if (content.t === 'plain') {
      const rawSettings = readRawAccountSettingsObject(content.v);
      const settings = parseSettings(rawSettings);
      assertAccountEncryptionModeAllowedByEffectiveClientRequirement('plain', settings);
      return {
        rawSettings,
        settings,
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
      settings: parseSettings(decrypted),
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
    const publication = publishContext(ctx);
    if (params.publication !== 'invocation' && cache?.settingsVersion === publication.context.settingsVersion
      && activeSnapshotPublicationIsCurrent(publication)) {
      rememberInMemoryAccountSettingsContext(scopeKey, publication.context, publication.lifetimeToken,
        publication.snapshot, cache.cachedAt);
    }
    return publication.context;
  };

  const fetchAndParse = async (signal?: AbortSignal): Promise<RequesterSettingsRead> => {
    signal?.throwIfAborted();
    const fetched = await observePhase('network_read', () => deps.fetchFromServer({ credentials: params.credentials, signal }));
    signal?.throwIfAborted();
    const settingsVersion = typeof fetched.settingsVersion === 'number' ? fetched.settingsVersion : 0;
    const settingsContent: AccountSettingsContentEnvelope | null =
      'settingsContent' in fetched
        ? (fetched.settingsContent ?? null)
        : (fetched.settingsCiphertext ? { t: 'encrypted', c: fetched.settingsCiphertext } : null);
    const parsed = await observePhase('content_parse', () => parseFromContent(settingsContent));
    signal?.throwIfAborted();
    return { settingsContent, settingsVersion, parsed };
  };

  const readRequesterSettings = async (): Promise<RequesterSettingsRead> => {
    params.signal?.throwIfAborted();
    // Signed Action authorization and injected transports have distinct read
    // authority; they cannot borrow an ordinary bearer request's result.
    if (params.resolveAuthorizationHeaders || params.deps?.fetchFromServer || params.deps?.decryptCiphertext) {
      return fetchAndParse(params.signal);
    }
    const readKey = createHash('sha256').update(JSON.stringify([
      scopeKey, resolveAccountSettingsHttpBaseUrl(), params.credentials.token,
      settingsSecretsReadKeys.map(key => Buffer.from(key).toString('base64')),
      params.expectedAccountEncryptionMode ?? null,
    ])).digest('hex');
    let flight = requesterSettingsReads.get(readKey);
    if (!flight) {
      const controller = new AbortController();
      const pending = fetchAndParse(controller.signal).finally(() => {
        if (requesterSettingsReads.get(readKey)?.pending === pending) requesterSettingsReads.delete(readKey);
      });
      flight = { pending, controller, readers: 0 };
      requesterSettingsReads.set(readKey, flight);
    }
    flight.readers++;
    try {
      return await (params.signal ? waitForAccountEncryptionObservation(flight.pending, params.signal) : flight.pending);
    } finally {
      if (--flight.readers === 0 && requesterSettingsReads.get(readKey) === flight) {
        requesterSettingsReads.delete(readKey);
        flight.controller.abort();
      }
    }
  };

  const fetchAndPersist = async (): Promise<AccountSettingsContext> => {
    const { settingsContent, settingsVersion, parsed } = await (params.publication === 'invocation'
      ? readRequesterSettings() : fetchAndParse(params.signal));
    params.signal?.throwIfAborted();
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
    const recordPublication = beginPhase('publication');
    let publication: ReturnType<typeof publishContext>;
    try {
      publication = publishContext(candidate);
      recordPublication('completed');
    } catch (error) {
      recordPublication('failed');
      throw error;
    }
    if (!publication.didCommit && publication.context.settingsVersion > candidate.settingsVersion) {
      return publication.context;
    }
    if (params.publication === 'invocation') return publication.context;

    if (settingsContent?.t !== 'plain') {
      try {
        await observePhase('cache_write', () => deps.writeCache(cachePath, {
          version: 2,
          cachedAt: nowMs,
          settingsContent,
          settingsVersion,
        }, {
          shouldCommit: () => params.shouldCommit?.() !== false
            && activeSnapshotPublicationIsCurrent(publication),
        }));
      } catch (err) {
        logger.debug('[accountSettings] cache write failed; continuing without persistence', serializeAxiosErrorForLog(err));
      }
    }
    const activeAfterWrite = getActiveAccountSettingsSnapshot();
    if (activeAfterWrite?.scopeKey === scopeKey) {
      const context = contextFromActiveSnapshot(activeAfterWrite);
      if (activeAfterWrite === publication.snapshot && activeAfterWrite.settingsVersion === settingsVersion
        && activeSnapshotPublicationIsCurrent(publication) && params.shouldCommit?.() !== false) {
        rememberInMemoryAccountSettingsContext(scopeKey, context, publication.lifetimeToken, activeAfterWrite, nowMs);
      }
      return context;
    }
    throw createAccountSettingsScopeChangedError(
      'bootstrap_cache_write',
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
      params.signal?.throwIfAborted();
      if (isClientE2eeRequiredError(err)) throw err;
      if (params.allowCacheFallback === false || minSettingsVersion !== null || isAccountSettingsContentUnavailableError(err)) {
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
    params.signal?.throwIfAborted();
    if (isClientE2eeRequiredError(err)) throw err;
    if (params.allowCacheFallback === false || minSettingsVersion !== null || isAccountSettingsContentUnavailableError(err)) {
      throw err;
    }
    logger.debug('[accountSettings] fetch failed; falling back to cache', serializeAxiosErrorForLog(err));
    return useCache();
  }
}
