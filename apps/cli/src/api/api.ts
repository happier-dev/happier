import axios from 'axios'
import { z } from 'zod';
import { logger } from '@/ui/logger'
import type {
  AgentState,
  CreateSessionResponse,
  DaemonState,
  Machine,
  MachineMetadata,
  MachineRegistrationIdentity,
  Metadata,
  Session,
} from '@/api/types'
import { MachineRegistrationIdentitySchema } from '@/api/types'
import { ApiSessionClient } from './session/sessionClient';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './client/encryptionKey';
import { openSessionDataEncryptionKey } from './client/openSessionDataEncryptionKey';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { logServerEndpointFailure } from './client/serverEndpointFailureLog';
import { HttpStatusError } from './client/httpStatusError';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import {
  ConnectedServiceAuthGroupGenerationConflictError,
  ConnectedServiceAuthGroupRuntimeStateRevisionConflictError,
  createConnectedServiceCredentialApi,
  type ConnectedServiceAuthGroupApi,
  type ConnectedServiceCredentialApi,
  type ConnectedServiceCredentialPlainResponse,
  type ConnectedServiceCredentialSealedResponse,
} from './connectedServices/connectedServiceCredentialApi';
import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServices/serverApiTimeout';
import {
  ConnectedServiceQuotaApiError,
  createConnectedServiceQuotaApiError,
  createConnectedServiceQuotaHttpStatusError,
  createConnectedServiceQuotaProtocolError,
} from './connectedServices/connectedServiceQuotaApiError';
import {
  shouldTreatGetOrCreateMachineErrorAsOffline,
  shouldTreatGetOrCreateSessionErrorAsOffline,
} from './client/offlineErrors';
import {
  buildProviderAccountUsageRecordId,
  ConnectedServiceAuthGroupErrorResponseV1Schema,
  ConnectedServiceAuthGroupResponseV1Schema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialCompatibleMutationResponseV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceCredentialHealthStatusV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceUsageSourceV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageRecordKeyV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  SealedConnectedServiceQuotaSnapshotV1Schema,
  SealedProviderAccountUsageSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceAuthGroupV1,
  ConnectedServiceAuthGroupRuntimeStatePatchRequestV1,
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialHealthStatusV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ConnectedServiceUsageSourceV1,
  ProviderAccountUsageRecordId,
  ProviderAccountUsageRecordKeyV1,
  ProviderAccountUsageSnapshotV1,
  SealedConnectedServiceCredentialV1,
  SealedConnectedServiceQuotaSnapshotV1,
  SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { createScmConnectedAccountCredentialResolver } from './connectedServices/scmConnectedAccountCredentialResolver';
import { resolveMachineRegistrationIdentity } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';
import { consumeMachineReplacementCandidateAfterRegistration } from '@/daemon/machineIdentity/machineReplacementCandidates';
import { readSessionRuntimeActivityProjectionBoundary } from './session/runtimeActivityProjection';

export {
  ConnectedServiceAuthGroupGenerationConflictError,
  ConnectedServiceAuthGroupRuntimeStateRevisionConflictError,
  ConnectedServiceCredentialUnsupportedFormatError,
} from './connectedServices/connectedServiceCredentialApi';

const CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS = 10_000;
const ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS = 10_000;
const ProviderAccountUsageResponseSourcesSchema = z.array(ConnectedServiceUsageSourceV1Schema).optional();
const ExactProviderAccountUsageSourceResolutionSchema = z.object({
  source: ConnectedServiceUsageSourceV1Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  providerAccountId: z.string().trim().min(1).max(512),
  fetchedAt: z.number().int().nonnegative().nullable(),
  staleAfterMs: z.number().int().nonnegative().nullable(),
}).strict();
const ExactProviderAccountUsageSourceNotFoundSchema = z.object({
  error: z.literal('provider_account_usage_source_not_found'),
}).strict();
const ProviderAccountUsageWriteSourceOutcomeSchema = z.union([
  z.object({ status: z.literal('linked') }).strict(),
  z.object({
    status: z.literal('skipped'),
    reason: z.literal('binding_unavailable'),
  }).strict(),
]).optional();

function parseProviderAccountUsageResponseSources(raw: Readonly<Record<string, unknown>>): ConnectedServiceUsageSourceV1[] | undefined {
  const parsed = ProviderAccountUsageResponseSourcesSchema.safeParse(raw.sources);
  if (!parsed.success) {
    throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response', parsed.error);
  }
  return parsed.data;
}

function isExactConnectedServiceUsageSource(
  actual: ConnectedServiceUsageSourceV1,
  expected: ConnectedServiceUsageSourceV1,
): boolean {
  if (
    actual.serviceId !== expected.serviceId
    || actual.profileId !== expected.profileId
    || actual.bindingKind !== expected.bindingKind
  ) return false;
  if (actual.bindingKind === 'profile') return expected.bindingKind === 'profile';
  return expected.bindingKind === 'group_member'
    && actual.groupId === expected.groupId
    && (actual.groupGeneration ?? null) === (expected.groupGeneration ?? null);
}

function logProviderAccountUsageWriteSourceOutcome(params: Readonly<{
  raw: unknown;
  source: ConnectedServiceUsageSourceV1 | undefined;
  version: 'v2' | 'v3';
}>): void {
  if (!params.source) return;
  if (!params.raw || typeof params.raw !== 'object' || Array.isArray(params.raw)) return;
  const parsed = ProviderAccountUsageWriteSourceOutcomeSchema.safeParse((params.raw as Record<string, unknown>).source);
  if (!parsed.success) {
    logger.debug(`[API] Provider account usage source link outcome invalid (${params.version}) service=${params.source.serviceId} profile=${params.source.profileId}`);
    return;
  }
  if (!parsed.data) return;
  const suffix = parsed.data.status === 'skipped' ? ` reason=${parsed.data.reason}` : '';
  logger.debug(`[API] Provider account usage source link ${parsed.data.status} (${params.version}) service=${params.source.serviceId} profile=${params.source.profileId}${suffix}`);
}

function readRegisteredConnectedServiceProfileId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  for (const value of [record.profileId, record.registeredProfileId]) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  const profile = record.profile;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    const value = (profile as Record<string, unknown>).profileId;
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function logConnectedServiceCredentialRegistration(params: Readonly<{
  serviceId: ConnectedServiceId;
  routeProfileId: string;
  registeredProfileId: string | null;
  version: 'v2' | 'v3';
}>): void {
  const registeredProfileId = params.registeredProfileId ?? params.routeProfileId;
  logger.debug(
    params.version === 'v3'
      ? `[API] Connected service credential registered (v3)`
      : `[API] Connected service credential registered`,
    {
      serviceId: params.serviceId,
      profileId: params.routeProfileId,
      routeProfileId: params.routeProfileId,
      registeredProfileId,
    },
  );
  if (registeredProfileId !== params.routeProfileId) {
    logger.warn('[API] Connected service credential registration profile mismatch', {
      serviceId: params.serviceId,
      routeProfileId: params.routeProfileId,
      registeredProfileId,
    });
  }
}

type ConnectedServiceProfileListResult = Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Array<{
    profileId: string;
    status: ConnectedServiceCredentialHealthStatusV1;
    kind?: 'oauth' | 'token' | null;
    providerEmail?: string | null;
    providerAccountId?: string | null;
    expiresAt?: number | null;
    lastUsedAt?: number | null;
  }>;
}>;

