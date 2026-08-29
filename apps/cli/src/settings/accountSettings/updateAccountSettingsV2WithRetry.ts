import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Credentials, StoredCredentials } from '@/persistence';

import axios from 'axios';

import { configuration } from '@/configuration';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';
import { decryptAccountSettingsCiphertext } from '@/settings/accountSettingsClient';
import {
  applyAccountSettingMutationV1,
  AccountEncryptionModeResponseSchema,
  accountSettingsParse,
  AccountSettingsV2GetResponseSchema,
  AccountSettingsV2UpdateRequestSchema,
  AccountSettingsV2UpdateResponseSchema,
  AccountSettingsPersistedObjectSchema,
  openAccountScopedBlobCiphertext,
  resealSecretsDeepV1,
  sealAccountScopedBlobCiphertext,
  unsealSecretsDeepWithKeysV1,
  type AccountSettings,
  type AccountSettingMutationV1,
  type AccountSettingsMutationResult,
  type AccountSettingsPersistedObject,
  type AccountSettingsStoredContentEnvelope,
  type AccountSettingsV2UpdateResponse,
} from '@happier-dev/protocol';

import {
  resolveAccountSettingsCachePath,
  writeAccountSettingsCacheAtomic,
  type AccountSettingsCache,
  type AccountSettingsCacheWriteOptions,
} from './accountSettingsCache';
import { resolveAccountSettingsHttpBaseUrl } from './resolveAccountSettingsHttpBaseUrl';
import {
  isAccountSettingsEncryptionMaterialUnavailableError,
  requireAccountSettingsEncryptionCredentials,
} from './accountSettingsEncryptionMaterial';
import {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

export type { AccountSettingsMutationResult } from '@happier-dev/protocol';

function resolveMaterial(credentials: Credentials): { type: 'legacy'; secret: Uint8Array } | { type: 'dataKey'; machineKey: Uint8Array } {
  return credentials.encryption.type === 'legacy'
    ? { type: 'legacy', secret: credentials.encryption.secret }
    : { type: 'dataKey', machineKey: credentials.encryption.machineKey };
}

function resolveDefaultRandomBytes(): (n: number) => Uint8Array {
  return (n) => new Uint8Array(nodeRandomBytes(n));
}

/**
 * The property a refused Account Settings HTTP response records its own error
 * code under. Deliberately not `code`: that carries transport errnos such as
 * `ECONNRESET`, and reporting one of those as the server's stated reason would
 * be a fabrication.
 */
const BOUNDARY_REFUSAL_CODE_PROPERTY = 'accountSettingsBoundaryRefusalCode';

/**
 * A refusal body carries a machine code (`{ error: "account_settings_storage_unavailable" }`),
 * never prose. Accepting only a short code-shaped token keeps an HTML error page,
 * a stack trace, or any other unexpected payload out of logs that a caller may
 * surface to an operator.
 */
function readBoundaryRefusalCode(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = (body as Record<string, unknown>).error;
  if (typeof candidate !== 'string') return null;
  const code = candidate.trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : null;
}

class AccountSettingsContentUnreadableError extends Error {
  constructor() {
    super('Failed to decrypt account settings ciphertext');
    this.name = 'AccountSettingsContentUnreadableError';
  }
}

class AccountSettingsModeMismatchError extends Error {
  constructor() {
    super('Persisted Account encryption mode does not match the Settings content envelope');
    this.name = 'AccountSettingsModeMismatchError';
  }
}

class AccountSettingsBoundaryUnavailableError extends Error {
  readonly retryable: boolean;

  constructor(error: unknown) {
    super('Account Settings boundary is unavailable', { cause: error });
    this.name = 'AccountSettingsBoundaryUnavailableError';
    this.retryable = classifyServerEndpointError(error, { featureAbsentStatusCodes: [404] }).retryable;
  }
}

class AccountSettingMutationInvalidError extends Error {
  readonly reason: Extract<AccountSettingsMutationResult, { status: 'invalid' }>['reason'];

  constructor(reason: Extract<AccountSettingsMutationResult, { status: 'invalid' }>['reason']) {
    super(`Invalid Account Settings mutation: ${reason}`);
    this.name = 'AccountSettingMutationInvalidError';
    this.reason = reason;
  }
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

function accountSettingsV2WriteFitsProtocolLimits(request: Readonly<{
  expectedVersion: number;
  content: AccountSettingsStoredContentEnvelope | null;
}>): boolean {
  return AccountSettingsV2UpdateRequestSchema.safeParse(request).success;
}

function normalizeSettingsSecretsForEnvelope(params: Readonly<{
  raw: AccountSettingsPersistedObject;
  envelopeKind: 'plain' | 'encrypted';
  credentials: StoredCredentials;
  randomBytes: (n: number) => Uint8Array;
}>): AccountSettingsPersistedObject {
  const readKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);
  if (params.envelopeKind === 'plain') {
    return parsePersistedAccountSettingsObject(
      unsealSecretsDeepWithKeysV1(params.raw, readKeys),
    );
  }

  const encryptionCredentials = requireAccountSettingsEncryptionCredentials(params.credentials);
  return parsePersistedAccountSettingsObject(
    resealSecretsDeepV1(params.raw, {
      readKeys,
      writeKey: deriveSettingsSecretsKeyForCredentials(encryptionCredentials),
      randomBytes: params.randomBytes,
    }).value,
  );
}

async function parseSettingsFromContent(params: Readonly<{
  content: AccountSettingsStoredContentEnvelope | null;
  credentials: StoredCredentials;
  emptyEnvelopeKind: 'plain' | 'encrypted';
}>): Promise<{ raw: AccountSettingsPersistedObject; envelopeKind: 'plain' | 'encrypted' }> {
  if (!params.content) {
    return {
      raw: {},
      envelopeKind: params.emptyEnvelopeKind,
    };
  }

  if (params.content.t === 'plain') {
    return { raw: parsePersistedAccountSettingsObject(params.content.v), envelopeKind: 'plain' };
  }

  const ciphertext = params.content.c;
  const encryptionCredentials = requireAccountSettingsEncryptionCredentials(params.credentials);
  const opened = openAccountScopedBlobCiphertext({
    kind: 'account_settings',
    material: resolveMaterial(encryptionCredentials),
    ciphertext,
  });
  if (opened?.value && typeof opened.value === 'object' && !Array.isArray(opened.value)) {
    return { raw: parsePersistedAccountSettingsObject(opened.value), envelopeKind: 'encrypted' };
  }

  const decrypted = await decryptAccountSettingsCiphertext({ credentials: encryptionCredentials, ciphertext });
  if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
    return { raw: parsePersistedAccountSettingsObject(decrypted), envelopeKind: 'encrypted' };
  }

  throw new AccountSettingsContentUnreadableError();
}

