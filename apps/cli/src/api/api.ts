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
import { ApiSessionClient, type ApiSessionClientOptions } from './session/sessionClient';
import {
  ApiMachineClient,
  type ApiMachineClientLifecycleDependencies,
} from './apiMachine';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import type {
  BrowserRecordingComposerAttachInput,
  BrowserRecordingComposerAttachResult,
} from '@/daemon/browser/recording/attachToComposer';
import type { LocalServicesRuntimeActionRoutes } from '@/daemon/local/services/actions/runtimeActionExecutor';
import type { DaemonPeerMediationObservabilityRuntimeActionContext } from '@/daemon/peer/mediation/observability/runtimeActionExecutor';
import type { SimulatorPreviewRoutes } from '@/daemon/devices/simulator/previewRoutes.types';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { decodeBase64, encodeBase64, encrypt, decrypt } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';
import {
  readSessionMetadataLayoutVersion,
  tryReadApiSessionMetadataForLayout,
} from '@/session/metadata/sessionMetadataLayout';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './client/encryptionKey';
import { openSessionDataEncryptionKey } from './client/openSessionDataEncryptionKey';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { logServerEndpointFailure } from './client/serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { resolveConnectedServicesServerApiTimeoutMs } from './client/connectedServicesServerApiTimeout';
import { getConnectedServiceAuthGroup as getConnectedServiceAuthGroupFromServer } from './client/connectedServiceAuthGroupApi';
import { readAxiosResponseErrorCode } from './client/readAxiosResponseErrorCode';
import { transformSessionInputThroughPluginHooks } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceAccountEncryptionMode,
  type ConnectedServiceCredentialApi,
  type ConnectedServiceCredentialPlainResponse,
  type ConnectedServiceCredentialSealedResponse,
  type ConnectedServiceProfileListResult,
} from './client/connectedServiceCredentialApi';
export { ConnectedServiceCredentialUnsupportedFormatError } from './client/connectedServiceCredentialApi';
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
  buildProviderAccountUsageRecordId,
  ConnectedServiceAuthGroupListResponseV1Schema,
  ConnectedServiceAuthGroupResponseV1Schema,
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialCompatibleMutationResponseV1Schema,
  ConnectedServiceCredentialMutationResponseV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceUsageSourceV1Schema,
  ProviderAccountUsageRecordIdSchema,
  ProviderAccountUsageRecordKeyV1Schema,
  ProviderAccountUsageSnapshotV1Schema,
  parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
  parseBuiltInLegacyProviderAccountUsageSnapshotV1,
  projectBuiltInLegacyConnectedServiceCredentialRecordV1,
  projectBuiltInLegacyProviderAccountUsageSnapshotV1,
  SealedConnectedServiceQuotaSnapshotV1Schema,
  SealedProviderAccountUsageSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionSharedMetadataV1Schema,
  projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceAuthGroupV1,
  ConnectedServiceAuthGroupRuntimeStatePatchRequestV1,
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialCompatibleMutationResponseV1,
  ConnectedServiceCredentialMutationResponseV1,
  ConnectedServiceCredentialRecordV1,
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
import { consumeMachineReplacementCandidateAfterRegistration } from '@/daemon/machineIdentity/machineReplacementCandidates';
import { resolveMachineRegistrationIdentity } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';
import { tryDecryptSessionOwnerMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  buildSessionMetadataEnvelopeCreateFields,
  SessionMetadataPrivacyUpgradeRequiredError,
} from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
export { SessionMetadataPrivacyUpgradeRequiredError } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

const ExactProviderAccountUsageSourceResolutionSchema = z.object({
  source: ConnectedServiceUsageSourceV1Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  providerAccountId: z.string().trim().min(1).max(512),
  fetchedAt: z.number().int().nonnegative().nullable(),
  staleAfterMs: z.number().int().nonnegative().nullable(),
}).strict();

function isExactConnectedServiceUsageSource(
  actual: ConnectedServiceUsageSourceV1,
  expected: ConnectedServiceUsageSourceV1,
): boolean {
  if (
    actual.serviceId !== expected.serviceId
    || actual.profileId !== expected.profileId
    || actual.bindingKind !== expected.bindingKind
  ) return false;
  if (actual.bindingKind === 'profile' || expected.bindingKind === 'profile') {
    return actual.bindingKind === 'profile' && expected.bindingKind === 'profile';
  }
  return actual.groupId === expected.groupId
    && (actual.groupGeneration ?? null) === (expected.groupGeneration ?? null);
}

