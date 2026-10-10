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
import { applyAccountSettingMutationV1 } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2GetResponseSchema, AccountSettingsV2UpdateRequestSchema, AccountSettingsV2UpdateResponseSchema,
  type AccountSettingsV2UpdateRequest } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { AccountSettingsPersistedObjectSchema } from '@happier-dev/protocol/account/settings/accountSettingsPersistedObject';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { resealSecretsDeepV1, unsealSecretsDeepWithKeysV1 } from '@happier-dev/protocol/crypto/settingsSecretStringsV1';
import type { AccountSettings, AccountSettingMutationV1, AccountSettingsMutationResult, AccountSettingsPersistedObject, AccountSettingsStoredContentEnvelope, AccountSettingsV2UpdateResponse, LegacyAuthoringMemorySettingsKey } from '@happier-dev/protocol';

import {
  resolveAccountSettingsCachePath,
  writeAccountSettingsCacheAtomic,
  type AccountSettingsCache,
  type AccountSettingsCacheWriteOptions,
} from './accountSettingsCache';
import { resolveAccountSettingsHttpBaseUrl } from './resolveAccountSettingsHttpBaseUrl';
import { assertAccountEncryptionModeAllowedByEffectiveClientRequirement } from './resolveEffectiveClientEncryptionRequirement';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
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
  parsedBase: AccountSettings;
  mutatedRaw: AccountSettingsPersistedObject;
}>): AccountSettingsPersistedObject {
  let runtimeDefaults: AccountSettings | undefined;
  const next: Record<string, unknown> = {};

  for (const [key, baseValue] of Object.entries(params.rawBase)) {
    if (!hasOwnRecordKey(params.mutatedRaw, key)) {
      next[key] = baseValue;
      continue;
    }

    const mutatedValue = params.mutatedRaw[key];
    const parsedBaseValue = params.parsedBase[key];
    const looksLikeParserMaterializedValue =
      !isDeepStrictEqual(baseValue, parsedBaseValue)
      && isDeepStrictEqual(mutatedValue, parsedBaseValue);

    next[key] = looksLikeParserMaterializedValue ? baseValue : mutatedValue;
  }

  for (const [key, mutatedValue] of Object.entries(params.mutatedRaw)) {
    if (hasOwnRecordKey(params.rawBase, key)) continue;

    runtimeDefaults ??= accountSettingsParse({});
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

/** Preserve recorded bytes apart from the caller's explicit normalization. */
export function sealAccountSettingsV2RawContent(params: Readonly<{
  credentials: StoredCredentials;
  raw: AccountSettingsPersistedObject;
  envelopeKind: 'plain' | 'encrypted';
  randomBytes: (n: number) => Uint8Array;
}>): AccountSettingsStoredContentEnvelope {
  if (params.envelopeKind === 'plain') return { t: 'plain', v: params.raw };
  return { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
    material: resolveMaterial(requireAccountSettingsEncryptionCredentials(params.credentials)),
    payload: params.raw, randomBytes: params.randomBytes,
  }) };
}

/** Composite transactions borrow the same nested SecretString and envelope writer without dispatch. */
export function prepareAccountSettingsV2Content(params: Readonly<{
  credentials: StoredCredentials;
  raw: Readonly<Record<string, unknown>>;
  envelopeKind: 'plain' | 'encrypted';
  randomBytes?: (n: number) => Uint8Array;
}>): AccountSettingsStoredContentEnvelope {
  const randomBytes = params.randomBytes ?? resolveDefaultRandomBytes();
  const raw = normalizeSettingsSecretsForEnvelope({ ...params, raw: parsePersistedAccountSettingsObject(params.raw), randomBytes });
  if (params.envelopeKind === 'plain') assertAccountEncryptionModeAllowedByEffectiveClientRequirement('plain', accountSettingsParse(raw));
  return sealAccountSettingsV2RawContent({ ...params, raw, randomBytes });
}

