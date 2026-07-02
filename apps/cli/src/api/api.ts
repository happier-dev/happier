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
import { resolveLoopbackHttpUrl } from './client/loopbackUrl';
import { openSessionDataEncryptionKey } from './client/openSessionDataEncryptionKey';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { createHttpStatusError, HttpStatusError } from './client/httpStatusError';
import {
  createConnectedServiceQuotaApiError,
  createConnectedServiceQuotaHttpStatusError,
  createConnectedServiceQuotaProtocolError,
} from './connectedServices/connectedServiceQuotaApiError';
import {
  shouldTreatGetOrCreateMachineErrorAsOffline,
  shouldTreatGetOrCreateSessionErrorAsOffline,
} from './client/offlineErrors';
import {
  MachineContentPublicKeyMismatchError,
  MachineIdConflictError,
  MachineReplacedError,
  MachineRevokedError,
} from './machine/machineRegistrationErrors';
export {
  MachineContentPublicKeyMismatchError,
  MachineIdConflictError,
  MachineReplacedError,
  MachineRevokedError,
  isMachineContentPublicKeyMismatchError,
  isMachineIdConflictError,
  isMachineReplacedError,
  isMachineRevokedError,
} from './machine/machineRegistrationErrors';
import {
  AccountEncryptionModeResponseSchema,
  ConnectedServiceAuthGroupResponseV1Schema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialRecordV1Schema,
  ConnectedServiceIdSchema,
  ConnectedServiceQuotaSnapshotV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  SealedConnectedServiceCredentialV1Schema,
  SealedConnectedServiceQuotaSnapshotV1Schema,
  SealedProviderAccountUsageSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceAuthGroupV1,
  ConnectedServiceAuthGroupRuntimeStatePatchRequestV1,
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageRecordId,
  ProviderAccountUsageSnapshotV1,
  SealedConnectedServiceCredentialV1,
  SealedConnectedServiceQuotaSnapshotV1,
  SealedProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { consumeMachineReplacementCandidateAfterRegistration } from '@/daemon/machineIdentity/machineReplacementCandidates';
import { resolveMachineRegistrationIdentity } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';

const CONNECTED_SERVICE_PROFILE_LIST_CACHE_TTL_MS = 10_000;
const ACCOUNT_ENCRYPTION_MODE_CACHE_TTL_MS = 10_000;

type ConnectedServiceProfileHealthStatus =
  | 'connected'
  | 'refreshing'
  | 'needs_reauth'
  | 'refresh_failed_retryable';

type ConnectedServiceProfileListResult = Readonly<{
  serviceId: ConnectedServiceId;
  profiles: Array<{
    profileId: string;
    status: ConnectedServiceProfileHealthStatus;
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

export class ConnectedServiceCredentialUnsupportedFormatError extends Error {
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;
  constructor(serviceId: ConnectedServiceId, profileId: string) {
    super(`Connected service credential is in an unsupported legacy format (${serviceId}/${profileId}). Reconnect it in Happier.`);
    this.name = 'ConnectedServiceCredentialUnsupportedFormatError';
    this.serviceId = serviceId;
    this.profileId = profileId;
  }
}

export class ConnectedServiceAuthGroupGenerationConflictError extends Error {
  readonly generation: number;

  constructor(generation: number) {
    super('connected_service_auth_group_generation_conflict');
    this.name = 'ConnectedServiceAuthGroupGenerationConflictError';
    this.generation = generation;
  }
}

function readConnectedServiceAuthGroupGenerationConflict(error: unknown): number | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data: unknown = error.response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.error !== 'connect_group_generation_conflict') return null;
  const generation = record.generation;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return null;
  return generation;
}

function throwConnectedServiceAuthGroupGenerationConflictIfPresent(error: unknown): void {
  const generation = readConnectedServiceAuthGroupGenerationConflict(error);
  if (generation !== null) {
    throw new ConnectedServiceAuthGroupGenerationConflictError(generation);
  }
}

function resolveServerHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
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

function doesMachineRowPointAtReplacement(
  data: unknown,
  expectedMachineId: string,
): boolean {
  const object = typeof data === 'object' && data !== null ? data as Record<string, unknown> : null;
  const machine = object && typeof object.machine === 'object' && object.machine !== null
    ? object.machine as Record<string, unknown>
    : null;
  return typeof machine?.replacedByMachineId === 'string'
    && machine.replacedByMachineId.trim() === expectedMachineId;
}

function readReplacementMachineId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const candidate = record.replacementMachineId ?? record.replacedByMachineId;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;
  private readonly connectedServiceProfileListCache = new Map<ConnectedServiceId, ConnectedServiceProfileListCacheEntry>();
  private accountEncryptionModeCache: AccountEncryptionModeCacheEntry | null = null;

  private constructor(credential: Credentials) {
    this.credential = credential
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
              'Content-Type': 'application/json'
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
      const shouldConsumeReplacementCandidate = registrationIdentity?.replacementCandidateAccountId
        && registrationIdentity.replacesMachineId
        && (
          didServerAcknowledgeMachineReplacement(response.data, registrationIdentity.replacesMachineId)
          || await this.didServerAlreadyApplyMachineReplacement({
            replacesMachineId: registrationIdentity.replacesMachineId,
            replacementMachineId: opts.machineId,
            timeoutMs,
          })
        );

      if (shouldConsumeReplacementCandidate) {
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
        && (error.response.data as any)?.error === 'machine_id_conflict'
      ) {
        throw new MachineIdConflictError(opts.machineId);
      }

      if (
        axios.isAxiosError(error)
        && error.response?.status === 410
        && (error.response.data as any)?.error === 'machine_revoked'
      ) {
        throw new MachineRevokedError(opts.machineId);
      }

      if (axios.isAxiosError(error) && error.response?.status === 410) {
        const body = error.response.data as any;
        if (body?.error === 'machine_replaced' || body?.error === 'machine-replaced') {
          const replacementMachineId = readReplacementMachineId(body);
          if (replacementMachineId) {
            throw new MachineReplacedError(opts.machineId, replacementMachineId);
          }
        }
      }

      if (axios.isAxiosError(error) && error.response?.status === 400) {
        const body = error.response.data as any;
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

  private async didServerAlreadyApplyMachineReplacement(params: Readonly<{
    replacesMachineId: string;
    replacementMachineId: string;
    timeoutMs: number;
  }>): Promise<boolean> {
    try {
      const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(params.replacesMachineId)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
          },
          timeout: params.timeoutMs,
        },
      );
      return doesMachineRowPointAtReplacement(response.data, params.replacementMachineId);
    } catch {
      return false;
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

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
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
    return new ApiMachineClient(this.credential.token, machine, ownershipMetadata);
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
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, serializeAxiosErrorForLog(error));
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
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          sealed: params.sealed,
          ...(params.metadata ? { metadata: params.metadata } : {}),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      this.invalidateConnectedServiceProfileListCache(params.serviceId);
      logger.debug(`[API] Connected service credential registered`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
    } catch (error) {
      // Never log raw Axios errors: they can contain bearer tokens or provider secrets.
      logger.debug(`[API] [ERROR] Failed to register connected service credential:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<{
    sealed: SealedConnectedServiceCredentialV1;
    metadata: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service credential response');
      }

      const sealedParsed = SealedConnectedServiceCredentialV1Schema.safeParse((raw as any).sealed);
      if (!sealedParsed.success) {
        throw new Error('Invalid connected service credential response');
      }

      const metadataParsed = z.object({
        kind: z.enum(['oauth', 'token']),
        providerEmail: z.string().nullable().optional(),
        providerAccountId: z.string().nullable().optional(),
        expiresAt: z.number().nullable().optional(),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw new Error('Invalid connected service credential response');
      }

      return { sealed: sealedParsed.data, metadata: metadataParsed.data };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const code = (() => {
        if (!axios.isAxiosError(error)) return undefined;
        const data = error.response?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
        const rec = data as Record<string, unknown>;
        return typeof rec.error === 'string' ? rec.error : undefined;
      })();
      if (status === 404) {
        return null;
      }
      if (status === 409 && code === 'connect_credential_unsupported_format') {
        throw new ConnectedServiceCredentialUnsupportedFormatError(params.serviceId, params.profileId);
      }
      logger.debug(`[API] [ERROR] Failed to get connected service credential:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async listConnectedServiceProfiles(params: {
    serviceId: ConnectedServiceId;
  }): Promise<ConnectedServiceProfileListResult> {
    const cached = this.connectedServiceProfileListCache.get(params.serviceId);
    const nowMs = Date.now();
    if (cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
    if (cached?.kind === 'in_flight') return await cached.promise;

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
        timeout: 5000,
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
        status: z.enum(['connected', 'refreshing', 'needs_reauth', 'refresh_failed_retryable']),
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
  }): Promise<ConnectedServiceAuthGroupV1 | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
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
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;
      logger.debug(`[API] [ERROR] Failed to get connected service auth group:`, serializeAxiosErrorForLog(error));
      if (typeof status === 'number' && Number.isFinite(status)) {
        throw createHttpStatusError(
          status,
          `Failed to get connected service auth group (${status})`,
        );
      }
      // Preserve the original error as `cause` so downstream classification
      // (classifyDaemonServerWorkError walks `.cause`) can still recover the network
      // code (ECONNREFUSED / ECONNRESET / socket hang up) and treat a transient endpoint
      // outage as retryable WAITING instead of a non-retryable terminal recovery.
      throw new Error(
        `Failed to get connected service auth group: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  async updateConnectedServiceAuthGroupActiveProfile(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration?: number;
  }): Promise<ConnectedServiceAuthGroupV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/active-profile`,
        {
          profileId: params.activeProfileId,
          ...(params.expectedGeneration === undefined ? {} : { expectedGeneration: params.expectedGeneration }),
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
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
      throwConnectedServiceAuthGroupGenerationConflictIfPresent(error);
      logger.debug(`[API] [ERROR] Failed to update connected service auth group active profile:`, serializeAxiosErrorForLog(error));
      throw new Error(
        `Failed to update connected service auth group active profile: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  async updateConnectedServiceAuthGroupRuntimeState(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
  } & ConnectedServiceAuthGroupRuntimeStatePatchRequestV1): Promise<ConnectedServiceAuthGroupV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const groupId = encodeURIComponent(params.groupId);

    try {
      const response = await axios.patch(
        `${serverUrl}/v3/connect/${serviceId}/groups/${groupId}/runtime-state`,
        {
          ...(params.expectedGeneration === undefined ? {} : { expectedGeneration: params.expectedGeneration }),
          ...(params.state === undefined ? {} : { state: params.state }),
          memberStates: params.memberStates ?? [],
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
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
      throwConnectedServiceAuthGroupGenerationConflictIfPresent(error);
      logger.debug(`[API] [ERROR] Failed to update connected service auth group runtime state:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to update connected service auth group runtime state: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getAccountEncryptionMode(): Promise<'e2ee' | 'plain' | 'unknown'> {
    const cached = this.accountEncryptionModeCache;
    const nowMs = Date.now();
    if (cached?.kind === 'value' && cached.expiresAtMs > nowMs) return cached.value;
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

  private async fetchAccountEncryptionModeFromServer(): Promise<'e2ee' | 'plain' | 'unknown'> {
    const serverUrl = resolveServerHttpBaseUrl();
    try {
      const response = await axios.get(
        `${serverUrl}/v1/account/encryption`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) return 'e2ee';
      const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
      if (!parsed.success) return 'e2ee';
      return parsed.data.mode === 'plain' ? 'plain' : 'e2ee';
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return 'e2ee';
      logger.debug(`[API] [ERROR] Failed to get account encryption mode:`, serializeAxiosErrorForLog(error));
      return 'unknown';
    }
  }

  async getConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<{
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service credential response');
      }

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as any).content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
        throw new Error('Invalid connected service credential response');
      }

      const recordParsed = ConnectedServiceCredentialRecordV1Schema.safeParse(contentParsed.data.v);
      if (!recordParsed.success) {
        throw new Error('Invalid connected service credential response');
      }

      return { content: { t: 'plain', v: recordParsed.data } };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const code = (() => {
        if (!axios.isAxiosError(error)) return undefined;
        const data = error.response?.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
        const rec = data as Record<string, unknown>;
        return typeof rec.error === 'string' ? rec.error : undefined;
      })();
      if (status === 404) {
        return null;
      }
      if (status === 409 && code === 'connect_credential_unsupported_format') {
        return null;
      }
      logger.debug(`[API] [ERROR] Failed to get connected service credential (v3):`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to get connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async registerConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          content: params.content,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      this.invalidateConnectedServiceProfileListCache(params.serviceId);
      logger.debug(`[API] Connected service credential registered (v3)`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register connected service credential (v3):`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateConnectedServiceCredentialHealth(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
  }): Promise<void> {
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
        { health: healthParsed.data },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      this.invalidateConnectedServiceProfileListCache(params.serviceId);
    } catch (error: unknown) {
      logger.debug(`[API] [ERROR] Failed to update connected service credential health:`, serializeAxiosErrorForLog(error));
      throw new Error(`Failed to update connected service credential health: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register a sealed connected service quota snapshot (v2).
   *
   * The server stores the ciphertext as-is and only keeps non-secret metadata for UX.
   */
  async registerConnectedServiceQuotaSnapshotSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    sealed: SealedConnectedServiceQuotaSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          sealed: params.sealed,
          metadata: params.metadata,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Server returned status ${response.status}`,
        });
      }
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register connected service quota snapshot:`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to register connected service quota snapshot',
        cause: error,
      });
    }
  }

  async getConnectedServiceQuotaSnapshotSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
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
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service quota snapshot response');
      }

      const sealedParsed = SealedConnectedServiceQuotaSnapshotV1Schema.safeParse((raw as any).sealed);
      if (!sealedParsed.success) {
        throw new Error('Invalid connected service quota snapshot response');
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
        materialFingerprint: z.string().optional(),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response');
      }

      return { sealed: sealedParsed.data, metadata: metadataParsed.data };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logger.debug(`[API] [ERROR] Failed to get connected service quota snapshot:`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get connected service quota snapshot',
        cause: error,
      });
    }
  }

  async registerConnectedServiceQuotaSnapshotPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    content: { t: 'plain'; v: ConnectedServiceQuotaSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/quotas`,
        {
          content: params.content,
          metadata: params.metadata,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Server returned status ${response.status}`,
        });
      }
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register connected service quota snapshot (v3):`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to register connected service quota snapshot',
        cause: error,
      });
    }
  }

  async getConnectedServiceQuotaSnapshotPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
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
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid connected service quota snapshot response');
      }

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as any).content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
        throw new Error('Invalid connected service quota snapshot response');
      }

      const snapshotParsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(contentParsed.data.v);
      if (!snapshotParsed.success) {
        throw new Error('Invalid connected service quota snapshot response');
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
        materialFingerprint: z.string().optional(),
      }).safeParse((raw as any).metadata);

      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid connected service quota snapshot response');
      }

      return { content: { t: 'plain', v: snapshotParsed.data }, metadata: metadataParsed.data };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logger.debug(`[API] [ERROR] Failed to get connected service quota snapshot (v3):`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get connected service quota snapshot',
        cause: error,
      });
    }
  }

  async registerProviderAccountUsageSnapshotSealed(params: {
    recordId: ProviderAccountUsageRecordId;
    sealed: SealedProviderAccountUsageSnapshotV1;
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = encodeURIComponent(params.recordId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/provider-account-usage/${recordId}`,
        {
          sealed: params.sealed,
          metadata: params.metadata,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Server returned status ${response.status}`,
        });
      }
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register provider account usage snapshot:`, serializeAxiosErrorForLog(error));
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
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = encodeURIComponent(params.recordId);

    try {
      const response = await axios.get(
        `${serverUrl}/v2/connect/provider-account-usage/${recordId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid provider account usage snapshot response');
      }

      const sealedParsed = SealedProviderAccountUsageSnapshotV1Schema.safeParse((raw as any).sealed);
      if (!sealedParsed.success) {
        throw new Error('Invalid provider account usage snapshot response');
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
        materialFingerprint: z.string().optional(),
      }).safeParse((raw as any).metadata);
      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }

      return { sealed: sealedParsed.data, metadata: metadataParsed.data };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logger.debug(`[API] [ERROR] Failed to get provider account usage snapshot:`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get provider account usage snapshot',
        cause: error,
      });
    }
  }

  async registerProviderAccountUsageSnapshotPlain(params: {
    recordId: ProviderAccountUsageRecordId;
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      materialFingerprint?: string;
    };
  }): Promise<void> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = encodeURIComponent(params.recordId);

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/provider-account-usage/${recordId}`,
        {
          content: params.content,
          metadata: params.metadata,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );

      if (response.status !== 200 && response.status !== 201) {
        throw createConnectedServiceQuotaHttpStatusError({
          status: response.status,
          message: `Server returned status ${response.status}`,
        });
      }
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register provider account usage snapshot (v3):`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to register provider account usage snapshot',
        cause: error,
      });
    }
  }

  async getProviderAccountUsageSnapshotPlain(params: {
    recordId: ProviderAccountUsageRecordId;
  }): Promise<{
    content: { t: 'plain'; v: ProviderAccountUsageSnapshotV1 };
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
  } | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const recordId = encodeURIComponent(params.recordId);

    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/provider-account-usage/${recordId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      );
      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const raw = response.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid provider account usage snapshot response');
      }

      const contentParsed = StoredJsonContentEnvelopeSchema.safeParse((raw as any).content);
      if (!contentParsed.success || contentParsed.data.t !== 'plain') {
        throw new Error('Invalid provider account usage snapshot response');
      }

      const snapshotParsed = ProviderAccountUsageSnapshotV1Schema.safeParse(contentParsed.data.v);
      if (!snapshotParsed.success) {
        throw new Error('Invalid provider account usage snapshot response');
      }

      const metadataParsed = z.object({
        fetchedAt: z.number(),
        staleAfterMs: z.number(),
        status: z.enum(['ok', 'unavailable', 'estimated', 'error']),
        refreshRequestedAt: z.number().optional(),
        materialFingerprint: z.string().optional(),
      }).safeParse((raw as any).metadata);
      if (!metadataParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }

      return { content: { t: 'plain', v: snapshotParsed.data }, metadata: metadataParsed.data };
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404) return null;

      logger.debug(`[API] [ERROR] Failed to get provider account usage snapshot (v3):`, serializeAxiosErrorForLog(error));
      throw createConnectedServiceQuotaApiError({
        message: 'Failed to get provider account usage snapshot',
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
  }): Promise<{ acquired: boolean; leaseUntil: number }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const response = await axios.post(
      `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/refresh-lease`,
      {
        machineId: params.machineId,
        ...(params.ownerId ? { ownerId: params.ownerId } : {}),
        leaseMs: params.leaseMs,
      },
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      },
    );
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    const schema = z.object({
      acquired: z.boolean(),
      leaseUntil: z.number(),
    });
    const parsed = schema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error('Invalid connected service refresh lease response');
    }
    return parsed.data;
  }
}