export type AccountSettingsUpdateV2Deps = Readonly<{
  fetchSettings?: () => Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  updateSettings?: (req: Readonly<{ expectedVersion: number; content: AccountSettingsStoredContentEnvelope | null }>) => Promise<AccountSettingsV2UpdateResponse>;
  resolveAccountEncryptionMode?: () => Promise<'plain' | 'e2ee'>;
  randomBytes?: (n: number) => Uint8Array;
  nowMs?: () => number;
  resolveCachePath?: (credentials: StoredCredentials) => string;
  writeCache?: (
    path: string,
    cache: AccountSettingsCache,
    options?: AccountSettingsCacheWriteOptions,
  ) => Promise<void>;
}>;

type UpdateAccountSettingsV2WithRetryCommonParams = Readonly<{
  credentials: StoredCredentials;
  deps?: AccountSettingsUpdateV2Deps;
  signal?: AbortSignal;
  /**
   * A caller-owned lifetime fence evaluated only before the transport write is
   * invoked. Once the write starts, its result must settle without re-running
   * a retired caller's fence.
   */
  shouldSubmit?: () => boolean;
  shouldCommit?: () => boolean;
}>;

type AccountSettingsMutationCallback = (
  settings: Readonly<Record<string, unknown>>,
) =>
  | Readonly<Record<string, unknown>>
  | Promise<Readonly<Record<string, unknown>>>;

export type UpdateAccountSettingsV2WithRetryParams = UpdateAccountSettingsV2WithRetryCommonParams & Readonly<{
  mutation: AccountSettingMutationV1;
  maxAttempts?: number;
  mutate?: never;
}>;