/** Recorded envelopes open in their recorded mode, independently of current Account mode. */
export async function parseSettingsFromContent(params: Readonly<{
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

type AccountSettingsUpdateRequestV2 = Readonly<Pick<AccountSettingsV2UpdateRequest, 'expectedVersion' | 'content' | 'expectedProfileTransferRevision'>>;

export type AccountSettingsUpdateV2Deps = Readonly<{
  fetchSettings?: () => Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  updateSettings?: (req: AccountSettingsUpdateRequestV2) => Promise<AccountSettingsV2UpdateResponse>;
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
  /** Captured Profile authority; never re-derived from a later winning control. */
  expectedProfileTransferRevision?: AccountSettingsV2UpdateRequest['expectedProfileTransferRevision'];
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

export type UpdateAccountSettingsV2WithRetryParams = UpdateAccountSettingsV2WithRetryCommonParams & (Readonly<{
  mutation: AccountSettingMutationV1;
  mutate?: never;
  prepareMutation?: never;
}> | Readonly<{
  /** Replay-safe domain intent: prepare sparse operations against each winning raw document. */
  prepareMutation: NonNullable<UpdateAccountSettingsV2OnceAgainstLatestParams['prepareMutation']>;
  mutation?: never;
  mutate?: never;
}>);

export type UpdateAccountSettingsV2OnceAgainstLatestParams = UpdateAccountSettingsV2WithRetryCommonParams & (Readonly<{
  /** Evaluated exactly once against the fetched Account Settings version. */
  mutate: AccountSettingsMutationCallback;
  mutation?: never;
  prepareMutation?: never;
}> | Readonly<{
  /** Prepare an explicit sparse operation once, after dependent resources are retained. */
  prepareMutation: (raw: Readonly<Record<string, unknown>>) => AccountSettingMutationV1 | Promise<AccountSettingMutationV1>;
  mutate?: never;
  mutation?: never;
}>);

export type UpdateAccountSettingsV2OnceParams = UpdateAccountSettingsV2OnceAgainstLatestParams & Readonly<{
  /**
   * The caller's observed Account Settings version.  Unlike the retrying
   * operation, this owner must not evaluate the mutation against a newer
   * document after this version has gone stale.
   */
  expectedVersion: number;
  /** Destination-first 0.2 import only; never a general unknown-key mutation. */
  retireLegacyAuthoringMemoryKey?: LegacyAuthoringMemorySettingsKey;
}>;

export type UpdateAccountSettingsV2OnceResult = AccountSettingsMutationResult;

export type AccountSettingsMutationSuccess = Extract<AccountSettingsMutationResult, Readonly<{
  status: 'applied' | 'satisfied' | 'unchanged';
}>>;

type ResolvedAccountSettingsV2UpdateDeps = Readonly<{
  fetchSettings(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  rereadSettings(): Promise<{ content: AccountSettingsStoredContentEnvelope | null; version: number }>;
  updateSettings(req: AccountSettingsUpdateRequestV2): Promise<AccountSettingsV2UpdateResponse>;
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
    const response = await axios.post(`${accountSettingsBaseUrl}/v2/account/settings`, AccountSettingsV2UpdateRequestSchema.parse(req), {
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
    const result = await readAccountEncryptionModeOnce({
      request: async () => await axios.get(`${accountSettingsBaseUrl}/v1/account/encryption`, {
        headers: {
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
          Authorization: `Bearer ${params.credentials.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
        validateStatus: () => true,
        ...(signal ? { signal } : {}),
      }),
    });
    if (result.kind !== 'resolved') {
      throw Object.assign(
        new Error(result.kind === 'http_error'
          ? `Failed to resolve account encryption mode (${result.status})`
          : 'Failed to parse account encryption mode response'),
        { status: result.status },
      );
    }
    return result.mode;
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

async function openAccountSettingsV2RawBaseline(params: Readonly<{
  credentials: StoredCredentials;
  content: AccountSettingsStoredContentEnvelope | null;
  deps: ResolvedAccountSettingsV2UpdateDeps;
  signal?: AbortSignal;
}>) {
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
  const settings = parsed.envelopeKind === 'plain' ? accountSettingsParse(parsed.raw) : undefined;
  if (settings) {
    assertAccountEncryptionModeAllowedByEffectiveClientRequirement('plain', settings);
  }
  params.signal?.throwIfAborted();
  return { ...parsed, settings };
}

/** Exact opened raw baseline shared by bounded owner cutovers. */
export async function readAccountSettingsV2Raw(params: Readonly<{
  credentials: StoredCredentials;
  deps?: AccountSettingsUpdateV2Deps;
  signal?: AbortSignal;
}>): Promise<Readonly<{ raw: AccountSettingsPersistedObject; version: number; envelopeKind: 'plain' | 'encrypted' }>> {
  const deps = resolveAccountSettingsV2UpdateDeps(params);
  const fetched = await deps.fetchSettings();
  const parsed = await openAccountSettingsV2RawBaseline({ ...params, deps, content: fetched.content });
  return { raw: parsed.raw, version: fetched.version, envelopeKind: parsed.envelopeKind };
}

/** Existing destination-first predecessor importer consumes the same raw owner. */
export async function readAccountSettingsV2RawForLegacyAuthoringMemoryImport(params: Parameters<typeof readAccountSettingsV2Raw>[0]): Promise<Readonly<{ raw: AccountSettingsPersistedObject; version: number }>> {
  const { raw, version } = await readAccountSettingsV2Raw(params);
  return { raw, version };
}

/** Bounded owner cutovers replace only their reviewed raw baseline under exact source CAS. */
export async function replaceAccountSettingsV2RawForOwnerCutover(params: Readonly<{
  credentials: StoredCredentials;
  expectedVersion: number;
  raw: AccountSettingsPersistedObject;
  envelopeKind: 'plain' | 'encrypted';
  expectedProfileTransferRevision?: AccountSettingsV2UpdateRequest['expectedProfileTransferRevision'];
  deps?: AccountSettingsUpdateV2Deps;
  signal?: AbortSignal;
}>): Promise<AccountSettingsV2UpdateResponse> {
  params.signal?.throwIfAborted();
  const deps = resolveAccountSettingsV2UpdateDeps(params);
  const mode = await deps.resolveAccountEncryptionMode();
  if ((mode === 'plain') !== (params.envelopeKind === 'plain')) throw new AccountSettingsModeMismatchError();
  const raw = parsePersistedAccountSettingsObject(params.raw);
  const content = sealAccountSettingsV2RawContent({ credentials: params.credentials, raw,
    envelopeKind: params.envelopeKind, randomBytes: deps.randomBytes });
  return await deps.updateSettings(AccountSettingsV2UpdateRequestSchema.parse({ expectedVersion: params.expectedVersion, content,
    ...(params.expectedProfileTransferRevision !== undefined ? { expectedProfileTransferRevision: params.expectedProfileTransferRevision } : {}) }));
}

async function prepareAccountSettingsV2Mutation(params: Readonly<{
  credentials: StoredCredentials;
  content: AccountSettingsStoredContentEnvelope | null;
  application:
    | Readonly<{ kind: 'immutable'; mutation: AccountSettingMutationV1 }>
    | Readonly<{ kind: 'prepared_immutable'; prepareMutation: NonNullable<UpdateAccountSettingsV2OnceAgainstLatestParams['prepareMutation']> }>
    | Readonly<{ kind: 'callback'; mutate: AccountSettingsMutationCallback }>;
  deps: ResolvedAccountSettingsV2UpdateDeps;
  signal?: AbortSignal;
  retireLegacyAuthoringMemoryKey?: LegacyAuthoringMemorySettingsKey;
}>): Promise<Readonly<{
  didChange: boolean;
  content: AccountSettingsStoredContentEnvelope | null;
  raw: AccountSettingsPersistedObject;
  envelopeKind: 'plain' | 'encrypted';
  settings: AccountSettings;
  /** The exact sparse operation submitted; readback must never re-enter its preparation. */
  mutation: AccountSettingMutationV1 | null;
}>> {
  const parsed = await openAccountSettingsV2RawBaseline(params);
  let baselineSettings = parsed.settings;
  let mergedRaw: AccountSettingsPersistedObject;
  let mutation: AccountSettingMutationV1 | null = null;
  if (params.retireLegacyAuthoringMemoryKey) {
    // Retirement is an exact deletion, never a general Settings normalization.
    mergedRaw = { ...parsed.raw };
    delete mergedRaw[params.retireLegacyAuthoringMemoryKey];
  } else if (params.application.kind === 'immutable' || params.application.kind === 'prepared_immutable') {
    mutation = params.application.kind === 'immutable' ? params.application.mutation : await params.application.prepareMutation(parsed.raw);
    const applied = applyAccountSettingMutationV1(parsed.raw, mutation);
    if (applied.status === 'invalid') {
      throw new AccountSettingMutationInvalidError(applied.reason);
    }
    mergedRaw = applied.raw;
  } else {
    baselineSettings ??= accountSettingsParse(parsed.raw);
    mergedRaw = mergeMutationResultWithRawBase({
      rawBase: parsed.raw,
      parsedBase: baselineSettings,
      // A callback may mutate its input in place. Keep the validated baseline
      // separate so changed bytes still receive full canonical validation.
      mutatedRaw: parsePersistedAccountSettingsObject(await params.application.mutate(parsePersistedAccountSettingsObject(parsed.raw))),
    });
  }
  params.signal?.throwIfAborted();
  const nextRaw = params.retireLegacyAuthoringMemoryKey ? mergedRaw : normalizeSettingsSecretsForEnvelope({
    raw: mergedRaw,
    envelopeKind: parsed.envelopeKind,
    credentials: params.credentials,
    randomBytes: params.deps.randomBytes,
  });
  const didChange = !isDeepStrictEqual(nextRaw, parsed.raw);
  const settings = didChange || !baselineSettings ? accountSettingsParse(nextRaw) : baselineSettings;
  if (parsed.envelopeKind === 'plain') {
    assertAccountEncryptionModeAllowedByEffectiveClientRequirement('plain', settings);
  }

  if (!didChange) {
    return Object.freeze({
      didChange: false,
      content: params.content,
      raw: nextRaw,
      envelopeKind: parsed.envelopeKind,
      settings,
      mutation,
    });
  }

  return Object.freeze({
    didChange: true,
    content: sealAccountSettingsV2RawContent({ credentials: params.credentials, raw: nextRaw,
      envelopeKind: parsed.envelopeKind, randomBytes: params.deps.randomBytes }),
    raw: nextRaw,
    envelopeKind: parsed.envelopeKind,
    settings,
    mutation,
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

const profileTransferMismatchResult = Object.freeze({
  status: 'unavailable', retryable: false, reason: 'profile-transfer-mismatch',
} satisfies AccountSettingsMutationResult);

async function settleSubmittedImmutableWrite(params: Readonly<{
  credentials: StoredCredentials;
  deps: ResolvedAccountSettingsV2UpdateDeps;
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
    const isSatisfied = applyAccountSettingMutationV1(parsed.raw, params.mutation).status === 'unchanged';
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
  const application = params.prepareMutation
    ? { kind: 'prepared_immutable' as const, prepareMutation: params.prepareMutation }
    : { kind: 'immutable' as const, mutation: params.mutation };
  const maxAttempts = 3;
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

    const updateRequest = { expectedVersion: version, content: prepared.content,
      ...(params.expectedProfileTransferRevision !== undefined ? { expectedProfileTransferRevision: params.expectedProfileTransferRevision } : {}) };
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
        // Both retrying applications prepare explicit sparse mutations; only the separate
        // one-shot callback application can return null here.
        mutation: prepared.mutation!,
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
    if (response.error === 'profile-transfer-mismatch') return profileTransferMismatchResult;

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
  params: UpdateAccountSettingsV2OnceAgainstLatestParams & Readonly<{
    expectedVersion?: number; retireLegacyAuthoringMemoryKey?: LegacyAuthoringMemorySettingsKey;
  }>,
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
      application: params.prepareMutation
        ? { kind: 'prepared_immutable', prepareMutation: params.prepareMutation }
        : { kind: 'callback', mutate: params.mutate },
      deps,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.retireLegacyAuthoringMemoryKey ? { retireLegacyAuthoringMemoryKey: params.retireLegacyAuthoringMemoryKey } : {}),
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

  const updateRequest = { expectedVersion: fetched.version, content: prepared.content,
    ...(params.expectedProfileTransferRevision !== undefined ? { expectedProfileTransferRevision: params.expectedProfileTransferRevision } : {}) };
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
  if (response.success === false && response.error === 'profile-transfer-mismatch') return profileTransferMismatchResult;
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
