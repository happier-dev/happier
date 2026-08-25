import axios from 'axios'
import {
  buildCurrentAccountStoredContentCompatibilityHttpHeaders,
  readCliClientUpgradeRequired,
} from '@/api/clientCompatibility/cliClientCompatibility';
import {
  AccountStoredContentClientUpgradeRequiredError,
} from '@/api/clientCompatibility/accountStoredContentActivation';
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
  SessionCreateOrLoadResult,
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
import type { ProvisionBrowserAutomationRuntime } from '@/daemon/browser/actions/runtimeActionExecutor';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
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
import type { Credentials, StoredCredentials } from '@/persistence';
import {
  readSessionMetadataLayoutVersion,
  tryReadApiSessionMetadataForLayout,
} from '@/session/metadata/sessionMetadataLayout';

import {
  requireAccountEncryptionCredentials,
  resolveMachineEncryptionContext,
  resolveSessionEncryptionContext,
} from './client/encryptionKey';
import { openSessionDataEncryptionKey } from './client/openSessionDataEncryptionKey';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { logServerEndpointFailure } from './client/serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import {
  requireCurrentAccountStoredContentServerCompatibility,
} from './clientCompatibility/accountStoredContentActivation';
import { resolveConnectedServicesServerApiTimeoutMs } from './client/connectedServicesServerApiTimeout';
import { SessionCreationPlacementError } from './session/sessionCreationPlacementError';
import {
  SessionCreationCorrespondenceConflictError,
} from './session/sessionCreationCorrespondenceConflictError';
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
import {
  readMachineOperationProtocolCapabilitiesProjectionV1,
} from './machine/machineOperationProtocolCapabilities';
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
  ConnectedServiceCredentialHealthV1Schema,
  ConnectedServiceCredentialCompatibleMutationResponseV1Schema,
  ConnectedServiceCredentialMutationResponseV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  parseBuiltInLegacyConnectedServiceQuotaSnapshotV1,
  projectBuiltInLegacyConnectedServiceCredentialRecordV1,
  SealedConnectedServiceQuotaSnapshotV1Schema,
  StoredJsonContentEnvelopeSchema,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  decodePlainMachineStoredContent,
  encodePlainMachineStoredContent,
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionSharedMetadataV1Schema,
  SessionOrganizationPlacementV1Schema,
  sessionCreationCorrespondenceMatchesV1,
  projectSessionOwnerCompatibilityViewV1,
} from '@happier-dev/protocol';
import type {
  ConnectedServiceCredentialHealthV1,
  ConnectedServiceCredentialCompatibleMutationResponseV1,
  ConnectedServiceCredentialMutationResponseV1,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
  ConnectedServiceQuotaSnapshotV1,
  ProviderAccountUsageSnapshotV1,
  SealedConnectedServiceCredentialV1,
  SealedConnectedServiceQuotaSnapshotV1,
  SealedProviderAccountUsageSnapshotV1,
  RuntimeActionExecute,
  SessionOwnerMetadataV1,
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

function assertSessionCreationCorrespondenceMatches(
  requested: unknown,
  ownerMetadata: SessionOwnerMetadataV1 | null | undefined,
): void {
  if (requested === undefined) return;
  if (sessionCreationCorrespondenceMatchesV1(
    requested,
    ownerMetadata?.system?.sessionCreationCorrespondenceV1,
  )) {
    return;
  }
  throw new SessionCreationCorrespondenceConflictError();
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

  static async create(credential: StoredCredentials) {
    return new ApiClient(credential);
  }

  private readonly credential: StoredCredentials;
  private readonly pushClient: PushNotificationClient;
  private readonly connectedServiceCredentialApi: ReturnType<typeof createConnectedServiceCredentialApi>;
  private getBrowserDaemonControlRoutes: (() => BrowserDaemonControlRoutes | null) | null = null;
  private getBrowserDaemonContextRoutes: (() => BrowserContextRoutes | null) | null = null;
  private getBrowserDaemonAutomationRoutes: (() => BrowserAutomationRoutes | null) | null = null;
  private getProvisionBrowserAutomationRuntime: (() => ProvisionBrowserAutomationRuntime | null) | null = null;
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

  private constructor(credential: StoredCredentials) {
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

  // Install-on-first-automation-attempt (user ruling, 2026-08-23). The daemon startup owner
  // publishes its provisioner here so a `browser.automation.*` dispatch that finds no route can
  // start the managed-Chromium fetch. Kept beside the route providers because it is resolved on
  // the same per-dispatch path and must never be captured at construction time.
  setBrowserAutomationRuntimeProvisionerProvider(
    provider: (() => ProvisionBrowserAutomationRuntime | null) | null,
  ): void {
    this.getProvisionBrowserAutomationRuntime = provider;
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

  /**
   * Returns the daemon-owned runtime Action executor with current route owners resolved at each
   * invocation. Plugin registries survive route replacement and plugin reloads, so capturing a
   * route object here would make the Plugin action surface stale.
   */
  createBrowserRuntimeActionExecutor(): RuntimeActionExecute {
    return createDaemonRuntimeActionExecutor({
      env: process.env,
      resolveRouteOwners: () => ({
        browserControl: this.getBrowserDaemonControlRoutes?.() ?? null,
        browserContext: this.getBrowserDaemonContextRoutes?.() ?? null,
        browserAutomation: this.getBrowserDaemonAutomationRoutes?.() ?? null,
        provisionBrowserAutomationRuntime: this.getProvisionBrowserAutomationRuntime?.() ?? null,
        browserDiagnostics: this.getBrowserDiagnosticsActionRoutes?.() ?? null,
        browserRecording: this.getBrowserRecordingRoutes?.() ?? null,
        attachBrowserRecordingToComposer: this.attachBrowserRecordingToComposer,
        localServices: this.getLocalServicesRuntimeActionRoutes?.() ?? null,
        simulatorPreview: this.getSimulatorPreviewRoutes?.() ?? null,
        peerMediationObservability: this.getPeerMediationObservabilityRuntimeActionContext?.() ?? null,
      }),
      resolveServerFeaturesSnapshot: () => this.getCachedServerFeaturesSnapshot?.(),
    });
  }

  async getServerFeaturesSnapshot(
    options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>,
  ): Promise<CliServerFeaturesSnapshot | undefined> {
    if (options?.refresh === true) {
      return await fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
        signal: options.signal,
      });
    }
    return this.getCachedServerFeaturesSnapshot?.();
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
    organizationPlacement?: import('@happier-dev/protocol').SessionOrganizationPlacementV1,
    signal?: AbortSignal,
  }): Promise<SessionCreateOrLoadResult | null> {
    opts.signal?.throwIfAborted();
    const sessionsUrl = `${resolveServerHttpBaseUrl()}/v1/sessions`;

    const serverBaseUrl = resolveServerHttpBaseUrl();
    const {
      desiredSessionEncryptionMode,
      accountEncryptionCurrentness,
      serverSupportsFeatureSnapshot,
    } = await resolveSessionCreateEncryptionMode({
      token: this.credential.token,
      serverBaseUrl,
      accountTimeoutMs: 10_000,
    });
    const encryptionContext = desiredSessionEncryptionMode === 'e2ee'
      ? resolveSessionEncryptionContext(this.credential)
      : null;

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
        const metadataEnvelopeFields = desiredSessionEncryptionMode === 'plain'
          ? buildSessionMetadataEnvelopeCreateFields({
              credentials: this.credential,
              accountEncryptionMode: accountEncryptionCurrentness.mode,
              metadata: opts.metadata,
              agentState: opts.state,
              storedContentMode: 'plain',
            })
          : (() => {
              if (!encryptionContext) {
                throw new Error('Session encryption context is unavailable');
              }
              return buildSessionMetadataEnvelopeCreateFields({
                credentials: this.credential,
                accountEncryptionMode: accountEncryptionCurrentness.mode,
                metadata: opts.metadata,
                agentState: opts.state,
                storedContentMode: 'e2ee',
                encryptionKey: encryptionContext.encryptionKey,
                encryptionVariant: encryptionContext.encryptionVariant,
              });
            })();

        const response = await axios.post<CreateSessionResponse>(
          sessionsUrl,
          {
            tag: opts.tag,
            ...metadataEnvelopeFields,
            dataEncryptionKey:
              desiredSessionEncryptionMode === 'plain'
                ? null
                : encryptionContext?.dataEncryptionKey
                  ? encodeBase64(encryptionContext.dataEncryptionKey)
                  : null,
            ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
            ...(opts.organizationPlacement ? { organizationPlacement: opts.organizationPlacement } : {}),
          },
          {
            headers: {
              ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000, // 1 minute timeout for very bad network connections
            ...(opts.signal ? { signal: opts.signal } : {}),
          }
        )

        logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
        let raw = response.data.session;
        const parsedOrganizationPlacement = SessionOrganizationPlacementV1Schema.safeParse(
          response.data.organizationPlacement,
        );
        const sessionCreationOutcome = typeof response.data.created === 'boolean'
          && parsedOrganizationPlacement.success
          ? {
              disposition: response.data.created ? 'created' as const : 'rejoined' as const,
              organizationPlacement: parsedOrganizationPlacement.data,
            }
          : undefined;

        const sessionEncryptionMode: 'e2ee' | 'plain' =
          (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const metadataLayoutVersion = readSessionMetadataLayoutVersion(raw.metadataLayoutVersion);
        const rawOwnerMetadata =
          (raw as Readonly<{ ownerMetadata?: unknown }>).ownerMetadata;
        const parsedOwnerMetadataEnvelope =
          SessionOwnerMetadataEnvelopeV1Schema.safeParse(
            rawOwnerMetadata,
          );
        const resolveRuntimeMetadata = (decodedMetadata: unknown): Metadata => {
          const metadata = tryReadApiSessionMetadataForLayout(
            decodedMetadata,
            metadataLayoutVersion,
          );
          if (!metadata) {
            throw new Error('Session metadata does not match its declared privacy layout');
          }
          if (metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1) {
            return metadata;
          }
          const ownerMetadata = tryDecryptSessionOwnerMetadata({
            credentials: this.credential,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
            rawSession: {
              metadataLayoutVersion,
              ownerMetadata: rawOwnerMetadata,
            },
          });
          if (!ownerMetadata) {
            throw new SessionMetadataPrivacyUpgradeRequiredError([]);
          }
          return projectSessionOwnerCompatibilityViewV1({
            sharedMetadata: SessionSharedMetadataV1Schema.parse(decodedMetadata),
            ownerMetadata,
          }) as Metadata;
        };

        if (sessionEncryptionMode === 'plain') {
          const decodedMetadata = JSON.parse(String(raw.metadata ?? 'null'));
          const runtimeMetadata = resolveRuntimeMetadata(decodedMetadata);
          const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
            ? tryDecryptSessionOwnerMetadata({
                credentials: this.credential,
                accountEncryptionMode: accountEncryptionCurrentness.mode,
                rawSession: {
                  metadataLayoutVersion,
                  ownerMetadata: rawOwnerMetadata,
                },
              })
            : null;
          assertSessionCreationCorrespondenceMatches(
            opts.metadata.sessionCreationCorrespondenceV1,
            ownerMetadata,
          );
          return {
            id: raw.id,
            seq: raw.seq,
            encryptionMode: 'plain' as const,
            metadata: runtimeMetadata,
            metadataLayoutVersion,
            ...(ownerMetadata && parsedOwnerMetadataEnvelope.success
              ? {
                  ownerMetadata,
                  ownerMetadataEnvelope:
                    parsedOwnerMetadataEnvelope.data,
                }
              : {}),
            metadataVersion: raw.metadataVersion,
            agentState: raw.agentState
              ? JSON.parse(String(raw.agentState))
              : null,
            agentStateVersion: raw.agentStateVersion,
            ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
          };
        }

        const responseEncryptionContext =
          encryptionContext ?? resolveSessionEncryptionContext(this.credential);
        const keyedCredential = requireAccountEncryptionCredentials(this.credential);

        // Prefer the Session's published data key, but retain the released
        // machine-key fallback for older E2EE Sessions without a published DEK.
        let sessionEncryptionKey = responseEncryptionContext.encryptionKey;
        if (keyedCredential.encryption.type === 'dataKey') {
          const serverEncryptedDataKeyRaw = (raw as any).dataEncryptionKey;
          const opened = openSessionDataEncryptionKey({
            credential: keyedCredential,
            encryptedDataEncryptionKeyBase64: serverEncryptedDataKeyRaw,
          });
          if (
            typeof serverEncryptedDataKeyRaw === 'string'
            && serverEncryptedDataKeyRaw.trim().length > 0
            && !opened
          ) {
            logger.debug('[API] Failed to open session dataEncryptionKey (dataKey account)', {
              sessionId: raw.id,
            });
            throw new Error('Failed to open session dataEncryptionKey');
          }
          sessionEncryptionKey = opened ?? keyedCredential.encryption.machineKey;
        }
        const decodedMetadata = decrypt(
          sessionEncryptionKey,
          responseEncryptionContext.encryptionVariant,
          decodeBase64(raw.metadata),
        );
        const runtimeMetadata = resolveRuntimeMetadata(decodedMetadata);
        const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
          ? tryDecryptSessionOwnerMetadata({
              credentials: keyedCredential,
              accountEncryptionMode: accountEncryptionCurrentness.mode,
              rawSession: {
                metadataLayoutVersion,
                ownerMetadata: rawOwnerMetadata,
              },
            })
          : null;
        assertSessionCreationCorrespondenceMatches(
          opts.metadata.sessionCreationCorrespondenceV1,
          ownerMetadata,
        );
        const agentState = raw.agentState
          ? decrypt(
              sessionEncryptionKey,
              responseEncryptionContext.encryptionVariant,
              decodeBase64(raw.agentState),
            )
          : null;

        return {
          id: raw.id,
          seq: raw.seq,
          encryptionMode: 'e2ee' as const,
          encryptionKey: sessionEncryptionKey,
          encryptionVariant: responseEncryptionContext.encryptionVariant,
          metadata: runtimeMetadata,
          metadataLayoutVersion,
          ...(ownerMetadata && parsedOwnerMetadataEnvelope.success
            ? {
                ownerMetadata,
                ownerMetadataEnvelope:
                  parsedOwnerMetadataEnvelope.data,
              }
            : {}),
          metadataVersion: raw.metadataVersion,
          agentState,
          agentStateVersion: raw.agentStateVersion,
          ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
        };
      } catch (error) {
        if (opts.signal?.aborted) {
          throw opts.signal.reason ?? error;
        }
        if (error instanceof SessionCreationCorrespondenceConflictError) {
          throw error;
        }
        const upgradeRequired = readCliClientUpgradeRequired(error);
        if (
          upgradeRequired?.requirement
          && 'kind' in upgradeRequired.requirement
          && upgradeRequired.requirement.kind
            === 'account-stored-content'
        ) {
          throw Object.assign(
            new Error(
              'Session creation requires a stored-content-compatible server',
            ),
            {
              code: 'client-upgrade-required' as const,
              retryable: false as const,
              requirement: upgradeRequired.requirement,
            },
          );
        }
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (
          error
          instanceof AccountStoredContentClientUpgradeRequiredError
        ) {
          throw error;
        }
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

        if (
          axios.isAxiosError(error)
          && error.response?.status === 400
          && error.response.data
          && typeof error.response.data === 'object'
          && !Array.isArray(error.response.data)
          && (error.response.data as Readonly<Record<string, unknown>>).error === 'invalid-params'
          && (error.response.data as Readonly<Record<string, unknown>>).code
            === 'invalid-session-organization-placement'
        ) {
          // This is the sole server-originated creation-placement result. Do
          // not broaden it to generic 4xx/network failures: callers use the
          // bounded code as an actionable final outcome.
          throw new SessionCreationPlacementError();
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
    const accountMode = await this.getAccountEncryptionMode();
    const machineStorageMode = accountMode === 'plain' ? 'plain' : 'e2ee';
    if (machineStorageMode === 'plain') {
      await requireCurrentAccountStoredContentServerCompatibility({
        resolveSnapshot: async () =>
          await this.getServerFeaturesSnapshot({ refresh: true }),
      });
    }
    const encryptionContext = machineStorageMode === 'e2ee'
      ? resolveMachineEncryptionContext(this.credential)
      : null;
    const encodeMachineContent = (value: unknown): string => {
      if (machineStorageMode === 'plain') {
        return encodePlainMachineStoredContent(value);
      }
      if (!encryptionContext) {
        throw new Error('Machine encryption context is unavailable for encrypted storage');
      }
      return encodeBase64(encrypt(
        encryptionContext.encryptionKey,
        encryptionContext.encryptionVariant,
        value,
      ));
    };
    const decodeMachineContent = (value: string): unknown => {
      if (machineStorageMode === 'plain') {
        return decodePlainMachineStoredContent(value);
      }
      if (!encryptionContext) {
        throw new Error('Machine encryption context is unavailable for encrypted storage');
      }
      return decrypt(
        encryptionContext.encryptionKey,
        encryptionContext.encryptionVariant,
        decodeBase64(value),
      );
    };
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
          metadata: encodeMachineContent(opts.metadata),
          daemonState: opts.daemonState
            ? encodeMachineContent(opts.daemonState)
            : undefined,
          dataEncryptionKey: machineStorageMode === 'plain'
            ? MACHINE_PLAIN_DATA_KEY_MARKER
            : encryptionContext?.dataEncryptionKey
              ? encodeBase64(encryptionContext.dataEncryptionKey)
              : undefined,
          ...(machineStorageMode === 'e2ee' && this.credential.encryption?.type === 'dataKey'
            ? { contentPublicKey: encodeBase64(this.credential.encryption.publicKey) }
            : null),
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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

      const operationProtocolCapabilities = readMachineOperationProtocolCapabilitiesProjectionV1({
        machineId: opts.machineId,
        value: raw,
      });

      // Return decrypted machine like we do for sessions.
      const machineCommon = {
        id: raw.id,
        metadata: raw.metadata
          ? decodeMachineContent(raw.metadata) as MachineMetadata
          : null,
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState
          ? decodeMachineContent(raw.daemonState) as DaemonState
          : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
        operationProtocolCapabilities:
          operationProtocolCapabilities?.capabilities ?? null,
        operationProtocolCapabilitiesRevision:
          operationProtocolCapabilities?.revision ?? null,
      };
      if (machineStorageMode === 'plain') {
        return {
          ...machineCommon,
          encryptionMode: 'plain',
        };
      }
      if (!encryptionContext) {
        throw new Error('Machine encryption context is unavailable for encrypted storage');
      }
      return {
        ...machineCommon,
        encryptionMode: 'e2ee',
        encryptionKey: encryptionContext.encryptionKey,
        encryptionVariant: encryptionContext.encryptionVariant,
      };
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
      contentPublicKey: this.credential.encryption?.type === 'dataKey'
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
      | 'afterComposerAttachmentMessageAccepted'
      | 'machineAdmissionTransport'
    > = {},
  ): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session, {
      credentials: this.credential,
      getAccountEncryptionCurrentness: async () => await this.getAccountEncryptionCurrentness(),
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
      createCapabilitiesApiClient: async (credentials) => await ApiClient.create(credentials),
      transformSessionInputBeforeCommit:
        sessionOptions.transformSessionInputBeforeCommit
        ?? transformSessionInputThroughPluginHooks,
      afterComposerAttachmentMessageAccepted:
        sessionOptions.afterComposerAttachmentMessageAccepted,
      machineAdmissionTransport:
        sessionOptions.machineAdmissionTransport,
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
      {
        ...lifecycleDependencies,
        createCapabilitiesApiClient:
          lifecycleDependencies?.createCapabilitiesApiClient
          ?? (async (credentials) => await ApiClient.create(credentials)),
      },
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
    signal?: AbortSignal;
  }): Promise<ConnectedServiceCredentialSealedResponse | null> {
    return await this.connectedServiceCredentialApi.getConnectedServiceCredentialSealed(params);
  }

  async listConnectedServiceProfiles(params: {
    serviceId: ConnectedServiceId;
    forceRefresh?: boolean;
  }): Promise<ConnectedServiceProfileListResult> {
    return await this.connectedServiceCredentialApi.listConnectedServiceProfiles(params);
  }

  async getAccountEncryptionMode(options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>): Promise<ConnectedServiceAccountEncryptionMode> {
    const mode = await this.connectedServiceCredentialApi.getAccountEncryptionMode(options);
    if (mode === 'plain') {
      options?.signal?.throwIfAborted();
      await requireCurrentAccountStoredContentServerCompatibility({
        resolveSnapshot: async () =>
          await this.getServerFeaturesSnapshot({ refresh: true, signal: options?.signal }),
      });
      options?.signal?.throwIfAborted();
    }
    return mode;
  }

  async getAccountEncryptionCurrentness() {
    return await this.connectedServiceCredentialApi.getAccountEncryptionCurrentness();
  }

  async getConnectedServiceCredentialPlain(params: {
    serviceId: ConnectedServiceId;
    profileId: string;
    signal?: AbortSignal;
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
          ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
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
