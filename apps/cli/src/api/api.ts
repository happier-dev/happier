import { resolvePublishedMachineEncryptionContext, MachineContentKeyUnavailableError } from './machine/machineDataEncryptionKey';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachineKeyBasisV1Schema, MachinePublishedRowV1Schema, MachineContentKeyTransitionResultV1Schema, prepareMachineContentKeyV1, MachineContentKeyPreparationErrorV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createMachineContentCodec } from './machine/machineStoredContent';
import { parseMachinePublishedMetadataV1, parseMachinePublishedDaemonStateV1, StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema, projectMachinePublishedMetadataFromRowV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import axios from 'axios'
import { ManagedEnrollmentCorrelationV1Schema, type ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readSessionCreationInitialTriggerError } from './session/sessionCreationInitialTriggerError';
import { pickSessionCreateOriginFields } from '@/session/shared/sessionCreateOrigin';
import { SESSION_CREATION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1, PROVIDER_BROKER_READINESS_AUTHORIZE_HTTP_PATH_V1, PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1, ProviderBrokerModelCatalogAuthorizationV1Schema, ProviderBrokerModelCatalogAuthorizationResponseV1Schema, ProviderBrokerRequestAdmissionV1Schema, ProviderBrokerRequestAdmissionResponseV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerOpenRequestV1, ProviderBrokerOpenResponseV1, ProviderBrokerModelCatalogAuthorizationV1, ProviderBrokerModelCatalogAuthorizationResponseV1, ProviderBrokerRequestAdmissionV1, ProviderBrokerRequestAdmissionResponseV1 } from '@happier-dev/protocol';
import { RunnerBrokerReadinessResponseV1Schema } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_ADMISSION_HTTP_PATH_V1, TEAM_CREDENTIAL_EXTERNAL_PROVIDER_TERMINAL_USAGE_HTTP_PATH_V1, TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1, TeamCredentialExternalProviderAdmissionResponseV1Schema, TeamCredentialExternalProviderAdmissionV1Schema, TeamCredentialExternalProviderTerminalUsageResponseV1Schema, TeamCredentialExternalProviderTerminalUsageV1Schema, TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema, TeamCredentialResourceTestAdmissionResponseV1Schema, TeamCredentialResourceTestAdmissionV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { TEAM_CREDENTIAL_ACTION_PATHS_V1 } from '@happier-dev/protocol/teams/credentials/actionsV1';
import { TeamCredentialResourceSummaryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { RunnerBrokerReadinessRequestV1, RunnerBrokerReadinessResponseV1, TeamCredentialExternalProviderAdmissionResponseV1, TeamCredentialExternalProviderAdmissionV1, TeamCredentialExternalProviderTerminalUsageResponseV1, TeamCredentialExternalProviderTerminalUsageV1, TeamCredentialExternalProviderModelCatalogAuthorizationV1, TeamCredentialResourceTestAdmissionResponseV1, TeamCredentialResourceTestAdmissionV1, TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import {
  buildCurrentAccountStoredContentCompatibilityHttpHeaders,
  readCliClientUpgradeRequired,
} from '@/api/clientCompatibility/cliClientCompatibility';
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
import { createAccountSessionClientTransport } from './client/createAccountSessionClientTransport';
import { ensureSessionMachineAccessKeyBinding } from './session/ensureSessionMachineAccessKeyBinding';
import { openTeamCredentialProviderBroker } from './client/providerBrokerApi';
import {
  ApiMachineClient,
  type ApiMachineClientLifecycleDependencies,
} from './apiMachine';
import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type { BrowserContextRoutes } from '@/daemon/browser/context/routes';
import type { ComputerRoutes } from '@/daemon/computer/routes';
import { createConfidentialSecretFillExecutor } from '@/daemon/surfaces/confidentialSecretFill';
import type { CurrentMachineExecutionOriginContext } from './machine/resolveCurrentMachineExecutionOriginContext';
import { fetchAccountEncryptionCurrentness } from './client/connectedServiceCredentialApi';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { BrowserAutomationRoutes } from '@/daemon/browser/automation/routes';
import type { ProvisionBrowserAutomationRuntime } from '@/daemon/browser/actions/runtimeActionExecutor';
import type { BrowserDiagnosticsActionRoutes } from '@/daemon/browser/diagnostics/actionRoutes';
import type { BrowserRecordingRoutes } from '@/daemon/browser/recording/routes';
import { createDaemonRuntimeActionExecutor, type BrowserUiAutomationRouteOwner } from '@/daemon/runtimeActionExecutor';
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
import { decodeBase64, encodeBase64, encrypt, decrypt, getRandomBytes } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import { assertSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';
import { readStoredCredentials, type Credentials, type StoredCredentials } from '@/persistence';
import {
  readSessionMetadataLayoutVersion,
  tryReadApiSessionMetadataForLayout,
} from '@/session/metadata/sessionMetadataLayout';

import {
  AccountEncryptionMaterialUnavailableError,
  requireAccountEncryptionCredentials,
  resolveMachineEncryptionContext,
  resolveSessionEncryptionContext,
} from './client/encryptionKey';
import { serializeAxiosErrorForLog } from './client/serializeAxiosErrorForLog';
import { logServerEndpointFailure } from './client/serverEndpointFailureLog';
import { resolveServerHttpBaseUrl } from './client/serverHttpBaseUrl';
import { readAccountEncryptionModeOnce } from './client/accountEncryptionMode';
import { resolveConnectedServicesServerApiTimeoutMs } from './client/connectedServicesServerApiTimeout';
import { SessionCreationPlacementError } from './session/sessionCreationPlacementError';
import {
  buildSessionInitialAccessCreateFields,
  materializeSessionInitialAccessCreateFields,
  prepareSessionInitialAccessDataKeyEnvelopes,
  readSessionInitialAccessServerError,
} from './session/sessionCreationInitialAccess';
import {
  SessionCreationCorrespondenceConflictError,
} from './session/sessionCreationCorrespondenceConflictError';
import { transformSessionInputThroughPluginHooks } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import { publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceAccountEncryptionMode,
  type ConnectedServiceCredentialApi,
  type ConnectedServiceCredentialPlainResponse,
  type ConnectedServiceCredentialSealedResponse,
  type ConnectedServiceProfileListResult,
} from './client/connectedServiceCredentialApi';
export { ConnectedServiceCredentialUnsupportedFormatError } from './client/connectedServiceCredentialApi';
import { createHttpStatusError, HttpStatusError, readHttpStatus } from './client/httpStatusError';
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
import { ConnectedServiceCredentialHealthV1Schema, ConnectedServiceCredentialCompatibleMutationResponseV1Schema, ConnectedServiceCredentialMutationResponseV1Schema, ConnectedServiceCredentialRevisionV1Schema, SealedConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { parseBuiltInLegacyConnectedServiceQuotaSnapshotV1, projectBuiltInLegacyConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodePlainMachineStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { SESSION_METADATA_LAYOUT_VERSION_V1, StoredSessionOwnerMetadataEnvelopeV1Schema, StoredSessionSharedMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionOrganizationPlacementV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { sessionCreationCorrespondenceMatchesV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
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
  SessionMetadata,
  SessionOwnerMetadataV1,
} from '@happier-dev/protocol';
import { resolveSessionCreateEncryptionMode } from '@/api/session/resolveSessionCreateEncryptionMode';
import { consumeMachineReplacementCandidateAfterRegistration } from '@/daemon/machineIdentity/machineReplacementCandidates';
import { resolveMachineRegistrationIdentity } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';
import { resolveSessionEncryptionContextFromCredentials, tryDecryptSessionOwnerMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import {
  buildSessionMetadataEnvelopeCreateFields,
  SessionMetadataPrivacyUpgradeRequiredError,
} from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
export { SessionMetadataPrivacyUpgradeRequiredError } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { SessionReportsToV1Schema } from '@happier-dev/protocol/sessions/relations/sessionReportsToV1';
import { SessionAwarenessOriginV1Schema } from '@happier-dev/protocol/sessions/awareness/projectionV1';

type PublishedMachineRow = import('@happier-dev/protocol/machines/machineContentKeyTransitionV1').MachinePublishedRowV1;

export class MachineContentKeyOutcomeUnknownError extends Error {
  readonly code = 'machine_content_key_outcome_unknown' as const;
  constructor(readonly machineId: string) {
    super(`The content key transition for Machine ${machineId} could not be confirmed`);
    this.name = 'MachineContentKeyOutcomeUnknownError';
  }
}

export class MachineContentKeyTransitionRefusedError extends Error {
  constructor(readonly machineId: string, readonly code: 'forbidden' | 'machine_unavailable' | 'machine_storage_mode_mismatch' | 'encryption_material_unavailable') {
    super(`The content key transition for Machine ${machineId} was refused (${code})`);
    this.name = 'MachineContentKeyTransitionRefusedError';
  }
}

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
  private getComputerRoutes: (() => ComputerRoutes | null) | null = null;
  private getBrowserUiAutomation: (() => BrowserUiAutomationRouteOwner | null) | null = null;
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
  private refreshCachedServerFeaturesSnapshot: (() => Promise<CliServerFeaturesSnapshot | undefined>) | null = null;
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

  setComputerRoutesProvider(provider: (() => ComputerRoutes | null) | null): void {
    this.getComputerRoutes = provider;
  }

  setBrowserUiAutomationProvider(provider: (() => BrowserUiAutomationRouteOwner | null) | null): void {
    this.getBrowserUiAutomation = provider;
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
  setServerFeaturesSnapshotProvider(
    provider: (() => CliServerFeaturesSnapshot | undefined) | null,
    refresh?: (() => Promise<CliServerFeaturesSnapshot | undefined>) | null,
  ): void {
    this.getCachedServerFeaturesSnapshot = provider;
    this.refreshCachedServerFeaturesSnapshot = refresh ?? null;
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
        computer: this.getComputerRoutes?.() ?? null,
        browserControl: this.getBrowserDaemonControlRoutes?.() ?? null,
        browserContext: this.getBrowserDaemonContextRoutes?.() ?? null,
        browserAutomation: this.getBrowserDaemonAutomationRoutes?.() ?? null,
        browserUiAutomation: this.getBrowserUiAutomation?.() ?? null,
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

  createConfidentialSecretFillExecutor(input: Readonly<{
    machineId(): string | null;
    readHostIdentity(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
  }>) {
    return createConfidentialSecretFillExecutor({
      expectedScopeKey: resolveAccountSettingsScopeKeyForToken(this.credential.token),
      expectedAccountId: readAccountIdFromToken(this.credential.token),
      serverId: configuration.activeServerId,
      machineId: input.machineId,
      readHostIdentity: input.readHostIdentity,
      readAccountMode: async (signal) => (await fetchAccountEncryptionCurrentness({
        token: this.credential.token, ...(signal ? { signal } : {}),
      })).mode,
      prepareTarget: async (args) => {
        // The pinned native contract cannot prove keyboard focus; never route credentials to raw type.
        if (args.actionId === 'computer.secret.fill') return { status: 'refused', code: 'field_verification_unsupported' };
        const routes = this.getBrowserDaemonAutomationRoutes?.();
        if (!routes) return { status: 'refused', code: 'target_unavailable' };
        // Browser owns its observation hold and actual-launch qualification. The consumer
        // refuses missing qualification before materialization; headless needs no native embargo.
        return routes.prepareConfidentialFill(args.request, args.context);
      },
    });
  }

  async getServerFeaturesSnapshot(
    options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>,
  ): Promise<CliServerFeaturesSnapshot | undefined> {
    if (options?.refresh === true) {
      const sharedRefresh = this.refreshCachedServerFeaturesSnapshot;
      if (sharedRefresh) {
        const request = sharedRefresh();
        const signal = options.signal;
        if (!signal) return await request;
        signal.throwIfAborted();
        return await new Promise<CliServerFeaturesSnapshot | undefined>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          void request.then(
            (snapshot) => {
              signal.removeEventListener('abort', onAbort);
              resolve(snapshot);
            },
            (error) => {
              signal.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        });
      }
      return await fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
        signal: options.signal,
      });
    }
    return this.getCachedServerFeaturesSnapshot?.();
  }

  /** Home remains the credential custodian; this forwards only the signed, content-free proof envelope. */
  async authorizeRunnerBrokerReadiness(
    request: RunnerBrokerReadinessRequestV1,
    signal: AbortSignal,
  ): Promise<RunnerBrokerReadinessResponseV1> {
    signal.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${PROVIDER_BROKER_READINESS_AUTHORIZE_HTTP_PATH_V1.replace(':resourceId', encodeURIComponent(request.resourceId))}`,
      request,
      {
        headers: {
          Authorization: `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        signal,
        timeout: 30_000,
      },
    );
    return RunnerBrokerReadinessResponseV1Schema.parse(response.data);
  }

  setLocalMachineId(machineId: string | null | undefined): void {
    this.localMachineId = normalizeLocalMachineId(machineId);
  }

  /**
   * Create a new session or load existing one with the given tag. Creation
   * accepts the canonical protocol metadata shape because a pre-committed
   * Session may not have runtime-owned workspace identity until attach.
   */
  async getOrCreateSession(opts: import('@happier-dev/protocol').SessionCreateOriginFieldsV1 & {
    tag: string,
    metadata: SessionMetadata,
    state: AgentState | null,
    organizationPlacement?: import('@happier-dev/protocol').SessionOrganizationPlacementV1,
    initialAccess?: import('@happier-dev/protocol').SessionInitialAccessDraftV1,
    initialTriggers?: readonly import('@happier-dev/protocol').SessionInitialTriggerAdmissionV1[],
    reportsTo?: import('@happier-dev/protocol').SessionReportsToV1,
    primaryTeamId?: string | null,
    teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1,
    creationAuthorizationToken?: string,
    signal?: AbortSignal,
  }): Promise<SessionCreateOrLoadResult | null> {
    opts.signal?.throwIfAborted();
    const sessionsUrl = `${resolveServerHttpBaseUrl()}/v1/sessions`;

    // One terminal classification for every failure this call can meet on its
    // way to a Session: the Account currentness preflight and the sessions
    // request share transport, credentials and the offline/auth contract.
    const settleGetOrCreateSessionFailure = (error: unknown): null => {
      // Never log raw Axios errors: they can contain bearer tokens or vendor keys.
      logger.debug('[API] [ERROR] Failed to get or create session:', serializeAxiosErrorForLog(error));

      // The canonical status reader: the currentness preflight's cause is an
      // HttpStatusError (a minimal Axios-like carrier, not an Axios error), so
      // branding is not a reliable discriminator here.
      const terminalAuthStatus = readHttpStatus(error);
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
    };

    const serverBaseUrl = resolveServerHttpBaseUrl();
    const encryptionModeResolution = await resolveSessionCreateEncryptionMode({
      token: this.credential.token,
      serverBaseUrl,
      accountTimeoutMs: 10_000,
    });
    if (encryptionModeResolution.status === 'currentness_unavailable') {
      // The read failed before any Session request; classify the transport
      // failure it wraps exactly as the sessions request's own would be. An
      // unavailable currentness is never reinterpreted as a Plain Account.
      const { error } = encryptionModeResolution;
      return settleGetOrCreateSessionFailure(error.cause ?? error);
    }
    const {
      desiredSessionEncryptionMode,
      accountEncryptionCurrentness,
      serverSupportsFeatureSnapshot,
      serverFeaturesSnapshot,
    } = encryptionModeResolution;
    const initialAccessCreateFields = buildSessionInitialAccessCreateFields(opts, serverFeaturesSnapshot);
    const creationMetadata = opts.metadata;
    const encryptionContext = desiredSessionEncryptionMode === 'e2ee'
      ? resolveSessionEncryptionContext(this.credential)
      : null;
    const materializedInitialAccessCreateFields = await materializeSessionInitialAccessCreateFields({
      fields: initialAccessCreateFields,
      sessionEncryptionMode: desiredSessionEncryptionMode,
      sessionDataKey: encryptionContext?.encryptionVariant === 'dataKey'
        ? encryptionContext.encryptionKey
        : null,
      token: this.credential.token,
      serverHttpBaseUrl: serverBaseUrl,
      ...(opts.signal ? { signal: opts.signal } : {}),
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
        const metadataEnvelopeFields = desiredSessionEncryptionMode === 'plain'
          ? buildSessionMetadataEnvelopeCreateFields({
              credentials: this.credential,
              accountEncryptionMode: accountEncryptionCurrentness.mode,
              metadata: creationMetadata,
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
                metadata: creationMetadata,
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
            ...pickSessionCreateOriginFields(opts),
            ...(opts.reportsTo !== undefined ? { reportsTo: opts.reportsTo } : {}),
            ...materializedInitialAccessCreateFields,
            ...(opts.initialTriggers !== undefined ? { initialTriggers: opts.initialTriggers } : {}),
            ...metadataEnvelopeFields,
            dataEncryptionKey:
              desiredSessionEncryptionMode === 'plain'
                ? null
                : encryptionContext?.dataEncryptionKey
                  ? encodeBase64(encryptionContext.dataEncryptionKey)
                  : null,
            ...(serverSupportsFeatureSnapshot ? { encryptionMode: desiredSessionEncryptionMode } : {}),
            ...(opts.organizationPlacement ? { organizationPlacement: opts.organizationPlacement } : {}),
            ...(opts.teamCredentialBindings !== undefined ? { teamCredentialBindings: opts.teamCredentialBindings } : {}),
          },
          {
            headers: {
              ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
              ...(opts.creationAuthorizationToken ? { [SESSION_CREATION_AUTHORIZATION_HEADER_V1]: opts.creationAuthorizationToken } : {}),
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000, // 1 minute timeout for very bad network connections
            ...(opts.signal ? { signal: opts.signal } : {}),
          }
        )

        logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
        let raw = response.data.session;
        const reportsTo = SessionReportsToV1Schema.safeParse(raw.reportsTo);
        const origin = SessionAwarenessOriginV1Schema.safeParse(raw.origin);
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
        const ensureLocalMachineAccess = async () => {
          if (!this.localMachineId) return;
          // Machine admission may begin as soon as creation settles. The
          // Session socket also ensures this binding, but can connect later.
          await ensureSessionMachineAccessKeyBinding({
            serverUrl: serverBaseUrl,
            token: this.credential.token,
            sessionId: raw.id,
            machineId: this.localMachineId,
          });
        };

        const sessionEncryptionMode: 'e2ee' | 'plain' =
          (raw as any)?.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        assertSessionEncryptionModeAllowedByEffectiveClientRequirement(sessionEncryptionMode);
        const metadataLayoutVersion = readSessionMetadataLayoutVersion(raw.metadataLayoutVersion);
        const rawOwnerMetadata =
          (raw as Readonly<{ ownerMetadata?: unknown }>).ownerMetadata;
        const parsedOwnerMetadataEnvelope =
          StoredSessionOwnerMetadataEnvelopeV1Schema.safeParse(
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
            sharedMetadata: StoredSessionSharedMetadataV1Schema.parse(decodedMetadata),
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
          await ensureLocalMachineAccess();
          return {
            id: raw.id,
            seq: raw.seq,
            workDepth: typeof raw.workDepth === 'number' ? raw.workDepth : 0,
            ...(reportsTo.success ? { reportsTo: reportsTo.data } : {}),
            ...(origin.success ? { origin: origin.data } : {}),
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

        const keyedCredential = requireAccountEncryptionCredentials(this.credential);
        const responseEncryptionContext = resolveSessionEncryptionContextFromCredentials(keyedCredential, raw);
        if (!responseEncryptionContext) throw new Error('Failed to open session dataEncryptionKey');
        const sessionEncryptionKey = responseEncryptionContext.encryptionKey;
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
        await prepareSessionInitialAccessDataKeyEnvelopes({
          fields: initialAccessCreateFields,
          sessionId: raw.id,
          sessionEncryptionMode,
          resolveSessionDataKey: () => responseEncryptionContext.encryptionVariant === 'dataKey' ? sessionEncryptionKey : null,
          token: this.credential.token,
          serverHttpBaseUrl: serverBaseUrl,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        await ensureLocalMachineAccess();
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
          workDepth: typeof raw.workDepth === 'number' ? raw.workDepth : 0,
          ...(reportsTo.success ? { reportsTo: reportsTo.data } : {}),
          ...(origin.success ? { origin: origin.data } : {}),
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
        const initialTriggerError = axios.isAxiosError(error) && typeof status === 'number'
          ? readSessionCreationInitialTriggerError(error.response?.data, status)
          : null;
        if (initialTriggerError) throw initialTriggerError;
        const initialAccessServerError = axios.isAxiosError(error) && typeof status === 'number'
          ? readSessionInitialAccessServerError(error.response?.data, status)
          : null;
        if (initialAccessServerError) throw initialAccessServerError;
        const isRetryable5xx = typeof status === 'number' && status >= 500 && status < 600;
        if (isRetryable5xx && attempt < retryMaxAttempts) {
          // Do not log raw Axios errors: they can contain bearer tokens or vendor keys.
          logger.debug('[API] [WARN] getOrCreateSession transient server error, retrying:', serializeAxiosErrorForLog(error));
          const delayMs = Math.min(retryMaxDelayMs, retryBaseDelayMs * Math.pow(2, attempt - 1));
          await sleep(delayMs);
          continue;
        }

        return settleGetOrCreateSessionFailure(error);
      }
    }

    // Unreachable (retryMaxAttempts is min 1); keep TS happy.
    return null;
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getMachine(machineId: string, options?: Readonly<{ signal?: AbortSignal;
    authorization?: ExternalActionExecutionAuthorizationV1;
    effectActionId?: string }>): Promise<Machine | null> {
    if (options?.authorization) return ApiClient.getRequesterMachine(machineId, { ...options, authorization: options.authorization });
    options?.signal?.throwIfAborted();
    const accountMode = await this.getAccountEncryptionMode({ signal: options?.signal });
    const raw = await this.readPublishedMachineRow(machineId, options);
    return raw ? this.decodePublishedMachine(machineId, raw, accountMode) : null;
  }

  /** A private projection supplies crypto; the original carrier supplies every outward request. */
  static async getRequesterMachine(machineId: string, options: Readonly<{ authorization: ExternalActionExecutionAuthorizationV1;
    signal?: AbortSignal; effectActionId?: string }>): Promise<Machine | null> {
    options.signal?.throwIfAborted();
    const account = options.authorization.requesterAccountProjection;
    const http = options.authorization.requesterHttpProjection;
    if (!account || !http || account.accountId !== options.authorization.binding.accountId
      || account.accountId !== http.accountId || account.serverId !== http.serverId
      || !await account.isCurrent() || !await http.isCurrent()) throw new MachineContentKeyUnavailableError(machineId);
    const raw = await ApiClient.readPublishedMachineRowForAuthority(machineId, undefined, options);
    if (!await account.isCurrent() || !await http.isCurrent()) throw new MachineContentKeyUnavailableError(machineId);
    options.signal?.throwIfAborted();
    return raw ? ApiClient.decodePublishedMachineForAuthority(machineId, raw, account.accountEncryptionMode, undefined, options.authorization) : null;
  }

  private async readPublishedMachineRow(machineId: string, options?: Readonly<{ signal?: AbortSignal;
    authorization?: ExternalActionExecutionAuthorizationV1;
    effectActionId?: string }>): Promise<PublishedMachineRow | null> {
    return ApiClient.readPublishedMachineRowForAuthority(machineId, this.credential, options);
  }

  private static async readPublishedMachineRowForAuthority(machineId: string, credentials: StoredCredentials | undefined,
    options?: Readonly<{ signal?: AbortSignal; authorization?: ExternalActionExecutionAuthorizationV1; effectActionId?: string }>): Promise<PublishedMachineRow | null> {
    try {
      const path = `/v1/machines/${encodeURIComponent(machineId)}`;
      const http = options?.authorization?.requesterHttpProjection;
      const requesterHeaders = http ? await http.createRequestHeaders({ effectActionId: options?.effectActionId ?? options!.authorization!.binding.actionId,
        method: 'GET', path, ...(options?.signal ? { signal: options.signal } : {}) }) : null;
      if (options?.authorization && !requesterHeaders) throw new MachineContentKeyUnavailableError(machineId);
      const response = await axios.get(
        `${http?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${path}`,
        {
          headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...(requesterHeaders ?? { Authorization: `Bearer ${credentials!.token}` }) },
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
      return MachinePublishedRowV1Schema.parse(response.data.machine);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return null;
      throw error;
    }
  }

  private decodePublishedMachine(machineId: string, raw: PublishedMachineRow, accountMode: ConnectedServiceAccountEncryptionMode): Machine & { encryptionMode: 'plain' | 'e2ee' } {
      return ApiClient.decodePublishedMachineForAuthority(machineId, raw, accountMode, this.credential);
  }

  private static decodePublishedMachineForAuthority(machineId: string, raw: PublishedMachineRow,
    accountMode: ConnectedServiceAccountEncryptionMode, credentials?: StoredCredentials, authorization?: ExternalActionExecutionAuthorizationV1): Machine & { encryptionMode: 'plain' | 'e2ee' } {
      if (raw.id !== machineId) throw new MachineContentKeyUnavailableError(machineId);
      const access = raw.access === undefined ? undefined : AccessibleMachineAccessV1Schema.parse(raw.access);
      if (access && access.accessState !== 'ready') throw new MachineContentKeyUnavailableError(machineId);
      const account = authorization?.requesterAccountProjection;
      const foreign = access !== undefined && access.custodian.accountId !== (account?.accountId ?? readAccountIdFromToken(credentials!.token));
      const keyBasis = raw.keyBasis === undefined ? undefined : MachineKeyBasisV1Schema.parse(raw.keyBasis);
      if (keyBasis && (keyBasis.metadataVersion !== raw.metadataVersion || keyBasis.daemonStateVersion !== raw.daemonStateVersion
        || (!foreign && keyBasis.dataEncryptionKey !== (raw.dataEncryptionKey ?? null)))) {
        throw new MachineContentKeyUnavailableError(machineId);
      }
      const expectedAccountMode = access?.resourceMode ?? raw.storageMode ?? accountMode;
      if (authorization && !account?.resolveMachineContentEncryptionContext) throw new MachineContentKeyUnavailableError(machineId);
      const encryptionContext = account?.resolveMachineContentEncryptionContext?.(raw) ?? resolvePublishedMachineEncryptionContext({
        credentials: credentials!,
        machineId,
        expectedAccountMode,
        access: raw.access,
        publishedDataEncryptionKey: raw.dataEncryptionKey,
        machineKind: raw.kind,
        installationId: raw.installationId,
        runnerContentKeyBinding: raw.runnerContentKeyBinding,
      });
      const machineCodec = createMachineContentCodec(encryptionContext);
      const openedMetadata = raw.metadata ? machineCodec.decodeStored(raw.metadata) : null;
      const openedDaemonState = raw.daemonState ? machineCodec.decodeStored(raw.daemonState) : null;
      if ((raw.metadata && openedMetadata === null) || (raw.daemonState && openedDaemonState === null)) {
        throw new MachineContentKeyUnavailableError(machineId);
      }
      const operationProtocolCapabilities = readMachineOperationProtocolCapabilitiesProjectionV1({
        machineId,
        value: raw,
      });

      const common = {
        id: raw.id,
        installationId: raw.installationId,
        active: raw.active,
        revokedAt: raw.revokedAt,
        replacedByMachineId: raw.replacedByMachineId,
        dataEncryptionKey: raw.dataEncryptionKey ?? null,
        ...(keyBasis ? { keyBasis } : {}),
        ...(access ? { access } : {}),
        metadata: projectMachinePublishedMetadataFromRowV1(raw.metadata ? StoredMachinePublishedMetadataV1Schema.parse(openedMetadata) : null, raw.devcontainerChild),
        metadataVersion: raw.metadataVersion || 0,
        daemonState: raw.daemonState ? StoredMachinePublishedDaemonStateV1Schema.parse(openedDaemonState) : null,
        daemonStateVersion: raw.daemonStateVersion || 0,
        operationProtocolCapabilities: operationProtocolCapabilities?.capabilities ?? null,
        operationProtocolCapabilitiesRevision: operationProtocolCapabilities?.revision ?? null,
      };
      return encryptionContext.encryptionMode === 'plain'
        ? { ...common, encryptionMode: 'plain' }
        : {
            ...common,
            encryptionMode: 'e2ee',
            encryptionKey: encryptionContext.encryptionKey,
            encryptionVariant: encryptionContext.encryptionVariant,
          };
  }

  /** Owner preparation converts historical content once; an ambiguous POST is never replayed. */
  async prepareMachineContentKey(machineId: string, options?: Readonly<{
    signal?: AbortSignal;
    /** A captured Home/Account transport, including private Action continuation authority. */
    request?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown; signal?: AbortSignal }>) => Promise<Readonly<{ status: number; data: unknown }>>;
    isCurrent?: () => boolean | Promise<boolean>;
  }>): Promise<Machine> {
    const assertCurrent = async () => {
      if (await options?.isCurrent?.() === false) throw new MachineContentKeyUnavailableError(machineId);
    };
    const request = async (method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal) => {
      await assertCurrent();
      const response = options?.request
        ? await options.request({ method, path, ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) })
        : method === 'GET'
          ? await axios.get<unknown>(`${resolveServerHttpBaseUrl()}${path}`, {
              headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${this.credential.token}` },
              ...(signal ? { signal } : {}),
            })
          : await axios.post<unknown>(`${resolveServerHttpBaseUrl()}${path}`, body, {
              headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${this.credential.token}` },
              ...(signal ? { signal } : {}),
            });
      await assertCurrent();
      return response;
    };
    options?.signal?.throwIfAborted();
    const boundAccountMode = options?.request ? await readAccountEncryptionModeOnce({
      request: () => request('GET', '/v1/account/encryption', undefined, options.signal),
    }) : null;
    const accountMode = boundAccountMode
      ? boundAccountMode.kind === 'resolved' ? boundAccountMode.mode : 'unknown'
      : await this.getAccountEncryptionMode({ signal: options?.signal });
    const observe = async (signal?: AbortSignal): Promise<PublishedMachineRow> => {
      const response = await request('GET', `/v1/machines/${encodeURIComponent(machineId)}`, undefined, signal);
      if (response.status !== 200) throw new MachineContentKeyUnavailableError(machineId);
      if (!response.data || typeof response.data !== 'object' || !('machine' in response.data)) throw new MachineContentKeyUnavailableError(machineId);
      return MachinePublishedRowV1Schema.parse(response.data.machine);
    };
    const custodianAccountId = readAccountIdFromToken(this.credential.token);
    if (!custodianAccountId) throw new MachineContentKeyUnavailableError(machineId);
    try {
      return await prepareMachineContentKeyV1({ machineId,
        custodianAccountId, material: this.credential.encryption,
        ...(this.credential.encryption?.type === 'dataKey' ? { dataKeyPublicKey: this.credential.encryption.publicKey } : {}),
        randomBytes: getRandomBytes, observe, signal: options?.signal, isCurrent: options?.isCurrent,
        open: raw => this.decodePublishedMachine(machineId, raw, accountMode),
        decodeStored: (machine, ciphertext) => createMachineContentCodec(machine).decodeStored(ciphertext),
        encodeStored: (encryptionKey, value) => createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey, encryptionVariant: 'dataKey' }).encodeStored(value),
        transition: async (input, signal) => {
          try {
            const response = await request('POST', `/v1/machines/${encodeURIComponent(machineId)}/content-key/transition`, input, signal);
            return MachineContentKeyTransitionResultV1Schema.parse(response.data);
          } catch (error) {
            const refusal = axios.isAxiosError(error) && error.response
              ? MachineContentKeyTransitionResultV1Schema.safeParse(error.response.data) : null;
            if (refusal?.success && refusal.data.kind === 'refused') throw new MachineContentKeyPreparationErrorV1(refusal.data.code, true);
            throw error;
          }
        },
      });
    } catch (error) {
      if (error instanceof MachineContentKeyPreparationErrorV1) {
        if (error.code === 'machine_content_key_outcome_unknown') throw new MachineContentKeyOutcomeUnknownError(machineId);
        if (error.refusal) throw new MachineContentKeyTransitionRefusedError(machineId, error.code);
        if (error.code === 'machine_unavailable') throw new MachineContentKeyUnavailableError(machineId);
        if (error.code === 'encryption_material_unavailable') throw new AccountEncryptionMaterialUnavailableError();
        throw new MachineContentKeyTransitionRefusedError(machineId, error.code);
      }
      throw error;
    }
  }

  async mintPeerMediationRouteGrant(request: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}/v1/machines/peer/mediation/route-grants`,
      request,
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    if (response.data?.ok !== true || response.data.grant === undefined) {
      throw new Error('Peer mediation route grant is unavailable');
    }
    return response.data.grant;
  }

  async openTeamCredentialProviderBroker(
    request: ProviderBrokerOpenRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProviderBrokerOpenResponseV1> {
    return await openTeamCredentialProviderBroker({
      token: this.credential.token,
      request,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  }

  async getTeamCredentialResource(
    resourceId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TeamCredentialResourceSummaryV1> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.get']}`,
      { resourceId },
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return TeamCredentialResourceSummaryV1Schema.parse(response.data);
  }

  async admitTeamCredentialProviderBrokerRequest(
    request: ProviderBrokerRequestAdmissionV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProviderBrokerRequestAdmissionResponseV1> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${PROVIDER_BROKER_REQUEST_ADMISSION_HTTP_PATH_V1}`,
      ProviderBrokerRequestAdmissionV1Schema.parse(request),
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return ProviderBrokerRequestAdmissionResponseV1Schema.parse(response.data);
  }

  async authorizeTeamCredentialProviderModelCatalog(
    request: ProviderBrokerModelCatalogAuthorizationV1 | TeamCredentialExternalProviderModelCatalogAuthorizationV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProviderBrokerModelCatalogAuthorizationResponseV1> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${PROVIDER_BROKER_MODEL_CATALOG_AUTHORIZE_HTTP_PATH_V1}`,
      ('authority' in request
        ? ProviderBrokerModelCatalogAuthorizationV1Schema
        : TeamCredentialExternalProviderModelCatalogAuthorizationV1Schema).parse(request),
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return ProviderBrokerModelCatalogAuthorizationResponseV1Schema.parse(response.data);
  }

  async admitTeamCredentialExternalProviderRequest(
    request: TeamCredentialExternalProviderAdmissionV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TeamCredentialExternalProviderAdmissionResponseV1> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_ADMISSION_HTTP_PATH_V1}`,
      TeamCredentialExternalProviderAdmissionV1Schema.parse(request),
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return TeamCredentialExternalProviderAdmissionResponseV1Schema.parse(response.data);
  }

  async recordTeamCredentialExternalProviderTerminalUsage(
    request: TeamCredentialExternalProviderTerminalUsageV1,
  ): Promise<TeamCredentialExternalProviderTerminalUsageResponseV1> {
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_TERMINAL_USAGE_HTTP_PATH_V1}`,
      TeamCredentialExternalProviderTerminalUsageV1Schema.parse(request),
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
      },
    );
    return TeamCredentialExternalProviderTerminalUsageResponseV1Schema.parse(response.data);
  }

  async admitTeamCredentialResourceTestRequest(
    request: TeamCredentialResourceTestAdmissionV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<TeamCredentialResourceTestAdmissionResponseV1> {
    options?.signal?.throwIfAborted();
    const response = await axios.post(
      `${resolveServerHttpBaseUrl()}${TEAM_CREDENTIAL_RESOURCE_TEST_ADMISSION_HTTP_PATH_V1}`,
      TeamCredentialResourceTestAdmissionV1Schema.parse(request),
      {
        headers: { Authorization: `Bearer ${this.credential.token}`, 'Content-Type': 'application/json' },
        timeout: 10_000,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    return TeamCredentialResourceTestAdmissionResponseV1Schema.parse(response.data);
  }

  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
    timeoutMs?: number,
    registrationIdentity?: MachineRegistrationIdentity,
    managedEnrollment?: ManagedEnrollmentCorrelationV1,
  }): Promise<Machine> {
    const managedEnrollment = opts.managedEnrollment
      ? ManagedEnrollmentCorrelationV1Schema.parse(opts.managedEnrollment) : undefined;
    const devcontainerChild = managedEnrollment ? deriveManagedDevcontainerChildProjectionV1({
      managedMachineId: managedEnrollment.managedId, controllerMachineId: managedEnrollment.controller.machineId,
      enrolledMachineId: opts.machineId, resource: managedEnrollment.resource,
    }) : undefined;
    const accountMode = await this.getAccountEncryptionMode({ throwOnTransportError: true });
    if (accountMode === 'unknown') throw new MachineContentKeyUnavailableError(opts.machineId);
    const machineStorageMode = accountMode === 'plain' ? 'plain' : 'e2ee';
    const incumbentRow = await this.readPublishedMachineRow(opts.machineId);
    const incumbent = incumbentRow ? this.decodePublishedMachine(opts.machineId, incumbentRow, accountMode) : null;
    if (incumbent?.access && incumbent.access.custodian.accountId !== readAccountIdFromToken(this.credential.token)) {
      throw new MachineContentKeyUnavailableError(opts.machineId);
    }
    const encryptionContext = !incumbent && machineStorageMode === 'e2ee'
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
    const registrationIdentity = opts.registrationIdentity
      ? MachineRegistrationIdentitySchema.parse(opts.registrationIdentity)
      : await this.resolveMachineRegistrationIdentity(opts.machineId);
    const metadata = devcontainerChild
      ? parseMachinePublishedMetadataV1({ ...(incumbent?.metadata ?? opts.metadata), devcontainerChild })
      : parseMachinePublishedMetadataV1(opts.metadata);
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
          ...(managedEnrollment ? { managedEnrollment } : {}),
          metadata: incumbentRow
            ? incumbentRow.metadata ?? createMachineContentCodec(incumbent!).encodeStored(metadata)
            : encodeMachineContent(metadata),
          daemonState: incumbentRow ? incumbentRow.daemonState ?? undefined : opts.daemonState
            ? encodeMachineContent(parseMachinePublishedDaemonStateV1(opts.daemonState))
            : undefined,
          dataEncryptionKey: incumbentRow ? incumbentRow.dataEncryptionKey ?? null : machineStorageMode === 'plain'
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

      // Registration may return an incumbent/winning row, never the proposed context.
      return this.decodePublishedMachine(opts.machineId, MachinePublishedRowV1Schema.parse(raw), accountMode);
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
      | 'actionsSettingsProvider'
    > & Partial<Pick<ApiSessionClientOptions, 'metadataAuthority'>> = {},
  ): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session, {
      transport: createAccountSessionClientTransport(this.credential.token),
      metadataAuthority: sessionOptions.metadataAuthority
        ?? { kind: 'owner', credentials: this.credential, readCurrentCredentials: readStoredCredentials },
      ...(sessionOptions.actionsSettingsProvider ? { actionsSettingsProvider: sessionOptions.actionsSettingsProvider } : {}),
      getAccountEncryptionCurrentness: async () => await this.getAccountEncryptionCurrentness(),
      getBrowserDaemonControlRoutes: this.getBrowserDaemonControlRoutes,
      getBrowserDaemonContextRoutes: this.getBrowserDaemonContextRoutes,
      getBrowserDaemonAutomationRoutes: this.getBrowserDaemonAutomationRoutes,
      getBrowserUiAutomation: () => this.getBrowserUiAutomation?.() ?? null,
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
      onSessionFollowInvalidated: publishSessionFollowWakeInvalidation,
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
        loadMachine: lifecycleDependencies?.loadMachine ?? ((options) => this.getMachine(machine.id, options)),
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

  async getAccountEncryptionMode(options?: Parameters<ConnectedServiceCredentialApi['getAccountEncryptionMode']>[0]): Promise<ConnectedServiceAccountEncryptionMode> {
    const mode = await this.connectedServiceCredentialApi.getAccountEncryptionMode(options);
    if (mode === 'plain') options?.signal?.throwIfAborted();
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