type ConnectedServiceProfileListCacheEntry = Readonly<
  | { kind: 'value'; expiresAtMs: number; value: ConnectedServiceProfileListResult }
  | { kind: 'in_flight'; promise: Promise<ConnectedServiceProfileListResult> }
>;

type AccountEncryptionModeCacheEntry = Readonly<
  | { kind: 'value'; expiresAtMs: number; value: 'e2ee' | 'plain' }
  | { kind: 'in_flight'; promise: Promise<'e2ee' | 'plain' | 'unknown'> }
>;

type ConnectedServiceAuthGroupRuntimeStatePatchInput = Readonly<{
  expectedGeneration?: ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['expectedGeneration'];
  expectedRuntimeStateRevision?: ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['expectedRuntimeStateRevision'];
  state?: ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['state'];
  memberStates?: ReadonlyArray<Readonly<ConnectedServiceAuthGroupRuntimeStatePatchRequestV1['memberStates'][number]>>;
}>;

export class MachineIdConflictError extends Error {
  readonly machineId: string;
  constructor(machineId: string) {
    super(`Machine id conflict: ${machineId} is already registered to a different account on this relay`);
    this.name = 'MachineIdConflictError';
    this.machineId = machineId;
  }
}

export class MachineRevokedError extends Error {
  readonly machineId: string;
  constructor(machineId: string) {
    super(`Machine revoked: ${machineId} is no longer valid on this relay and must be rotated`);
    this.name = 'MachineRevokedError';
    this.machineId = machineId;
  }
}

export class MachineReplacedError extends Error {
  readonly machineId: string;
  readonly replacementMachineId: string | null;
  constructor(machineId: string, replacementMachineId?: string | null) {
    const replacement = typeof replacementMachineId === 'string' && replacementMachineId.trim()
      ? replacementMachineId.trim()
      : null;
    super(
      replacement
        ? `Machine replaced: ${machineId} was replaced by ${replacement}`
        : `Machine replaced: ${machineId} is no longer the current machine identity on this relay`,
    );
    this.name = 'MachineReplacedError';
    this.machineId = machineId;
    this.replacementMachineId = replacement;
  }
}

export class MachineContentPublicKeyMismatchError extends Error {
  readonly machineId: string;
  readonly reason: string;
  constructor(machineId: string, reason: string) {
    super(
      `Machine registration rejected by server (reason=${reason}). ` +
        'This usually means your local encryption key does not match your current account credentials. ' +
        'Try `happier auth logout` then `happier auth login`.',
    );
    this.name = 'MachineContentPublicKeyMismatchError';
    this.machineId = machineId;
    this.reason = reason;
  }
}

export function isMachineIdConflictError(error: unknown): error is MachineIdConflictError {
  // Avoid relying on `instanceof`: bundlers / test runners may load multiple module instances.
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  return maybe.name === 'MachineIdConflictError' && typeof maybe.machineId === 'string' && maybe.machineId.length > 0;
}

export function isMachineRevokedError(error: unknown): error is MachineRevokedError {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  return maybe.name === 'MachineRevokedError' && typeof maybe.machineId === 'string' && maybe.machineId.length > 0;
}

export function isMachineReplacedError(error: unknown): error is MachineReplacedError {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  return (
    maybe.name === 'MachineReplacedError'
    && typeof maybe.machineId === 'string'
    && maybe.machineId.length > 0
    && (
      maybe.replacementMachineId === null
      || typeof maybe.replacementMachineId === 'string'
      || maybe.replacementMachineId === undefined
    )
  );
}

export function isMachineContentPublicKeyMismatchError(error: unknown): error is MachineContentPublicKeyMismatchError {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as Record<string, unknown>;
  return (
    maybe.name === 'MachineContentPublicKeyMismatchError'
    && typeof maybe.machineId === 'string'
    && maybe.machineId.length > 0
    && typeof maybe.reason === 'string'
    && maybe.reason.length > 0
  );
}

function didServerAcknowledgeMachineReplacement(
  data: unknown,
  expectedReplacesMachineId: string,
): boolean {
  const object = typeof data === 'object' && data !== null ? data as Record<string, unknown> : null;
  const replacement = object && typeof object.machineReplacement === 'object' && object.machineReplacement !== null
    ? object.machineReplacement as Record<string, unknown>
    : null;
  if (!replacement) return false;

  const status = replacement.status;
  if (status !== 'applied' && status !== 'alreadyApplied') return false;

  const acknowledgedMachineId = replacement.replacesMachineId ?? replacement.replacedMachineId;
  if (acknowledgedMachineId === undefined || acknowledgedMachineId === null) return true;
  return typeof acknowledgedMachineId === 'string' && acknowledgedMachineId.trim() === expectedReplacesMachineId;
}