export type UpdateAccountSettingsV2OnceAgainstLatestParams = UpdateAccountSettingsV2WithRetryCommonParams & Readonly<{
  /** Evaluated exactly once against the fetched Account Settings version. */
  mutate: AccountSettingsMutationCallback;
  mutation?: never;
}>;

export type UpdateAccountSettingsV2OnceParams = UpdateAccountSettingsV2WithRetryCommonParams & Readonly<{
  /**
   * The caller's observed Account Settings version.  Unlike the retrying
   * operation, this owner must not evaluate the mutation against a newer
   * document after this version has gone stale.
   */
  expectedVersion: number;
  mutate: AccountSettingsMutationCallback;
}>;

export type UpdateAccountSettingsV2OnceResult = AccountSettingsMutationResult;

export type AccountSettingsMutationSuccess = Extract<AccountSettingsMutationResult, Readonly<{
  status: 'applied' | 'satisfied' | 'unchanged';
}>>;

type ResolvedAccountSettingsV2UpdateDeps = Readonly<{
  fetchSettings(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  rereadSettings(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  updateSettings(req: Readonly<{
    expectedVersion: number;
    content: AccountSettingsStoredContentEnvelope | null;
  }>): Promise<AccountSettingsV2UpdateResponse>;
  resolveAccountEncryptionMode(): Promise<'plain' | 'e2ee'>;
  resolveAccountEncryptionModeForReadback(): Promise<'plain' | 'e2ee'>;
  randomBytes(n: number): Uint8Array;
  writeCacheSnapshot(
    settingsContent: AccountSettingsStoredContentEnvelope | null,
    settingsVersion: number,
  ): Promise<void>;
}>;

function resolveAccountSettingsV2UpdateDeps(params: Readonly<{
  credentials: StoredCredentials;
  deps?: AccountSettingsUpdateV2Deps;
  signal?: AbortSignal;
  shouldCommit?: () => boolean;
}>): ResolvedAccountSettingsV2UpdateDeps {
  const randomBytes = params.deps?.randomBytes ?? resolveDefaultRandomBytes();
  const nowMs = params.deps?.nowMs ?? (() => Date.now());
  const resolveCachePath = params.deps?.resolveCachePath ?? resolveAccountSettingsCachePath;
  const writeCache = params.deps?.writeCache ?? writeAccountSettingsCacheAtomic;

  const writeCacheSnapshot = async (settingsContent: AccountSettingsStoredContentEnvelope | null, settingsVersion: number): Promise<void> => {
    if (settingsContent?.t === 'plain') return;
    if (params.shouldCommit?.() === false) return;
    const cachePath = resolveCachePath(params.credentials);
    const cache: AccountSettingsCache = {
      version: 2,
      cachedAt: nowMs(),
      settingsContent,
      settingsVersion,
    };
    try {
      if (params.shouldCommit) {
        await writeCache(cachePath, cache, { shouldCommit: params.shouldCommit });
      } else {
        await writeCache(cachePath, cache);
      }
    } catch (error) {
      logger.debug('[accountSettings] cache write failed after settings refresh/update (ignored)', serializeAxiosErrorForLog(error));
    }
  };

  const fetchSettingsFromServer = async (signal?: AbortSignal) => {
    const accountSettingsBaseUrl = resolveAccountSettingsHttpBaseUrl();
    const response = await axios.get(`${accountSettingsBaseUrl}/v2/account/settings`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) {
      throw Object.assign(new Error('settings_v2_not_supported'), { code: 'settings_v2_not_supported' });
    }
    if (response.status < 200 || response.status >= 300) {
      const refusalCode = readBoundaryRefusalCode(response.data);
      throw Object.assign(
        new Error(`Failed to fetch /v2/account/settings (${response.status})`),
        {
          status: response.status,
          ...(refusalCode ? { [BOUNDARY_REFUSAL_CODE_PROPERTY]: refusalCode } : {}),
        },
      );
    }
    const parsed = AccountSettingsV2GetResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new Error('Failed to parse account settings v2 response');
    return { content: parsed.data.content, version: parsed.data.version };
  };

  const fetchSettings = params.deps?.fetchSettings
    ?? (async () => await fetchSettingsFromServer(params.signal));
  // A write that was already submitted must settle from an incumbent read even
  // when the initiating caller has since cancelled.
  const rereadSettings = params.deps?.fetchSettings
    ?? (async () => await fetchSettingsFromServer());

  const updateSettings = params.deps?.updateSettings ?? (async (req) => {
    const accountSettingsBaseUrl = resolveAccountSettingsHttpBaseUrl();
    const response = await axios.post(`${accountSettingsBaseUrl}/v2/account/settings`, {
      content: req.content,
      expectedVersion: req.expectedVersion,
    }, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
      ...(params.signal ? { signal: params.signal } : {}),
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

  const resolveAccountEncryptionModeFromServer = async (signal?: AbortSignal) => {
    const accountSettingsBaseUrl = resolveAccountSettingsHttpBaseUrl();
    const response = await axios.get(`${accountSettingsBaseUrl}/v1/account/encryption`, {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      validateStatus: () => true,
      ...(signal ? { signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(
        new Error(`Failed to resolve account encryption mode (${response.status})`),
        { status: response.status },
      );
    }
    const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Failed to parse account encryption mode response');
    }
    return parsed.data.mode;
  };

  const resolveAccountEncryptionMode = params.deps?.resolveAccountEncryptionMode
    ?? (async () => await resolveAccountEncryptionModeFromServer(params.signal));
  const resolveAccountEncryptionModeForReadback = params.deps?.resolveAccountEncryptionMode
    ?? (async () => await resolveAccountEncryptionModeFromServer());

  return Object.freeze({
    fetchSettings,
    rereadSettings,
    updateSettings,
    resolveAccountEncryptionMode,
    resolveAccountEncryptionModeForReadback,
    randomBytes,
    writeCacheSnapshot,
  });
}

async function prepareAccountSettingsV2Mutation(params: Readonly<{
  credentials: StoredCredentials;
  content: AccountSettingsStoredContentEnvelope | null;
  application:
    | Readonly<{ kind: 'immutable'; mutation: AccountSettingMutationV1 }>
    | Readonly<{ kind: 'callback'; mutate: AccountSettingsMutationCallback }>;
  deps: ResolvedAccountSettingsV2UpdateDeps;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  didChange: boolean;
  content: AccountSettingsStoredContentEnvelope | null;
  raw: AccountSettingsPersistedObject;
  envelopeKind: 'plain' | 'encrypted';
  settings: AccountSettings;
}>> {
  let accountMode: 'plain' | 'e2ee';
  try {
    accountMode = await params.deps.resolveAccountEncryptionMode();
  } catch (error) {
    throw new AccountSettingsBoundaryUnavailableError(error);
  }
  const emptyEnvelopeKind = accountMode === 'plain' ? 'plain' : 'encrypted';
  if (params.content && params.content.t !== emptyEnvelopeKind) {
    throw new AccountSettingsModeMismatchError();
  }
  const parsed = await parseSettingsFromContent({
    content: params.content,
    credentials: params.credentials,
    emptyEnvelopeKind,
  });
  params.signal?.throwIfAborted();
  let mergedRaw: AccountSettingsPersistedObject;
  if (params.application.kind === 'immutable') {
    const applied = applyAccountSettingMutationV1(parsed.raw, params.application.mutation);
    if (applied.status === 'invalid') {
      throw new AccountSettingMutationInvalidError(applied.reason);
    }
    mergedRaw = applied.raw;
  } else {
    mergedRaw = mergeMutationResultWithRawBase({
      rawBase: parsed.raw,
      mutatedRaw: parsePersistedAccountSettingsObject(await params.application.mutate(parsed.raw)),
    });
  }
  params.signal?.throwIfAborted();
  const nextRaw = normalizeSettingsSecretsForEnvelope({
    raw: mergedRaw,
    envelopeKind: parsed.envelopeKind,
    credentials: params.credentials,
    randomBytes: params.deps.randomBytes,
  });
  const settings = accountSettingsParse(nextRaw);

  if (isDeepStrictEqual(nextRaw, parsed.raw)) {
    return Object.freeze({
      didChange: false,
      content: params.content,
      raw: nextRaw,
      envelopeKind: parsed.envelopeKind,
      settings,
    });
  }

  return Object.freeze({
    didChange: true,
    content: parsed.envelopeKind === 'plain'
      ? { t: 'plain' as const, v: nextRaw }
      : {
        t: 'encrypted' as const,
        c: sealAccountScopedBlobCiphertext({
          kind: 'account_settings',
          material: resolveMaterial(requireAccountSettingsEncryptionCredentials(params.credentials)),
          payload: nextRaw,
          randomBytes: params.deps.randomBytes,
        }),
      },
    raw: nextRaw,
    envelopeKind: parsed.envelopeKind,
    settings,
  });
}

function cancelledBeforeSubmission(): AccountSettingsMutationResult {
  return Object.freeze({ status: 'cancelled' as const, submitted: false as const });
}

function isCancelledBeforeSubmission(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function maySubmitAccountSettingsMutation(params: Readonly<{
  signal?: AbortSignal;
  shouldSubmit?: () => boolean;
}>): boolean {
  return !isCancelledBeforeSubmission(params.signal) && params.shouldSubmit?.() !== false;
}

/**
 * Narrows a total Account Settings CAS result for callers whose follow-up
 * operation requires a confirmed Settings version. Keeping this assertion at
 * the CAS owner prevents provider migrations and connection authoring from
 * interpreting an unsubmitted or unknown result as current.
 */
export function requireAccountSettingsMutationSuccess(
  result: AccountSettingsMutationResult,
): AccountSettingsMutationSuccess {
  if (
    result.status === 'applied'
    || result.status === 'satisfied'
    || result.status === 'unchanged'
  ) {
    return result;
  }
  throw new Error(`Account Settings mutation did not settle: ${result.status}`);
}

function lockedResultForPreSubmissionError(error: unknown): AccountSettingsMutationResult | null {
  if (error instanceof AccountSettingsModeMismatchError) {
    return Object.freeze({ status: 'locked', reason: 'modeMismatch' });
  }
  if (isAccountSettingsEncryptionMaterialUnavailableError(error)) {
    return Object.freeze({
      status: 'locked' as const,
      reason: 'encryptionMaterialUnavailable' as const,
    });
  }
  if (error instanceof AccountSettingsContentUnreadableError) {
    return Object.freeze({ status: 'locked' as const, reason: 'contentUnreadable' as const });
  }
  return null;
}

function readRecordedBoundaryRefusalCode(error: unknown, depth = 0): string | null {
  if (!error || typeof error !== 'object') return null;
  const recorded = (error as Record<string, unknown>)[BOUNDARY_REFUSAL_CODE_PROPERTY];
  if (typeof recorded === 'string' && recorded) return recorded;
  return depth >= 4
    ? null
    : readRecordedBoundaryRefusalCode((error as Record<string, unknown>).cause, depth + 1);
}

function unavailableResultForBoundaryError(error: unknown): AccountSettingsMutationResult {
  const retryable = error instanceof AccountSettingsBoundaryUnavailableError
    ? error.retryable
    : classifyServerEndpointError(error, { featureAbsentStatusCodes: [404] }).retryable;
  // The single collapse point for every unavailable outcome, so naming the
  // boundary's own refusal code here reaches every caller at once.
  const reason = readRecordedBoundaryRefusalCode(error);
  return Object.freeze({ status: 'unavailable', retryable, ...(reason ? { reason } : {}) });
}

function matchesPreparedMutation(params: Readonly<{
  rereadRaw: AccountSettingsPersistedObject;
  expectedRaw: AccountSettingsPersistedObject;
  mutation: AccountSettingMutationV1;
}>): boolean {
  return params.mutation.operations.every((operation) => operation.op === 'reset'
    ? !hasOwnRecordKey(params.rereadRaw, operation.key)
    : hasOwnRecordKey(params.rereadRaw, operation.key)
      && isDeepStrictEqual(params.rereadRaw[operation.key], params.expectedRaw[operation.key]));
}

async function settleSubmittedImmutableWrite(params: Readonly<{
  credentials: StoredCredentials;
  deps: ResolvedAccountSettingsV2UpdateDeps;
  prepared: Awaited<ReturnType<typeof prepareAccountSettingsV2Mutation>>;
  mutation: AccountSettingMutationV1;
  lastKnownVersion: number;
  shouldCommit?: () => boolean;
}>): Promise<AccountSettingsMutationResult> {
  try {
    const reread = await params.deps.rereadSettings();
    const accountMode = await params.deps.resolveAccountEncryptionModeForReadback();
    const expectedEnvelopeKind = accountMode === 'plain' ? 'plain' : 'encrypted';
    if (reread.content && reread.content.t !== expectedEnvelopeKind) {
      return Object.freeze({ status: 'outcomeUnknown', lastKnownVersion: reread.version });
    }
    const parsed = await parseSettingsFromContent({
      content: reread.content,
      credentials: params.credentials,
      emptyEnvelopeKind: expectedEnvelopeKind,
    });
    if (params.shouldCommit?.() !== false) {
      await params.deps.writeCacheSnapshot(reread.content, reread.version);
    }
    const isSatisfied = matchesPreparedMutation({
      rereadRaw: parsed.raw,
      expectedRaw: params.prepared.raw,
      mutation: params.mutation,
    });
    if (isSatisfied) {
      return Object.freeze({
        status: 'satisfied' as const,
        version: reread.version,
        settings: accountSettingsParse(parsed.raw),
      });
    }
    return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: reread.version });
  } catch {
    return Object.freeze({ status: 'outcomeUnknown' as const, lastKnownVersion: params.lastKnownVersion });
  }
}

export async function updateAccountSettingsV2WithRetry(
  params: UpdateAccountSettingsV2WithRetryParams,
): Promise<AccountSettingsMutationResult> {
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  if (params.shouldCommit?.() === false) return cancelledBeforeSubmission();
  const application = { kind: 'immutable' as const, mutation: params.mutation };
  const requestedMaxAttempts = params.maxAttempts;
  const maxAttempts = typeof requestedMaxAttempts === 'number'
    && Number.isFinite(requestedMaxAttempts)
    && requestedMaxAttempts > 0
    ? Math.floor(requestedMaxAttempts)
    : 3;
  const deps = resolveAccountSettingsV2UpdateDeps(params);
  let fetched: Awaited<ReturnType<typeof deps.fetchSettings>>;
  try {
    fetched = await deps.fetchSettings();
  } catch (error) {
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
    if (params.shouldCommit?.() === false) return cancelledBeforeSubmission();
    return unavailableResultForBoundaryError(error);
  }
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  let content = fetched.content;
  let version = fetched.version;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
    let prepared: Awaited<ReturnType<typeof prepareAccountSettingsV2Mutation>>;
    try {
      prepared = await prepareAccountSettingsV2Mutation({
        content,
        credentials: params.credentials,
        application,
        deps,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
      const locked = lockedResultForPreSubmissionError(error);
      if (locked) return locked;
      if (error instanceof AccountSettingMutationInvalidError) {
        return Object.freeze({ status: 'invalid', reason: error.reason });
      }
      if (error instanceof AccountSettingsBoundaryUnavailableError) {
        return unavailableResultForBoundaryError(error);
      }
      throw error;
    }
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
    if (!prepared.didChange) {
      if (params.shouldCommit?.() !== false) {
        await deps.writeCacheSnapshot(content, version);
      }
      return Object.freeze({ status: 'unchanged' as const, version, settings: prepared.settings });
    }

    const updateRequest = { expectedVersion: version, content: prepared.content };
    if (!accountSettingsV2WriteFitsProtocolLimits(updateRequest)) {
      return Object.freeze({ status: 'invalid' as const, reason: 'tooLarge' as const });
    }

    // This must remain immediately adjacent to the transport invocation: a
    // SavedSecret caller may retire after fetch/preparation but before its CAS
    // reaches the server. There is intentionally no equivalent fence after
    // this line, because the write is then already submitted.
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();

    let response: AccountSettingsV2UpdateResponse;
    try {
      response = await deps.updateSettings(updateRequest);
    } catch {
      return await settleSubmittedImmutableWrite({
        credentials: params.credentials,
        deps,
        prepared,
        mutation: application.mutation,
        lastKnownVersion: version,
        ...(params.shouldCommit ? { shouldCommit: params.shouldCommit } : {}),
      });
    }
    if (response.success === true) {
      if (params.shouldCommit?.() !== false) {
        await deps.writeCacheSnapshot(prepared.content, response.version);
      }
      return Object.freeze({ status: 'applied' as const, version: response.version, settings: prepared.settings });
    }
    if (response.error === 'invalid') {
      return Object.freeze({ status: 'invalid' as const, reason: response.reason });
    }

    // Version mismatch: retry only while the caller remains current. A
    // received conflict is a truthful terminal result after cancellation.
    content = response.currentContent;
    version = response.currentVersion;
    if (isCancelledBeforeSubmission(params.signal)) {
      return Object.freeze({ status: 'conflict' as const, currentVersion: version });
    }
  }

  return Object.freeze({ status: 'conflict' as const, currentVersion: version });
}

/**
 * Evaluates one semantic Account Settings mutation against the latest fetched
 * version and submits exactly one CAS. A conflict is terminal: callers may
 * begin a new user/domain operation, but this owner never re-enters arbitrary
 * callback code behind their back.
 */
async function updateAccountSettingsV2OnceInternal(
  params: UpdateAccountSettingsV2OnceAgainstLatestParams & Readonly<{ expectedVersion?: number }>,
): Promise<UpdateAccountSettingsV2OnceResult> {
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  const deps = resolveAccountSettingsV2UpdateDeps(params);
  let fetched: Awaited<ReturnType<typeof deps.fetchSettings>>;
  try {
    fetched = await deps.fetchSettings();
  } catch (error) {
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
    return unavailableResultForBoundaryError(error);
  }
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  if (params.expectedVersion !== undefined && fetched.version !== params.expectedVersion) {
    return Object.freeze({ status: 'conflict', currentVersion: fetched.version });
  }

  let prepared: Awaited<ReturnType<typeof prepareAccountSettingsV2Mutation>>;
  try {
    prepared = await prepareAccountSettingsV2Mutation({
      content: fetched.content,
      credentials: params.credentials,
      application: { kind: 'callback', mutate: params.mutate },
      deps,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch (error) {
    if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
    const locked = lockedResultForPreSubmissionError(error);
    if (locked) return locked;
    if (error instanceof AccountSettingsBoundaryUnavailableError) {
      return unavailableResultForBoundaryError(error);
    }
    throw error;
  }
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  if (!prepared.didChange) {
    if (params.shouldCommit?.() !== false) {
      await deps.writeCacheSnapshot(fetched.content, fetched.version);
    }
    return Object.freeze({ status: 'unchanged', version: fetched.version, settings: prepared.settings });
  }

  const updateRequest = { expectedVersion: fetched.version, content: prepared.content };
  if (!accountSettingsV2WriteFitsProtocolLimits(updateRequest)) {
    return Object.freeze({ status: 'invalid', reason: 'tooLarge' });
  }
  if (!maySubmitAccountSettingsMutation(params)) return cancelledBeforeSubmission();
  let response: AccountSettingsV2UpdateResponse;
  try {
    response = await deps.updateSettings(updateRequest);
  } catch {
    return Object.freeze({ status: 'outcomeUnknown', lastKnownVersion: fetched.version });
  }
  if (response.success === false && response.error === 'invalid') {
    return Object.freeze({ status: 'invalid', reason: response.reason });
  }
  if (response.success === false) {
    return Object.freeze({ status: 'conflict', currentVersion: response.currentVersion });
  }
  if (params.shouldCommit?.() !== false) {
    await deps.writeCacheSnapshot(prepared.content, response.version);
  }
  return Object.freeze({ status: 'applied', version: response.version, settings: prepared.settings });
}

export async function updateAccountSettingsV2OnceAgainstLatest(
  params: UpdateAccountSettingsV2OnceAgainstLatestParams,
): Promise<UpdateAccountSettingsV2OnceResult> {
  return await updateAccountSettingsV2OnceInternal(params);
}

/**
 * Executes one Account Settings CAS against the caller-observed version.
 * This is intentionally separate from the general retrying helper: callers
 * that create immutable SavedSecret records must never replay a mutation onto
 * a later document after a conflict.
 */
export async function updateAccountSettingsV2Once(
  params: UpdateAccountSettingsV2OnceParams,
): Promise<UpdateAccountSettingsV2OnceResult> {
  return await updateAccountSettingsV2OnceInternal(params);
}