export class ConnectedServiceAuthGroupGenerationConflictError extends Error {
  readonly generation: number;

  constructor(generation: number) {
    super('connected_service_auth_group_generation_conflict');
    this.name = 'ConnectedServiceAuthGroupGenerationConflictError';
    this.generation = generation;
  }
}

export class ConnectedServiceAuthGroupRuntimeStateRevisionConflictError extends Error {
  readonly runtimeStateRevision: number;

  constructor(runtimeStateRevision: number) {
    super('connected_service_auth_group_runtime_state_revision_conflict');
    this.name = 'ConnectedServiceAuthGroupRuntimeStateRevisionConflictError';
    this.runtimeStateRevision = runtimeStateRevision;
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

function readConnectedServiceAuthGroupRuntimeStateRevisionConflict(error: unknown): number | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const data: unknown = error.response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.error !== 'connect_group_runtime_state_revision_conflict') return null;
  const revision = record.runtimeStateRevision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  return revision;
}

function throwConnectedServiceAuthGroupRuntimeStateRevisionConflictIfPresent(error: unknown): void {
  const revision = readConnectedServiceAuthGroupRuntimeStateRevisionConflict(error);
  if (revision !== null) {
    throw new ConnectedServiceAuthGroupRuntimeStateRevisionConflictError(revision);
  }
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

function normalizeLocalMachineId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;
  private readonly connectedServiceCredentialApi: ReturnType<typeof createConnectedServiceCredentialApi>;
  private getBrowserDaemonControlRoutes: (() => BrowserDaemonControlRoutes | null) | null = null;
  private getBrowserDaemonContextRoutes: (() => BrowserContextRoutes | null) | null = null;
  private getBrowserDaemonAutomationRoutes: (() => BrowserAutomationRoutes | null) | null = null;
  private getBrowserDiagnosticsActionRoutes: (() => BrowserDiagnosticsActionRoutes | null) | null = null;
  private getBrowserRecordingRoutes: (() => BrowserRecordingRoutes | null) | null = null;
  private attachBrowserRecordingToComposer: ((
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>) | undefined;
  private getLocalServicesRuntimeActionRoutes: (() => LocalServicesRuntimeActionRoutes | null) | null = null;
  private getSimulatorPreviewRoutes: (() => SimulatorPreviewRoutes | null) | null = null;
  private getPeerMediationObservabilityRuntimeActionContext:
    (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null = null;
  // G9-E: the daemon-wide cached server-features snapshot accessor. Wired at daemon startup so the
  // runtime-action front door's feature gate reads the LIVE server bits cold instead of failing
  // closed for lack of a daemon-wide source.
  private getCachedServerFeaturesSnapshot: (() => CliServerFeaturesSnapshot | undefined) | null = null;
  private localMachineId: string | null = null;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, resolveServerHttpBaseUrl())
    this.connectedServiceCredentialApi = createConnectedServiceCredentialApi(credential)
  }

  setSimulatorPreviewRoutesProvider(provider: (() => SimulatorPreviewRoutes | null) | null): void {
    this.getSimulatorPreviewRoutes = provider;
  }

  setBrowserDaemonControlRoutesProvider(provider: (() => BrowserDaemonControlRoutes | null) | null): void {
    this.getBrowserDaemonControlRoutes = provider;
  }

  setBrowserDaemonContextRoutesProvider(provider: (() => BrowserContextRoutes | null) | null): void {
    this.getBrowserDaemonContextRoutes = provider;
  }

  setBrowserDaemonAutomationRoutesProvider(provider: (() => BrowserAutomationRoutes | null) | null): void {
    this.getBrowserDaemonAutomationRoutes = provider;
  }

  setBrowserDiagnosticsActionRoutesProvider(provider: (() => BrowserDiagnosticsActionRoutes | null) | null): void {
    this.getBrowserDiagnosticsActionRoutes = provider;
  }

  setBrowserRecordingRoutesProvider(provider: (() => BrowserRecordingRoutes | null) | null): void {
    this.getBrowserRecordingRoutes = provider;
  }

  setBrowserRecordingComposerAttachHandler(handler: ((
    input: BrowserRecordingComposerAttachInput,
  ) => Promise<BrowserRecordingComposerAttachResult>) | undefined): void {
    this.attachBrowserRecordingToComposer = handler;
  }

  setLocalServicesRuntimeActionRoutesProvider(provider: (() => LocalServicesRuntimeActionRoutes | null) | null): void {
    this.getLocalServicesRuntimeActionRoutes = provider;
  }

  // PMS-WIRE: the machine-sync bootstrap (write-path owner) publishes the single observability store
  // + daemon scope here so the runtime-action dispatch (read-path owner) reads back the SAME store.
  setPeerMediationObservabilityRuntimeActionContextProvider(
    provider: (() => DaemonPeerMediationObservabilityRuntimeActionContext | null) | null,
  ): void {
    this.getPeerMediationObservabilityRuntimeActionContext = provider;
  }

  // G9-E: the machine-sync bootstrap publishes the daemon-wide cached server-features snapshot
  // accessor here so the runtime-action dispatch (read-path owner) reads the same live bits the
  // daemon already fetches/caches.
  setServerFeaturesSnapshotProvider(provider: (() => CliServerFeaturesSnapshot | undefined) | null): void {
    this.getCachedServerFeaturesSnapshot = provider;
  }

  async getServerFeaturesSnapshot(
    options?: Readonly<{ refresh?: boolean }>,
  ): Promise<CliServerFeaturesSnapshot | undefined> {
    if (options?.refresh === true) {
      return await fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
      });
    }
    return this.getCachedServerFeaturesSnapshot?.();
  }

  async getProviderAccountUsageWriteRouteAvailability(params: {
    recordId: ProviderAccountUsageRecordId;
  }): Promise<'available' | 'absent' | 'indeterminate'> {
    const recordId = encodeURIComponent(
      ProviderAccountUsageRecordIdSchema.parse(params.recordId),
    );
    try {
      const response = await axios.get(
        `${resolveServerHttpBaseUrl()}/v2/connect/provider-account-usage/${recordId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
        },
      );
      return response.status === 200 ? 'available' : 'indeterminate';
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 404) {
        return 'indeterminate';
      }
      const data = error.response.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const record = data as Record<string, unknown>;
        if (record.error === 'provider_account_usage_not_found') {
          return 'available';
        }
        if (
          record.statusCode === 404
          && typeof record.message === 'string'
          && record.message.includes('/v2/connect/provider-account-usage/')
        ) {
          return 'absent';
        }
      }
      return 'indeterminate';
    }
  }

  setLocalMachineId(machineId: string | null | undefined): void {
    this.localMachineId = normalizeLocalMachineId(machineId);
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    tag: string,
    metadata: Metadata,
    state: AgentState | null,
    signal?: AbortSignal,
  }): Promise<Session | null> {
    opts.signal?.throwIfAborted();
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
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          opts.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          reject(opts.signal?.reason ?? new Error('Session creation cancelled'));
        };
        if (opts.signal?.aborted) {
          onAbort();
          return;
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
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
      opts.signal?.throwIfAborted();
      try {
        const metadataEnvelopeFields = buildSessionMetadataEnvelopeCreateFields({
          credentials: this.credential,
          metadata: opts.metadata,
          agentState: opts.state,
          storedContentMode: desiredSessionEncryptionMode,
          encryptionKey,
          encryptionVariant,
        });

        const response = await axios.post<CreateSessionResponse>(
          sessionsUrl,
          {
            tag: opts.tag,
            ...metadataEnvelopeFields,
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
            timeout: 60000, // 1 minute timeout for very bad network connections
            ...(opts.signal ? { signal: opts.signal } : {}),
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

	      const decodedMetadata =
	        sessionEncryptionMode === 'plain'
	          ? JSON.parse(String(raw.metadata ?? 'null'))
	          : decrypt(sessionEncryptionKey, encryptionVariant, decodeBase64(raw.metadata));
        const metadataLayoutVersion = readSessionMetadataLayoutVersion(raw.metadataLayoutVersion);
        const metadata = tryReadApiSessionMetadataForLayout(
          decodedMetadata,
          metadataLayoutVersion,
        );
        if (!metadata) {
          throw new Error('Session metadata does not match its declared privacy layout');
        }
        const rawOwnerMetadata =
          (raw as Readonly<{ ownerMetadata?: unknown }>).ownerMetadata;
        const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
          ? tryDecryptSessionOwnerMetadata({
              credentials: this.credential,
              rawSession: {
                metadataLayoutVersion,
                ownerMetadata: rawOwnerMetadata,
                encryptionMode:
                  (raw as Readonly<{ encryptionMode?: unknown }>).encryptionMode,
              },
            })
          : null;
        if (
          metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
          && !ownerMetadata
        ) {
          throw new SessionMetadataPrivacyUpgradeRequiredError([]);
        }
        const responseSharedMetadata =
          metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
            ? SessionSharedMetadataV1Schema.parse(decodedMetadata)
            : null;
        const runtimeMetadata = ownerMetadata
          ? projectSessionOwnerCompatibilityViewV1({
              sharedMetadata: responseSharedMetadata!,
              ownerMetadata,
            }) as Metadata
          : metadata;
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
	          metadata: runtimeMetadata,
	          metadataLayoutVersion,
	          ...(ownerMetadata
	            ? {
	              ownerMetadata,
	              ownerMetadataCiphertext: String(rawOwnerMetadata),
	            }
	            : {}),
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
	        metadata: runtimeMetadata,
	        metadataLayoutVersion,
	        ...(ownerMetadata
	          ? {
	            ownerMetadata,
	            ownerMetadataCiphertext: String(rawOwnerMetadata),
	          }
	          : {}),
	        metadataVersion: raw.metadataVersion,
	        agentState,
	        agentStateVersion: raw.agentStateVersion,
	      };
      } catch (error) {
        if (opts.signal?.aborted) {
          throw opts.signal.reason ?? error;
        }
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

  sessionSyncClient(
    session: Session,
    sessionOptions: Pick<
      ApiSessionClientOptions,
      | 'initialRegisteredSessionStateFieldMutations'
      | 'durableMutationDeliveryInitiallyActive'
      | 'transformSessionInputBeforeCommit'
    > = {},
  ): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session, {
      credentials: this.credential,
      getBrowserDaemonControlRoutes: this.getBrowserDaemonControlRoutes,
      getBrowserDaemonContextRoutes: this.getBrowserDaemonContextRoutes,
      getBrowserDaemonAutomationRoutes: this.getBrowserDaemonAutomationRoutes,
      getBrowserDiagnosticsActionRoutes: this.getBrowserDiagnosticsActionRoutes,
      getBrowserRecordingRoutes: this.getBrowserRecordingRoutes,
      attachBrowserRecordingToComposer: this.attachBrowserRecordingToComposer,
      getLocalServicesRuntimeActionRoutes: this.getLocalServicesRuntimeActionRoutes,
      getSimulatorPreviewRoutes: this.getSimulatorPreviewRoutes,
      getPeerMediationObservabilityRuntimeActionContext: this.getPeerMediationObservabilityRuntimeActionContext,
      getServerFeaturesSnapshot: this.getCachedServerFeaturesSnapshot,
      transformSessionInputBeforeCommit:
        sessionOptions.transformSessionInputBeforeCommit
        ?? transformSessionInputThroughPluginHooks,
      localMachineId: this.localMachineId,
      initialRegisteredSessionStateFieldMutations: sessionOptions.initialRegisteredSessionStateFieldMutations,
      durableMutationDeliveryInitiallyActive: sessionOptions.durableMutationDeliveryInitiallyActive,
    });
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
    lifecycleDependencies?: ApiMachineClientLifecycleDependencies,
  ): ApiMachineClient {
    return new ApiMachineClient(
      this.credential.token,
      machine,
      ownershipMetadata,
      lifecycleDependencies,
    );
  }

  push(): PushNotificationClient {
    return this.pushClient;
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
  }): Promise<ConnectedServiceCredentialCompatibleMutationResponseV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          sealed: params.sealed,
          ...(params.metadata ? { metadata: params.metadata } : {}),
          ...(params.expectedCredentialRevision !== undefined
            ? { expectedCredentialRevision: params.expectedCredentialRevision }
            : {}),
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

      this.connectedServiceCredentialApi.invalidateConnectedServiceProfileListCache(params.serviceId);
      logger.debug(`[API] Connected service credential registered`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
      return parsed.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 409 && axios.isAxiosError(error)) {
        const superseded = ConnectedServiceCredentialMutationResponseV1Schema.safeParse(error.response?.data);
        if (superseded.success && 'error' in superseded.data) return superseded.data;
      }
      // Never log raw Axios errors: they can contain bearer tokens or provider secrets.
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register connected service credential',
        error,
      });
      if (typeof status === 'number' && Number.isFinite(status)) {
        throw createHttpStatusError(status, 'Failed to register connected service credential');
      }
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getConnectedServiceCredentialSealed(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<ConnectedServiceCredentialSealedResponse | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceCredentialSealed(params);
  }

  async listConnectedServiceProfiles(params: {
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }): Promise<ConnectedServiceProfileListResult> {
    return await this.connectedServiceCredentialApi.listConnectedServiceProfiles(params);
  }

  async listConnectedServiceAuthGroups(params: {
    serviceId: ConnectedServiceId;
  }): Promise<readonly ConnectedServiceAuthGroupV1[]> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    try {
      const response = await axios.get(
        `${serverUrl}/v3/connect/${serviceId}/groups`,
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
      const parsed = ConnectedServiceAuthGroupListResponseV1Schema.safeParse(response.data);
      if (!parsed.success) {
        throw new Error('Invalid connected service auth group list response');
      }
      return parsed.data.groups;
    } catch (error: unknown) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logServerEndpointFailure({
        logger,
        operation: 'Failed to list connected service auth groups',
        error,
      });
      if (typeof status === 'number' && Number.isFinite(status)) {
        throw createHttpStatusError(status, `Failed to list connected service auth groups (${status})`);
      }
      throw new Error(
        `Failed to list connected service auth groups: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { cause: error },
      );
    }
  }

  async getConnectedServiceAuthGroup(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
  }): Promise<ConnectedServiceAuthGroupV1 | null> {
    return await getConnectedServiceAuthGroupFromServer({
      token: this.credential.token,
      ...params,
    });
  }

  async updateConnectedServiceAuthGroupActiveProfile(params: {
    serviceId: ConnectedServiceId;
    groupId: string;
    activeProfileId: string;
    expectedGeneration?: number;
    overrideRuntimeCooldown?: boolean;
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
      throwConnectedServiceAuthGroupGenerationConflictIfPresent(error);
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service auth group active profile',
        error,
      });
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
          ...(params.expectedRuntimeStateRevision === undefined
            ? {}
            : { expectedRuntimeStateRevision: params.expectedRuntimeStateRevision }),
          ...(params.state === undefined ? {} : { state: params.state }),
          memberStates: params.memberStates ?? [],
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
      throwConnectedServiceAuthGroupRuntimeStateRevisionConflictIfPresent(error);
      throwConnectedServiceAuthGroupGenerationConflictIfPresent(error);
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service auth group runtime state',
        error,
      });
      throw new Error(`Failed to update connected service auth group runtime state: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getAccountEncryptionMode(options?: Readonly<{ refresh?: boolean }>): Promise<ConnectedServiceAccountEncryptionMode> {
    return await this.connectedServiceCredentialApi.getAccountEncryptionMode(options);
  }

  async getConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
  }): Promise<ConnectedServiceCredentialPlainResponse | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceCredentialPlain(params);
  }

  async deleteConnectedServiceCredentialRevisioned(params: Parameters<
    ConnectedServiceCredentialApi['deleteConnectedServiceCredentialRevisioned']
  >[0]): Promise<void> {
    await this.connectedServiceCredentialApi
      .deleteConnectedServiceCredentialRevisioned(params);
  }

  async registerConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    refreshLeaseOwnerId?: string;
  }): Promise<ConnectedServiceCredentialCompatibleMutationResponseV1> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const record =
      projectBuiltInLegacyConnectedServiceCredentialRecordV1(
        params.content.v,
      );

    try {
      const response = await axios.post(
        `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/credential`,
        {
          content: { t: 'plain', v: record },
          ...(params.expectedCredentialRevision !== undefined
            ? { expectedCredentialRevision: params.expectedCredentialRevision }
            : {}),
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

      this.connectedServiceCredentialApi.invalidateConnectedServiceProfileListCache(params.serviceId);
      logger.debug(`[API] Connected service credential registered (v3)`, {
        serviceId: params.serviceId,
        profileId: params.profileId,
      });
      return parsed.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 409 && axios.isAxiosError(error)) {
        const superseded = ConnectedServiceCredentialMutationResponseV1Schema.safeParse(error.response?.data);
        if (superseded.success && 'error' in superseded.data) return superseded.data;
      }
      logServerEndpointFailure({
        logger,
        operation: 'Failed to register connected service credential',
        error,
      });
      if (typeof status === 'number' && Number.isFinite(status)) {
        throw createHttpStatusError(status, 'Failed to register connected service credential');
      }
      throw new Error(`Failed to register connected service credential: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateConnectedServiceCredentialHealth(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
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
        {
          health: healthParsed.data,
          ...(params.expectedCredentialRevision
            ? { expectedCredentialRevision: params.expectedCredentialRevision }
            : {}),
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
      this.connectedServiceCredentialApi.invalidateConnectedServiceProfileListCache(params.serviceId);
    } catch (error: unknown) {
      logServerEndpointFailure({
        logger,
        operation: 'Failed to update connected service credential health',
        error,
      });
      throw new Error(`Failed to update connected service credential health: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
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
      materialFingerprint?: string;
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

      let snapshot: ConnectedServiceQuotaSnapshotV1;
      try {
        snapshot =
          parseBuiltInLegacyConnectedServiceQuotaSnapshotV1(
            contentParsed.data.v,
          );
      } catch {
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

      return { content: { t: 'plain', v: snapshot }, metadata: metadataParsed.data };
    } catch (error: unknown) {
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

  async registerProviderAccountUsageSnapshotSealed(params: {
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    source?: ConnectedServiceUsageSourceV1;
    sealed: SealedProviderAccountUsageSnapshotV1;
    legacyQuotaCompatibility?: SealedConnectedServiceQuotaSnapshotV1;
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
    const legacyQuotaCompatibility = params.legacyQuotaCompatibility
      ? SealedConnectedServiceQuotaSnapshotV1Schema.parse(
          params.legacyQuotaCompatibility,
        )
      : undefined;
    const source = params.source ? ConnectedServiceUsageSourceV1Schema.parse(params.source) : undefined;

    try {
      const response = await axios.post(
        `${serverUrl}/v2/connect/provider-account-usage/${recordId}`,
        {
          recordKey,
          ...(source ? { source } : {}),
          sealed,
          ...(legacyQuotaCompatibility
            ? { legacyQuotaCompatibility }
            : {}),
          metadata: params.metadata,
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
          message: `Server returned status ${response.status}`,
        });
      }
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
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
      materialFingerprint?: string;
    };
    sources: readonly ConnectedServiceUsageSourceV1[];
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
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
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
      const sourcesParsed = z.array(ConnectedServiceUsageSourceV1Schema).safeParse((raw as any).sources ?? []);
      if (!sourcesParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }

      return { sealed: sealedParsed.data, metadata: metadataParsed.data, sources: sourcesParsed.data };
    } catch (error: unknown) {
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
    const snapshot =
      projectBuiltInLegacyProviderAccountUsageSnapshotV1(
        ProviderAccountUsageSnapshotV1Schema.parse(params.content.v),
      );
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
          message: `Server returned status ${response.status}`,
        });
      }
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
      if (!parsed.success || !isExactConnectedServiceUsageSource(parsed.data.source, source)) {
        throw createConnectedServiceQuotaProtocolError(
          'Invalid provider account usage source resolution response',
          parsed.success ? undefined : parsed.error,
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (
        axios.isAxiosError(error)
        && error.response?.status === 404
        && readAxiosResponseErrorCode(error) === 'provider_account_usage_source_not_found'
      ) return null;
      logServerEndpointFailure({ logger, operation: 'Failed to resolve provider account usage source', error });
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
    metadata: {
      fetchedAt: number;
      staleAfterMs: number;
      status: 'ok' | 'unavailable' | 'estimated' | 'error';
      refreshRequestedAt?: number;
    };
    sources: readonly ConnectedServiceUsageSourceV1[];
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
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
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

      let snapshot: ProviderAccountUsageSnapshotV1;
      try {
        snapshot =
          parseBuiltInLegacyProviderAccountUsageSnapshotV1(
            contentParsed.data.v,
          );
      } catch {
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
      const sourcesParsed = z.array(ConnectedServiceUsageSourceV1Schema).safeParse((raw as any).sources ?? []);
      if (!sourcesParsed.success) {
        throw createConnectedServiceQuotaProtocolError('Invalid provider account usage snapshot response');
      }

      return { content: { t: 'plain', v: snapshot }, metadata: metadataParsed.data, sources: sourcesParsed.data };
    } catch (error: unknown) {
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

  async acquireConnectedServiceRefreshLease(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    machineId: string;
    ownerId?: string;
    leaseMs: number;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1;
  }): Promise<{
    acquired: boolean;
    leaseUntil: number;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
    ownerId: string;
  }> {
    const serverUrl = resolveServerHttpBaseUrl();
    const serviceId = encodeURIComponent(params.serviceId);
    const profileId = encodeURIComponent(params.profileId);
    const response = await axios.post(
      `${serverUrl}/v3/connect/${serviceId}/profiles/${profileId}/refresh-lease`,
      {
        machineId: params.machineId,
        ...(params.ownerId ? { ownerId: params.ownerId } : {}),
        leaseMs: params.leaseMs,
        ...(params.expectedCredentialRevision
          ? { expectedCredentialRevision: params.expectedCredentialRevision }
          : {}),
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