function doesMachineRowPointAtReplacement(data: unknown, expectedReplacementMachineId: string): boolean {
  const object = typeof data === 'object' && data !== null ? data as Record<string, unknown> : null;
  const machine = object && typeof object.machine === 'object' && object.machine !== null
    ? object.machine as Record<string, unknown>
    : null;
  return machine?.replacedByMachineId === expectedReplacementMachineId;
}

function readReplacementMachineId(value: unknown): string | null {
  const object = readRecord(value);
  const candidate = object?.replacedByMachineId ?? object?.replacementMachineId;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function readResponseErrorCode(value: unknown): string | null {
  const error = readRecord(value)?.error;
  return typeof error === 'string' ? error : null;
}

function isMachineReplacedResponseErrorCode(error: string | null): boolean {
  return error === 'machine_replaced' || error === 'machine-replaced';
}

function assertConnectedServiceExpectedGeneration(value: unknown, operation: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new Error(`${operation} requires expectedGeneration`);
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;
  private readonly connectedServiceCredentialApi: ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi;
  private readonly connectedServiceProfileListCache = new Map<ConnectedServiceId, ConnectedServiceProfileListCacheEntry>();
  private accountEncryptionModeCache: AccountEncryptionModeCacheEntry | null = null;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.connectedServiceCredentialApi = createConnectedServiceCredentialApi(credential);
    this.pushClient = new PushNotificationClient(credential.token, resolveServerHttpBaseUrl())
  }

  private invalidateConnectedServiceProfileListCache(serviceId?: ConnectedServiceId): void {
    if (serviceId) {
      this.connectedServiceProfileListCache.delete(serviceId);
      return;
    }
    this.connectedServiceProfileListCache.clear();
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session | null> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveSessionEncryptionContext(this.credential);
    const sessionsUrl = `${resolveServerHttpBaseUrl()}/v1/sessions`;

    const serverBaseUrl = resolveServerHttpBaseUrl();
    const { desiredSessionEncryptionMode, serverSupportsFeatureSnapshot } = await resolveSessionCreateEncryptionMode({
      token: this.credential.token,
      serverBaseUrl,
      featuresTimeoutMs: 800,
      accountTimeoutMs: 10_000,
    });

    const resolvePositiveIntEnv = (raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number => {
      const value = (raw ?? '').trim();
      if (!value) return fallback;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
    };

    const retryMaxAttempts = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_MAX_ATTEMPTS, 10, { min: 1, max: 50 });
    const retryBaseDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_BASE_DELAY_MS, 250, { min: 0, max: 30_000 });
    const retryMaxDelayMs = resolvePositiveIntEnv(process.env.HAPPIER_API_CREATE_SESSION_RETRY_MAX_DELAY_MS, 2_000, { min: 0, max: 30_000 });

    const sleep = async (ms: number): Promise<void> => {
      if (ms <= 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    };

    const e2eCreateSessionDelayMs = resolvePositiveIntEnv(
      process.env.HAPPIER_E2E_DELAY_CREATE_SESSION_MS,
      0,
      { min: 0, max: 30_000 },
    );
    if (e2eCreateSessionDelayMs > 0) {
      await sleep(e2eCreateSessionDelayMs);
    }

    // Create session (retry transient 5xx, but do not enter offline mode for 5xx).
    for (let attempt = 1; attempt <= retryMaxAttempts; attempt += 1) {
      try {
        const metadataPayload =
          desiredSessionEncryptionMode === 'plain'
            ? JSON.stringify(opts.metadata)
            : encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata));
        const agentStatePayload =
          desiredSessionEncryptionMode === 'plain'
            ? (opts.state ? JSON.stringify(opts.state) : null)
            : (opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null);

        const response = await axios.post<CreateSessionResponse>(
          sessionsUrl,
          {
            tag: opts.tag,
            metadata: metadataPayload,
            agentState: agentStatePayload,
            dataEncryptionKey:
              desiredSessionEncryptionMode === 'plain'
                ? null
                : dataEncryptionKey
                  ? encodeBase64(dataEncryptionKey)
                  : null,
            ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
          },
          {
            headers: {
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json',
            },
            timeout: 60000 // 1 minute timeout for very bad network connections
          }
        )

        logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
        let raw = response.data.session;

      const sessionEncryptionMode: 'e2ee' | 'plain' =
        (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';

      // Prefer the session's published data key, but keep backward compatibility with
      // older sessions that have no dataEncryptionKey (machineKey-as-session-key fallback).
      let sessionEncryptionKey = encryptionKey;
      if (sessionEncryptionMode === 'e2ee' && this.credential.encryption.type === 'dataKey') {
        const serverEncryptedDataKeyRaw = (raw as any).dataEncryptionKey;
        const opened = openSessionDataEncryptionKey({
          credential: this.credential,
          encryptedDataEncryptionKeyBase64: serverEncryptedDataKeyRaw,
        });
        if (typeof serverEncryptedDataKeyRaw === 'string' && serverEncryptedDataKeyRaw.trim().length > 0 && !opened) {
          logger.debug('[API] Failed to open session dataEncryptionKey (dataKey account)', {
            sessionId: raw.id,
          });
          throw new Error('Failed to open session dataEncryptionKey');
        }
        sessionEncryptionKey = opened ?? this.credential.encryption.machineKey;
      }

	      const metadata =
	        sessionEncryptionMode === 'plain'
	          ? JSON.parse(String(raw.metadata ?? 'null'))
	          : decrypt(sessionEncryptionKey, encryptionVariant, decodeBase64(raw.metadata));
	      const agentState =
	        !raw.agentState
	          ? null
	          : sessionEncryptionMode === 'plain'
	            ? JSON.parse(String(raw.agentState))
	            : decrypt(sessionEncryptionKey, encryptionVariant, decodeBase64(raw.agentState));

	      if (sessionEncryptionMode === 'plain') {
	        return {
	          id: raw.id,
	          seq: raw.seq,
	          ...readSessionRuntimeActivityProjectionBoundary(raw),
	          encryptionMode: 'plain' as const,
	          metadata,
	          metadataVersion: raw.metadataVersion,
	          agentState,
	          agentStateVersion: raw.agentStateVersion,
	        };
	      }

	      return {
	        id: raw.id,
	        seq: raw.seq,
	        ...readSessionRuntimeActivityProjectionBoundary(raw),
	        encryptionMode: 'e2ee' as const,
	        encryptionKey: sessionEncryptionKey,
	        encryptionVariant,
	        metadata,
	        metadataVersion: raw.metadataVersion,
	        agentState,
	        agentStateVersion: raw.agentStateVersion,
	      };
	      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        const isRetryable5xx = typeof status === 'number' && status >= 500 && status < 600;
        if (isRetryable5xx && attempt < retryMaxAttempts) {
          // Do not log raw Axios errors: they can contain bearer tokens or vendor keys.
          logger.debug('[API] [WARN] getOrCreateSession transient server error, retrying:', serializeAxiosErrorForLog(error));
          const delayMs = Math.min(retryMaxDelayMs, retryBaseDelayMs * Math.pow(2, attempt - 1));
          await sleep(delayMs);
          continue;
        }

        // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
        logger.debug('[API] [ERROR] Failed to get or create session:', serializeAxiosErrorForLog(error));

        const terminalAuthStatus = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (terminalAuthStatus === 401 || terminalAuthStatus === 403) {
          // Preserve status for offline reconnection stop conditions without leaking request config.
          throw new HttpStatusError(terminalAuthStatus, 'Authentication failed');
        }

        if (shouldTreatGetOrCreateSessionErrorAsOffline(error, { url: sessionsUrl })) {
          return null;
        }

        throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Unreachable (retryMaxAttempts is min 1); keep TS happy.
    return null;
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
    timeoutMs?: number,
    registrationIdentity?: MachineRegistrationIdentity,
  }): Promise<Machine> {
    const { encryptionKey, encryptionVariant, dataEncryptionKey } = resolveMachineEncryptionContext(this.credential);
    const registrationIdentity = opts.registrationIdentity
      ? MachineRegistrationIdentitySchema.parse(opts.registrationIdentity)
      : await this.resolveMachineRegistrationIdentity(opts.machineId);
    const machinesUrl = `${resolveServerHttpBaseUrl()}/v1/machines`;

    // Create machine
    try {
      const timeoutMs =
        typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
          ? Math.floor(opts.timeoutMs)
          : 60_000;
      const response = await axios.post(
        machinesUrl,
        {
          id: opts.machineId,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined,
          contentPublicKey:
            this.credential.encryption.type === 'dataKey'
              ? encodeBase64(this.credential.encryption.publicKey)
              : undefined,
          ...(registrationIdentity
            ? {
                installationId: registrationIdentity.installationId,
                installationPublicKey: registrationIdentity.installationPublicKey,
                installationProof: registrationIdentity.installationProof,
                replacesMachineId: registrationIdentity.replacesMachineId,
                replacementReason: registrationIdentity.replacementReason,
                contentPublicKeyFingerprint: registrationIdentity.contentPublicKeyFingerprint,
              }
            : null),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: timeoutMs
        }
      );


      const raw = response.data.machine;
      const replacementMachineId = readReplacementMachineId(raw);
      if (replacementMachineId) {
        throw new MachineReplacedError(opts.machineId, replacementMachineId);
      }
      logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);
      const didAcknowledgeReplacement = registrationIdentity?.replacesMachineId
        ? didServerAcknowledgeMachineReplacement(response.data, registrationIdentity.replacesMachineId)
          || await this.didServerAlreadyApplyMachineReplacement({
            replacesMachineId: registrationIdentity.replacesMachineId,
            replacementMachineId: opts.machineId,
            timeoutMs,
          })
        : false;
      if (
        registrationIdentity?.replacementCandidateAccountId
        && registrationIdentity.replacesMachineId
        && didAcknowledgeReplacement
      ) {
        await consumeMachineReplacementCandidateAfterRegistration({
          accountId: registrationIdentity.replacementCandidateAccountId,
          didRegister: true,
          replacesMachineId: registrationIdentity.replacesMachineId,
        });
      }

      // Return decrypted machine like we do for sessions
      const machine: Machine = {
        id: raw.id,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
      };
      return machine;
    } catch (error) {
      if (
        axios.isAxiosError(error)
        && error.response?.status === 409
        && readResponseErrorCode(error.response.data) === 'machine_id_conflict'
      ) {
        throw new MachineIdConflictError(opts.machineId);
      }

      if (
        axios.isAxiosError(error)
        && error.response?.status === 410
        && readResponseErrorCode(error.response.data) === 'machine_revoked'
      ) {
        throw new MachineRevokedError(opts.machineId);
      }

      if (
        axios.isAxiosError(error)
        && error.response?.status === 410
        && isMachineReplacedResponseErrorCode(readResponseErrorCode(error.response.data))
      ) {
        throw new MachineReplacedError(opts.machineId, readReplacementMachineId(error.response.data));
      }

      if (axios.isAxiosError(error) && error.response?.status === 400) {
        const body = readRecord(error.response.data);
        const reason = typeof body?.reason === 'string' ? body.reason : '';
        if (body?.error === 'invalid-params' && reason === 'content_public_key_mismatch') {
          // Do not retry: this indicates a credentials/key mismatch, not a transient network failure.
          throw new MachineContentPublicKeyMismatchError(opts.machineId, reason);
        }
      }

      if (shouldTreatGetOrCreateMachineErrorAsOffline(error, { url: machinesUrl })) {
        // Fail closed: callers must not treat a registration failure as a usable machine identity.
        throw error;
      }

      // For other errors, rethrow
      throw error;
    }
  }

  private async resolveMachineRegistrationIdentity(machineId: string): Promise<MachineRegistrationIdentity | undefined> {
    if (!configuration.installationIdentityFile) return undefined;
    const identity = await resolveMachineRegistrationIdentity({
      machineId,
      token: this.credential.token,
      contentPublicKey: this.credential.encryption.type === 'dataKey'
        ? this.credential.encryption.publicKey
        : undefined,
    });
    return {
      installationId: identity.installationId,
      installationPublicKey: identity.installationPublicKey,
      installationProof: identity.installationProof,
      ...(identity.replacesMachineId ? { replacesMachineId: identity.replacesMachineId } : null),
      ...(identity.replacementReason ? { replacementReason: identity.replacementReason } : null),
      ...(identity.contentPublicKeyFingerprint ? { contentPublicKeyFingerprint: identity.contentPublicKeyFingerprint } : null),
      ...(identity.replacementCandidateAccountId ? { replacementCandidateAccountId: identity.replacementCandidateAccountId } : null),
    };
  }

  private async didServerAlreadyApplyMachineReplacement(opts: Readonly<{
    replacesMachineId: string;
    replacementMachineId: string;
    timeoutMs: number;
  }>): Promise<boolean> {
    try {
      const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(opts.replacesMachineId)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: opts.timeoutMs,
        },
      );
      return doesMachineRowPointAtReplacement(response.data, opts.replacementMachineId);
    } catch {
      return false;
    }
  }

  sessionSyncClient(
    session: Session,
    runtimeActivity?: import('./session/sessionClient').SessionRuntimeActivityClientConfig,
  ): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session, runtimeActivity);
  }

  machineSyncClient(
    machine: Machine,
    ownershipMetadata?: Readonly<{
      runtimeId?: string;
      cliVersion?: string;
      publicReleaseChannel?: string;
      startupSource?: string;
      serviceManaged?: boolean;
      serviceLabel?: string;
    }>,
  ): ApiMachineClient {
    return new ApiMachineClient(this.credential.token, machine, ownershipMetadata, {
      connectedAccounts: this.createConnectedAccountCredentialResolver(),
    });
  }

  private createConnectedAccountCredentialResolver() {
    return createScmConnectedAccountCredentialResolver({
      credentials: this.credential,
      api: this,
    });
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    try {
      const response = await axios.post(
        `${serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs()
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register vendor token',
        error,
      });
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register a sealed connected service credential (v2).
   *
   * The server stores the ciphertext as-is and only keeps non-secret metadata for UX.
   */
  async registerConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
    };
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    refreshLeaseOwnerId?: string;
  }): Promise<import('@happier-dev/protocol').ConnectedServiceCredentialCompatibleMutationResponseV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          sealed: params.sealed,
          ...(params.metadata ? { metadata: params.metadata } : {}),
          ...(params.expectedCredentialRevision !== undefined ? { expectedCredentialRevision: params.expectedCredentialRevision } : {}),
          ...(params.refreshLeaseOwnerId ? { refreshLeaseOwnerId: params.refreshLeaseOwnerId } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const parsed = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(response.data);
      if (!parsed.success) throw new Error('Invalid connected service credential mutation response');
      this.invalidateConnectedServiceProfileListCache(params.serviceId);
      logConnectedServiceCredentialRegistration({
        serviceId: params.serviceId,
        routeProfileId: params.profileId,
        registeredProfileId: readRegisteredConnectedServiceProfileId(response.data),
        version: 'v2',
      });
      return parsed.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const superseded = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(error.response.data);
        if (superseded.success && 'error' in superseded.data) return superseded.data;
      }
      // Never log raw Axios errors: they can contain bearer tokens or provider secrets.
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register connected service credential',
        error,
      });
      if (axios.isAxiosError(error) && typeof error.response?.status === 'number') {
        throw new HttpStatusError(error.response.status, `Failed to register connected service credential (status ${error.response.status})`);
      }
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }): Promise<ConnectedServiceCredentialSealedResponse | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceCredentialSealed(params);
  }

  async listConnectedServiceProfiles(params: {
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }): Promise<ConnectedServiceProfileListResult> {
    const cached = this.connectedServiceProfileListCache.get(params.serviceId);
    const nowMs = Date.now();
    if (!params.forceRefresh) {
      if (cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
      if (cached?.kind === 'in_flight') return await cached.promise;
    }

    const promise = this.fetchConnectedServiceProfilesFromServer(params);
    this.connectedServiceProfileListCache.set(params.serviceId, { kind: 'in_flight', promise });
    try {
      const value = await promise;
      this.connectedServiceProfileListCache.set(params.serviceId, {
        kind: 'value',
        value,
        expiresAtMs: Date.now() + CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS,
      });
      return value;
    } catch (error) {
      const latest = this.connectedServiceProfileListCache.get(params.serviceId);
      if (latest?.kind === 'in_flight' && latest.promise === promise) {
        this.connectedServiceProfileListCache.delete(params.serviceId);
      }
      throw error;
    }
  }

  private async fetchConnectedServiceProfilesFromServer(params: {
    serviceId: ConnectedServiceId;
  }): Promise<ConnectedServiceProfileListResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const response = await axios.get(
      `${serverUrl}/v2/connect/${serviceId}/profiles`,
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const raw = response.data;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid connected service profiles response');
    }

    const serviceIdParsed = ConnectedServiceIdSchema.safeParse((raw as any).serviceId);
    if (!serviceIdParsed.success) {
      throw new Error('Invalid connected service profiles response');
    }

    const profilesParsed = z.array(
      z.object({
        profileId: z.string().min(1),
        status: ConnectedServiceCredentialHealthStatusV1Schema,
        kind: z.enum(['oauth', 'token']).nullable().optional(),
        providerEmail: z.string().nullable().optional(),
        providerAccountId: z.string().nullable().optional(),
        expiresAt: z.number().nullable().optional(),
        lastUsedAt: z.number().nullable().optional(),
      }),
    ).safeParse((raw as any).profiles);

    if (!profilesParsed.success) {
      throw new Error('Invalid connected service profiles response');
    }

    return { serviceId: serviceIdParsed.data, profiles: profilesParsed.data };
  }

  async getConnectedServiceAuthGroup(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    signal?: AbortSignal;
  }): Promise<ConnectedServiceAuthGroupV1 | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceAuthGroup(params);
  }

  async listConnectedServiceAuthGroups(params: {
    serviceId: ConnectedServiceId;
  }): Promise<readonly ConnectedServiceAuthGroupV1[]> {
    return await this.connectedServiceCredentialApi.listConnectedServiceAuthGroups(params);
  }

  async updateConnectedServiceAuthGroupActiveProfile(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration: number;
    overrideRuntimeCooldown?: boolean;
  }): Promise<ConnectedServiceAuthGroupV1> {
    const expectedGeneration = assertConnectedServiceExpectedGeneration(
      params.expectedGeneration,
      'Connected service auth group active-profile update',
    );
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/active-profile`,
        {
          profileId: params.activeProfileId,
          expectedGeneration,
          ...(params.overrideRuntimeCooldown === true ? { overrideRuntimeCooldown: true } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group response');
      }
      return parsed.data.group;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service auth group active profile',
        error,
      });
      throw new Error(`Failed to update connected service auth group active profile: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateConnectedServiceAuthGroupRuntimeState(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
  } & ConnectedServiceAuthGroupRuntimeStatePatchInput): Promise<ConnectedServiceAuthGroupV1> {
    const memberStates = params.memberStates ?? [];
    const mutatesRuntimeState = params.state !== undefined || memberStates.length > 0;
    const expectedGeneration = params.expectedGeneration === undefined
      ? undefined
      : assertConnectedServiceExpectedGeneration(
        params.expectedGeneration,
        'Connected service auth group runtime-state update',
      );
    if (mutatesRuntimeState && expectedGeneration === undefined) {
      throw new Error('Connected service auth group runtime-state update requires expectedGeneration');
    }
    const expectedRuntimeStateRevision = params.expectedRuntimeStateRevision;
    if (mutatesRuntimeState && expectedRuntimeStateRevision === undefined) {
      throw new Error('Connected service auth group runtime-state update requires expectedRuntimeStateRevision');
    }
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.patch(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/runtime-state`,
        {
          ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
          ...(expectedRuntimeStateRevision === undefined ? {} : { expectedRuntimeStateRevision }),
          ...(params.state === undefined ? {} : { state: params.state }),
          memberStates,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group response');
      }
      return parsed.data.group;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
        if (
          parsed.success
          && parsed.data.error === 'connect_group_runtime_state_revision_conflict'
          && parsed.data.runtimeStateRevision !== undefined
        ) {
          throw new ConnectedServiceAuthGroupRuntimeStateRevisionConflictError(parsed.data.runtimeStateRevision);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service auth group runtime state',
        error,
      });
      throw new Error(`Failed to update connected service auth group runtime state: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async createConnectedServiceAuthGroupMember(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    priority?: number;
    enabled?: boolean;
    expectedGeneration: number;
  }): Promise<ConnectedServiceAuthGroupV1> {
    const expectedGeneration = assertConnectedServiceExpectedGeneration(
      params.expectedGeneration,
      'Connected service auth group member create',
    );
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/members`,
        {
          profileId: params.profileId,
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
          expectedGeneration,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group response');
      }
      return parsed.data.group;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to create connected service auth group member',
        error,
      });
      throw new Error(`Failed to create connected service auth group member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateConnectedServiceAuthGroupMember(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    priority?: number;
    enabled?: boolean;
    expectedGeneration: number;
  }): Promise<ConnectedServiceAuthGroupV1> {
    const expectedGeneration = assertConnectedServiceExpectedGeneration(
      params.expectedGeneration,
      'Connected service auth group member update',
    );
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.patch(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/members/${profileId}`,
        {
          ...(params.priority === undefined ? {} : { priority: params.priority }),
          ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
          expectedGeneration,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group response');
      }
      return parsed.data.group;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service auth group member',
        error,
      });
      throw new Error(`Failed to update connected service auth group member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteConnectedServiceAuthGroupMember(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    expectedGeneration: number;
  }): Promise<ConnectedServiceAuthGroupV1> {
    const expectedGeneration = assertConnectedServiceExpectedGeneration(
      params.expectedGeneration,
      'Connected service auth group member delete',
    );
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.delete(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/members/${profileId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          params: { expectedGeneration },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceAuthGroupResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group response');
      }
      return parsed.data.group;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to delete connected service auth group member',
        error,
      });
      throw new Error(`Failed to delete connected service auth group member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getAccountEncryptionMode(options?: Readonly<{
    refresh?: boolean;
    signal?: AbortSignal;
  }>): Promise<'e2ee' | 'plain' | 'unknown'> {
    if (options?.signal) {
      return await this.fetchAccountEncryptionModeFromServer(options.signal);
    }
    const cached = this.accountEncryptionModeCache;
    const nowMs = Date.now();
    if (!options?.refresh && cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
    if (cached?.kind === 'in_flight') return await cached.promise;

    const promise = this.fetchAccountEncryptionModeFromServer();
    this.accountEncryptionModeCache = { kind: 'in_flight', promise };
    try {
      const value = await promise;
      if (this.accountEncryptionModeCache?.kind === 'in_flight' && this.accountEncryptionModeCache.promise === promise) {
        this.accountEncryptionModeCache = value === 'unknown'
          ? null
          : { kind: 'value', value, expiresAtMs: Date.now() + ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS };
      }
      return value;
    } catch (error) {
      if (this.accountEncryptionModeCache?.kind === 'in_flight' && this.accountEncryptionModeCache.promise === promise) {
        this.accountEncryptionModeCache = null;
      }
      throw error;
    }
  }

  async getAccountEncryptionModeUncached(options?: Readonly<{ signal?: AbortSignal }>): Promise<'e2ee' | 'plain' | 'unknown'> {
    return await this.fetchAccountEncryptionModeFromServer(options?.signal);
  }

  private async fetchAccountEncryptionModeFromServer(signal?: AbortSignal): Promise<'e2ee' | 'plain' | 'unknown'> {
    return await this.connectedServiceCredentialApi.getAccountEncryptionMode?.({ signal }) ?? 'e2ee';
  }

  async getConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }): Promise<ConnectedServiceCredentialPlainResponse | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceCredentialPlain?.(params) ?? null;
  }

  async registerConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    refreshLeaseOwnerId?: string;
  }): Promise<import('@happier-dev/protocol').ConnectedServiceCredentialCompatibleMutationResponseV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          content: params.content,
          ...(params.expectedCredentialRevision !== undefined ? { expectedCredentialRevision: params.expectedCredentialRevision } : {}),
          ...(params.refreshLeaseOwnerId ? { refreshLeaseOwnerId: params.refreshLeaseOwnerId } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const parsed = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(response.data);
      if (!parsed.success) throw new Error('Invalid connected service credential mutation response');
      this.invalidateConnectedServiceProfileListCache(params.serviceId);
      logConnectedServiceCredentialRegistration({
        serviceId: params.serviceId,
        routeProfileId: params.profileId,
        registeredProfileId: readRegisteredConnectedServiceProfileId(response.data),
        version: 'v3',
      });
      return parsed.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const superseded = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(error.response.data);
        if (superseded.success && 'error' in superseded.data) return superseded.data;
      }
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register connected service credential',
        error,
      });
      if (axios.isAxiosError(error) && typeof error.response?.status === 'number') {
        throw new HttpStatusError(error.response.status, `Failed to register connected service credential (status ${error.response.status})`);
      }
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateConnectedServiceCredentialHealth(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
    expectedCredentialRevision?: string;
  }): Promise<import('@happier-dev/protocol').ConnectedServiceCredentialCompatibleMutationResponseV1> {
    const healthParsed = ConnectedServiceCredentialHealthV1Schema.safeParse(params.health);
    if (!healthParsed.success) {
      throw new Error('Invalid connected service credential health');
    }

    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    try {
      const response = await axios.patch(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential/health`,
        { health: healthParsed.data, ...(params.expectedCredentialRevision ? { expectedCredentialRevision: params.expectedCredentialRevision } : {}) },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const parsed = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(response.data);
      if (!parsed.success) throw new Error('Invalid connected service credential mutation response');
      this.invalidateConnectedServiceProfileListCache(params.serviceId);
      return parsed.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const superseded = ConnectedServiceCredentialCompatibleMutationResponseV1Schema.safeParse(error.response.data);
        if (superseded.success && 'error' in superseded.data) return superseded.data;
      }
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service credential health',
        error,
      });
      throw new Error(`Failed to update connected service credential health: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async registerProviderAccountUsageSnapshotSealed(params: {
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    source?: ConnectedServiceUsageSourceV1;
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const parsedRecordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);
    const recordKey = ProviderAccountUsageRecordKeyV1Schema.parse(params.recordKey);
    if (buildProviderAccountUsageRecordId(recordKey) !== parsedRecordId) {
      throw createConnectedServiceQuotaProtocolError('Provider account usage record key does not match record id');
    }
    const recordId = encodeURIComponent(parsedRecordId);
    const sealed = SealedProviderAccountUsageSnapshotV1Schema.parse(params.sealed);
    const source = params.source ? ConnectedServiceUsageSourceV1Schema.parse(params.source) : undefined;

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/provider-account-usage/${recordId}`,
        {
          recordKey,
          sealed,
          metadata: params.metadata,
          ...(source ? { source } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Provider account usage snapshot write failed with status ${response.status}`,
        });
      }
      logProviderAccountUsageWriteSourceOutcome({
        raw: response.data,
        source,
        version: 'v2',
      });
    } catch (error) {
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register provider account usage snapshot',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to register provider account usage snapshot',
        cause: error,
      });
    }
  }

  async getProviderAccountUsageSnapshotSealed(params: {
    recordId: ProviderAccountUsageRecordId;
  }): Promise<{
    sealed: SealedProviderAccountUsageSnapshotV1;
    sources?: ConnectedServiceUsageSourceV1[];
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = encodeURIComponent(ProviderAccountUsageRecordIdSchema.parse(params.recordId));

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/provider-account-usage/${recordId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Provider account usage snapshot read failed with status ${response.status}`,
        });
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }
      const rawRecord = raw as Record<string, unknown>;

      const sealedParsed = SealedProviderAccountUsageSnapshotV1Schema.safeParse(rawRecord.sealed);
      if (!sealedParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response', sealedParsed.error);
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
      }).safeParse(rawRecord.metadata);
      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response', metadataParsed.error);
      }
      const sources = parseProviderAccountUsageResponseSources(rawRecord);

      return {
        sealed: sealedParsed.data,
        metadata: metadataParsed.data,
        ...(sources !== undefined ? { sources } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof ConnectedServiceQuotaApiError) {
        logServerEndpointFailure({
          logger,
          operation: 'Failed to get provider account usage snapshot',
          error,
        });
        throw error;
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logServerEndpointFailure({
        logger,
        operation: 'Failed to get provider account usage snapshot',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get provider account usage snapshot',
        cause: error,
      });
    }
  }

  async getConnectedServiceQuotaSnapshotSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }): Promise<{
    sealed: SealedConnectedServiceQuotaSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          signal: params.signal,
        },
      );
      if (response.status !== 200) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Connected service quota snapshot read failed with status ${response.status}`,
        });
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response');
      }

      const sealedParsed = SealedConnectedServiceQuotaSnapshotV1Schema.safeParse((raw as any).sealed);
      if (!sealedParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response', sealedParsed.error);
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response', metadataParsed.error);
      }

      return { sealed: sealedParsed.data, metadata: metadataParsed.data };
    } catch (error: unknown) {
      if (error instanceof ConnectedServiceQuotaApiError) {
        logServerEndpointFailure({
          logger,
          operation: 'Failed to get connected service quota snapshot',
          error,
        });
        throw error;
      }
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logServerEndpointFailure({
        logger,
        operation: 'Failed to get connected service quota snapshot',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get connected service quota snapshot',
        cause: error,
      });
    }
  }

  async registerProviderAccountUsageSnapshotPlain(params: {
    recordId: ProviderAccountUsageRecordId;
    source?: ConnectedServiceUsageSourceV1;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse(params.content.v);
    const source = params.source ? ConnectedServiceUsageSourceV1Schema.parse(params.source) : undefined;

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/provider-account-usage/${encodeURIComponent(recordId)}`,
        {
          content: { t: 'plain', v: snapshot },
          metadata: params.metadata,
          ...(source ? { source } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Provider account usage snapshot write failed with status ${response.status}`,
        });
      }
      logProviderAccountUsageWriteSourceOutcome({
        raw: response.data,
        source,
        version: 'v3',
      });
    } catch (error) {
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register provider account usage snapshot (v3)',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to register provider account usage snapshot',
        cause: error,
      });
    }
  }

  async resolveProviderAccountUsageSource(params: {
    source: ConnectedServiceUsageSourceV1;
  }): Promise<z.infer<typeof ExactProviderAccountUsageSourceResolutionSchema> | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const source = ConnectedServiceUsageSourceV1Schema.parse(params.source);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/provider-account-usage/sources/resolve`,
        {
          params: source,
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Provider account usage source resolution failed with status ${response.status}`,
        });
      }
      const parsed = ExactProviderAccountUsageSourceResolutionSchema.safeParse(response.data);
      if (!parsed.success) {
        throw createConnectedServiceQuotaProtocolError(
          'Invalid provider account usage source resolution response',
          parsed.error,
        );
      }
      if (!isExactConnectedServiceUsageSource(parsed.data.source, source)) {
        throw createConnectedServiceQuotaProtocolError(
          'Provider account usage source resolution returned a different source',
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof ConnectedServiceQuotaApiError) {
        logServerEndpointFailure({
          logger,
          operation: 'Failed to resolve provider account usage source',
          error,
        });
        throw error;
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (
        status === 404
        && ExactProviderAccountUsageSourceNotFoundSchema.safeParse(
          axios.isAxiosError(error) ? error.response?.data : undefined,
        ).success
      ) return null;
      logServerEndpointFailure({
        logger,
        operation: 'Failed to resolve provider account usage source',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to resolve provider account usage source',
        cause: error,
      });
    }
  }

  async getProviderAccountUsageSnapshotPlain(params: {
    recordId: ProviderAccountUsageRecordId;
  }): Promise<{
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    sources?: ConnectedServiceUsageSourceV1[];
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = ProviderAccountUsageRecordIdSchema.parse(params.recordId);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/provider-account-usage/${encodeURIComponent(recordId)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      if (response.status !== 200) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Provider account usage snapshot read failed with status ${response.status}`,
        });
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }
      const rawRecord = raw as Record<string, unknown>;

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse(rawRecord.content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
        throw createConnectedServiceQuotaProtocolError(
          'Invalid provider account usage snapshot response',
          contentParsed.success ? undefined : contentParsed.error,
        );
      }

      const snapshotParsed = ProviderAccountUsageSnapshotV1Schema.safeParse(contentParsed.data.v);
      if (!snapshotParsed.success || snapshotParsed.data.recordId !== recordId) {
        throw createConnectedServiceQuotaProtocolError(
          'Invalid provider account usage snapshot response',
          snapshotParsed.success ? undefined : snapshotParsed.error,
        );
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
      }).safeParse(rawRecord.metadata);
      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response', metadataParsed.error);
      }
      const sources = parseProviderAccountUsageResponseSources(rawRecord);

      return {
        content: { t: 'plain', v: snapshotParsed.data },
        metadata: metadataParsed.data,
        ...(sources !== undefined ? { sources } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof ConnectedServiceQuotaApiError) {
        logServerEndpointFailure({
          logger,
          operation: 'Failed to get provider account usage snapshot (v3)',
          error,
        });
        throw error;
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logServerEndpointFailure({
        logger,
        operation: 'Failed to get provider account usage snapshot (v3)',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get provider account usage snapshot',
        cause: error,
      });
    }
  }

  async getConnectedServiceQuotaSnapshotPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
  }): Promise<{
    content: { t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          signal: params.signal,
        },
      );
      if (response.status !== 200) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Connected service quota snapshot read failed with status ${response.status}`,
        });
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response');
      }

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as any).content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
        throw createConnectedServiceQuotaProtocolError(
          'Invalid connected service quota snapshot response',
          contentParsed.success ? undefined : contentParsed.error,
        );
      }

      const snapshotParsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(contentParsed.data.v);
      if (!snapshotParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response', snapshotParsed.error);
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response', metadataParsed.error);
      }

      return { content: { t: 'plain', v: snapshotParsed.data }, metadata: metadataParsed.data };
    } catch (error: unknown) {
      if (error instanceof ConnectedServiceQuotaApiError) {
        logServerEndpointFailure({
          logger,
          operation: 'Failed to get connected service quota snapshot (v3)',
          error,
        });
        throw error;
      }
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        const parsed = ConnectedServiceAuthGroupErrorResponseV1Schema.safeParse(error.response.data);
        if (parsed.success && parsed.data.error === 'connect_group_generation_conflict' && parsed.data.generation !== undefined) {
          throw new ConnectedServiceAuthGroupGenerationConflictError(parsed.data.generation);
        }
      }
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logServerEndpointFailure({
        logger,
        operation: 'Failed to get connected service quota snapshot (v3)',
        error,
      });
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get connected service quota snapshot',
        cause: error,
      });
    }
  }

  async acquireConnectedServiceRefreshLease(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
    expectedCredentialRevision?: string;
  }): Promise<{ acquired: boolean; leaseUntil: number; ownerId: string; credentialRevision: string }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const response = await axios.post(
      `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/refresh-lease`,
      {
        machineId: params.machineId,
        ...(params.ownerId ? { ownerId: params.ownerId } : {}),
        leaseMs: params.leaseMs,
        ...(params.expectedCredentialRevision ? { expectedCredentialRevision: params.expectedCredentialRevision } : {}),
      },
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: resolveConnectedServicesServerApiTimeoutMs(),
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const schema = z.object({
      acquired: z.boolean(),
      leaseUntil: z.number(),
      credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
      ownerId: z.string().trim().min(1),
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service refresh lease response');
    }
    return parsed.data;
  }
}
