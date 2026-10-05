import { createSessionFollowActionDeps, createSessionTrackedTargetCompatibilityDep } from '@/api/sessionFollowActionDeps';
import { createSessionReadStateActionDeps } from '@/api/sessionReadStateActionDeps';
import { importHistoricalSessionTranscript } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import { fetchOpenedSessionStateFromServer } from '@/api/session/snapshotSync';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
  type SessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { resolveCurrentAccountMachineTarget } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { configuration } from '@/configuration';
import { getDaemonMachineAdmissionTransport, getDaemonClientActionExecutor, MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { resolveCliApiTokenForSdk } from '@/auth/cliApiToken';
import {
  normalizeServerHttpBaseUrl,
  runWithServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import {
  resolveLiveDaemonControlTargetForServer,
  resolveLiveDaemonExternalActionEndpoint,
} from '@/daemon/multiDaemon';
import {
  hasStoredSessionCredentialProvenance,
  readSettings,
  sameStoredCredentials,
  type StoredCredentials,
} from '@/persistence';
import {
  isFullSessionId,
  resolveSessionIdOrPrefixFromSessionList,
  type SessionSelectorListPage,
} from '@/session/query/resolveSessionId';
import {
  resolveSessionEncryptionContextFromCredentials,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import {
  getActionSpec,
  normalizeServerIdentityIdCapability,
  resolveActionSessionListAccessFailure,
  PublicActionIdSchema,
  SignedRootActionIdSchema,
  SessionListResultSchema,
  projectSessionSpawnNewApiRequest,
  type ApprovalExecutionOriginV1,
  type ActionExecuteResult,
  type ActionExecutorContext,
  type ActionExecutorDeps,
  type RuntimeActionExecute,
} from '@happier-dev/protocol';
import {
  connect,
  HappierActionError,
  type ActionTarget,
  type PublicActionInputById,
} from '@happier-dev/sdk';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import type {
  ExternalSessionPluginAdmissionOwner,
} from './externalSessions/pluginExternalSessionAdmissionOwner';
import type {
  ResolveAutomationEventAdoptedDefinitionSetV1,
} from '@/plugins/runtime/automations/automationEventActionExecutor';
import type {
  RevalidatePluginActionCallerOccurrence,
  RevalidatePluginActionCallerMaterialization,
} from '@/plugins/runtime/invocation/services/actionCaller';
import type { ComposerAttachmentSendPreparationRegistryV1 } from '@/session/composer/prepareComposerAttachmentDraftsForSendV1';
import type {
  CliActionExactHomeTarget,
  MachineActionDirectTargetTransport,
  SessionActionRpcTransport,
  SessionSpawnDirectTargetTransport,
} from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isSessionBoardActionIdV1 } from '@happier-dev/protocol/sessions/board';

type CliActionExecutor = ReturnType<typeof createCliActionExecutor>;

type PatActionTransportPlan =
  | Readonly<{ kind: 'ready'; input: unknown; target?: ActionTarget }>
  | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>;
type PatReadyActionTransportPlan = Extract<PatActionTransportPlan, Readonly<{ kind: 'ready' }>>;

type CliActionSessionTarget =
  | Readonly<{ ok: true; sessionId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;
type CliActionMachineTarget =
  | Readonly<{ ok: true; machineId: string }>
  | Readonly<{ ok: false; code: string; candidates?: readonly string[] }>;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readPatSessionListPage(value: unknown): SessionSelectorListPage {
  const parsed = SessionListResultSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_session_list_result');
  return {
    sessions: parsed.data.sessions.map((session) => ({
      id: session.id,
      ...(session.tag ? { tag: session.tag } : {}),
    })),
    nextCursor: parsed.data.nextCursor ?? null,
    hasNext: parsed.data.hasNext === true,
  };
}

function actionResolutionFailure(params: Readonly<{
  code: string;
  candidates?: readonly string[];
}>): ActionExecuteResult {
  return {
    ok: false,
    errorCode: params.code,
    error: params.code,
    ...(params.candidates && params.candidates.length > 0
      ? { details: { candidates: params.candidates } }
      : {}),
  };
}

function actionFailure(errorCode: string): ActionExecuteResult {
  return { ok: false, errorCode, error: errorCode };
}

function withExactSessionId(input: unknown, sessionId: string): unknown {
  const record = readRecord(input);
  return record ? { ...record, sessionId } : input;
}

async function resolveConfiguredMachineTarget(): Promise<ActionTarget | null> {
  const settings = await readSettings();
  const machineId = readNonEmptyString(settings.machineId);
  return machineId ? { kind: 'machine', machineId } : null;
}

async function resolveDaemonLocalActionMachineId(serverApiUrl: string): Promise<string | null> {
  const endpoint = await resolveLiveDaemonExternalActionEndpoint(serverApiUrl);
  return endpoint?.machineId ?? null;
}

function encryptedDaemonTarget(credentials: StoredCredentials, machineId: string): ActionTarget | undefined {
  // V2 authenticates an explicit target. The existing live-daemon publication
  // supplies it; bearer-only V1 keeps its implicit local placement contract.
  return resolveCliApiTokenForSdk(credentials.token) !== credentials.token
    ? { kind: 'machine', machineId }
    : undefined;
}

async function resolvePatMachineTarget(params: Readonly<{
  credentials: StoredCredentials;
  requestedMachineId?: string;
  signal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<CliActionMachineTarget> {
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId) {
    if (params.requestedMachineId !== undefined && params.requestedMachineId !== daemonLocalMachineId) {
      return { ok: false, code: 'target_unavailable' };
    }
    return { ok: true, machineId: daemonLocalMachineId };
  }

  if (params.allowConfiguredMachineTarget && params.requestedMachineId === undefined) {
    const configuredTarget = await resolveConfiguredMachineTarget();
    if (configuredTarget?.kind === 'machine') {
      return { ok: true, machineId: configuredTarget.machineId };
    }
  }

  const resolved = await resolveCurrentAccountMachineTarget({
    token: params.credentials.token,
    ...(params.requestedMachineId !== undefined ? { requestedMachineId: params.requestedMachineId } : {}),
    ...(!params.allowConfiguredMachineTarget ? { serverHttpBaseUrl: params.serverApiUrl } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (resolved.kind === 'selected') return { ok: true, machineId: resolved.target.machineId };
  if (resolved.kind === 'selection_required') {
    return { ok: false, code: 'machine_selection_required', candidates: resolved.candidates.map(({ machineId }) => machineId) };
  }
  return { ok: false, code: resolved.code };
}

async function resolvePatSessionTarget(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  machineId?: string;
  signal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<CliActionSessionTarget> {
  if (isFullSessionId(params.idOrPrefix)) {
    return { ok: true, sessionId: params.idOrPrefix };
  }
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { ok: false, code: 'target_unavailable' };
  }
  const machineTarget = daemonLocalMachineId
    ? null
    : await resolvePatMachineTarget({
        credentials: params.credentials,
        ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        serverApiUrl: params.serverApiUrl,
        allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
      });
  if (machineTarget && !machineTarget.ok) return machineTarget;
  return await resolveSessionIdOrPrefixFromSessionList({
    idOrPrefix: params.idOrPrefix,
    ...(params.signal ? { signal: params.signal } : {}),
    listPage: async ({ limit, cursor, archivedOnly }) => {
      const client = connect({
        endpoint: params.serverApiUrl,
        token: resolveCliApiTokenForSdk(params.credentials.token),
      });
      try {
        const result = await client.actions.execute(
          'session.list',
          {
            limit,
            archivedOnly,
            ...(cursor ? { cursor } : {}),
          },
          {
            ...(machineTarget ? { target: { kind: 'machine', machineId: machineTarget.machineId } }
              : daemonLocalMachineId ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) } : {}),
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
        return readPatSessionListPage(result);
      } finally {
        await client.close();
      }
    },
  });
}

function combineInvocationSignals(
  invocationSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!invocationSignal) return requestSignal;
  if (!requestSignal || requestSignal === invocationSignal) return invocationSignal;
  return AbortSignal.any([invocationSignal, requestSignal]);
}

async function resolvePatActionTransportPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<PatActionTransportPlan> {
  const publicActionId = PublicActionIdSchema.safeParse(params.actionId);
  if (!publicActionId.success) {
    return { kind: 'settled', result: actionFailure('unsupported') };
  }

  const spec = getActionSpec(publicActionId.data);
  const workflowProjectTarget = publicActionId.data === 'workflow.run.start'
    && params.context?.externalActionTarget?.kind === 'machine'
    ? params.context.externalActionTarget.project
    : undefined;
  if (publicActionId.data === 'workflow.run.start' && !workflowProjectTarget) {
    return { kind: 'settled', result: actionFailure('target_required') };
  }
  const daemonLocalMachineId = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
  if (daemonLocalMachineId && params.machineId !== undefined && params.machineId !== daemonLocalMachineId) {
    return { kind: 'settled', result: actionFailure('target_unavailable') };
  }
  if (publicActionId.data === 'session.spawn_new') {
    // The public API owns a distinct spawn-input projection: placement is
    // envelope metadata and daemon-local server identity must never cross this
    // boundary. Do not duplicate its projection in the CLI adapter.
    try {
      const projection = projectSessionSpawnNewApiRequest(params.input);
      return {
        kind: 'ready',
        input: projection.input,
        ...(daemonLocalMachineId
          ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) }
          : { target: projection.target }),
      };
    } catch {
      return { kind: 'settled', result: actionFailure('invalid_parameters') };
    }
  }
  const inputSessionId = readNonEmptyString(readRecord(params.input)?.sessionId);
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  // The generic Session command resolves its positional selector before
  // invoking this adapter; first-class CLI and MCP Actions carry `sessionId`.
  // In each case the selector remains this adapter's only Session-target input
  // and is resolved to the immutable Session id before crossing the API seam.
  const requestedSessionId = (spec.contextualDefaults?.sessionId === 'current_session'
    ? readNonEmptyString(params.context?.defaultSessionId)
    : null)
    ?? (spec.executionPlacement === 'session' ? inputSessionId : null);
  if (requestedSessionId) {
    const resolved = await resolvePatSessionTarget({
      credentials: params.credentials,
      idOrPrefix: requestedSessionId,
      ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
      ...(signal ? { signal } : {}),
      serverApiUrl: params.serverApiUrl,
      allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
    });
    if (!resolved.ok) {
      return {
        kind: 'settled',
        result: actionResolutionFailure({
          code: resolved.code,
          ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
        }),
      };
    }
    return {
      kind: 'ready',
      // Board authorization is revalidated at its exact Session-owned effect
      // route. Local daemon delivery does not change that authority target.
      ...(isSessionBoardActionIdV1(publicActionId.data)
        ? { target: { kind: 'session' as const, sessionId: resolved.sessionId } }
        : daemonLocalMachineId
          ? { target: encryptedDaemonTarget(params.credentials, daemonLocalMachineId) }
          : params.machineId !== undefined
            ? { target: { kind: 'machine' as const, machineId: params.machineId } }
            : { target: { kind: 'session' as const, sessionId: resolved.sessionId } }),
      input: withExactSessionId(params.input, resolved.sessionId),
    };
  }

  if (spec.executionPlacement === 'session') {
    return { kind: 'settled', result: actionFailure('target_required') };
  }

  if (daemonLocalMachineId) {
    if (workflowProjectTarget && workflowProjectTarget.machineId !== daemonLocalMachineId) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const target = encryptedDaemonTarget(params.credentials, daemonLocalMachineId);
    return {
      kind: 'ready',
      input: params.input,
      ...(target
        ? { target: { ...target, ...(workflowProjectTarget ? { project: workflowProjectTarget } : {}) } }
        : workflowProjectTarget
          ? { target: { kind: 'machine', machineId: daemonLocalMachineId, project: workflowProjectTarget } }
          : {}),
    };
  }

  const target = await resolvePatMachineTarget({
    credentials: params.credentials,
    ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
    ...(signal ? { signal } : {}),
    serverApiUrl: params.serverApiUrl,
    allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
  });
  if (!target.ok) return { kind: 'settled', result: actionResolutionFailure(target) };
  if (workflowProjectTarget && workflowProjectTarget.machineId !== target.machineId) {
    return { kind: 'settled', result: actionFailure('target_unavailable') };
  }
  return {
    kind: 'ready',
    target: { kind: 'machine', machineId: target.machineId, ...(workflowProjectTarget ? { project: workflowProjectTarget } : {}) },
    input: params.input,
  };
}

function createOneShotPatInvocation(runOnce: () => Promise<ActionExecuteResult>) {
  let resultPromise: Promise<ActionExecuteResult> | null = null;
  return Object.freeze({
    run: () => {
      resultPromise ??= Promise.resolve().then(runOnce);
      return resultPromise;
    },
  });
}

// Target selection is already settled in the resolved plan; this executor only
// dispatches it, so it never re-reads the configured-machine allowance.
async function executePatPublicActionPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  plan: PatReadyActionTransportPlan;
  context: ActionExecutorContext | undefined;
  invocationSignal?: AbortSignal;
  serverApiUrl: string;
}>): Promise<ActionExecuteResult> {
  const publicActionId = PublicActionIdSchema.parse(params.actionId);
  const client = connect({ endpoint: params.serverApiUrl, token: resolveCliApiTokenForSdk(params.credentials.token) });
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  try {
    // `createCliActionExecutor` accepts unknown because it is the canonical
    // Action owner. The daemon ingress validates the public input schema.
    const result = await client.actions.execute(
      publicActionId,
      params.plan.input as PublicActionInputById[typeof publicActionId],
      {
        ...(params.plan.target ? { target: params.plan.target } : {}),
        ...(params.context?.actionRequestId
          ? { requestId: params.context.actionRequestId }
          : {}),
        ...(signal ? { signal } : {}),
      },
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof HappierActionError) {
      return {
        ok: false,
        errorCode: error.code,
        error: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function executePatPublicAction(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<ActionExecuteResult> {
  const plan = await resolvePatActionTransportPlan(params);
  if (plan.kind === 'settled') return plan.result;
  return await executePatPublicActionPlan({
    actionId: params.actionId,
    credentials: params.credentials,
    plan,
    context: params.context,
    ...(params.invocationSignal ? { invocationSignal: params.invocationSignal } : {}),
    serverApiUrl: params.serverApiUrl,
  });
}

function shouldUsePatPublicActionTransport(
  credentials: StoredCredentials,
  _context: ActionExecutorContext | undefined,
): boolean {
  return credentials.credentialProvenance === 'api_token';
}

type CliActionFixedServerTarget =
  | Readonly<{ serverId?: undefined; serverApiUrl?: undefined }>
  | Readonly<{ serverId: string; serverApiUrl: string }>;

export type CliActionMachineAdmissionTransport = NonNullable<
  Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']
>;

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: StoredCredentials;
  scmFilesystemAccessPolicy?: FilesystemAccessPolicy;
  /** Receives the exact dispatch boundary for Home-owned HTTP Actions. */
  onAccountServerRequestIssued?: () => void;
  /**
   * Stored-content material this composition already holds for one exact
   * Session, for a host whose credentials carry no Account encryption material.
   */
  resolveExactSessionEncryptionMaterial?: (sessionId: string) => SessionTransportEncryptionMaterial | null;
  /** Credential-scoped canonical policy shared with pre-execution discovery. */
  actionsSettingsProvider?: RuntimeActionSettingsProvider;
  /** Exact admitted-turn depth supplied by the authenticated Session host. */
  getCurrentTurnWorkDepth?: Parameters<typeof createCliActionExecutor>[0]['getCurrentTurnWorkDepth'];
  resolvePluginNotifications?: Parameters<typeof createCliActionExecutor>[0]['resolvePluginNotifications'];
  /** Explicit CLI machine selector for public Action transport. */
  machineId?: string;
  readCredentials?: () => Promise<StoredCredentials | null>;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  runtimeActionExecute?: RuntimeActionExecute;
  clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
  workflowAction?: ActionExecutorDeps['workflowAction'];
  workflowAcceptedAuthorizationCurrentness?: Parameters<typeof createCliActionExecutor>[0]['workflowAcceptedAuthorizationCurrentness'];
  sessionActionConfirmation?: ActionExecutorDeps['sessionActionConfirmation'];
  /** Current committed contributed Action declarations for catalog discovery. */
  listContributedActionDefinitions?: ActionExecutorDeps['listContributedActionDefinitions'];
  inputTypeDeps?: Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>;
  /** Daemon-owned execution bypasses its own authenticated control bridge. */
  pluginActionExecutionOwner?: 'daemon_control' | 'current_process';
  /** Root `happier actions` is a signed client of the daemon External Action API. */
  externalActionClient?: true;
  externalSessionPluginAdmissionOwner?: ExternalSessionPluginAdmissionOwner;
  /** The committed plugin-runtime owner for the built-in `action.invoke` Action. */
  invokeContributedAction?: ActionExecutorDeps['invokeContributedAction'];
  /** Exact daemon replay for API target-action approvals. */
  targetActionApprovalReplay?: ActionExecutorDeps['targetActionApprovalReplay'];
  /** Current Account/Home/target proof for durable core Action replay. */
  isApprovalExecutionOriginCurrent?: ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
  /** Canonical daemon Automation occurrence owner for durable replay. */
  isAutomationRunCurrent?: (caller: Extract<
    ApprovalExecutionOriginV1['caller'],
    Readonly<{ kind: 'automationRun' }>
  >) => Promise<boolean> | boolean;
  /** The exact daemon external-session RPC owner for host-stamped API requests. */
  hostExternalSessionAction?: ActionExecutorDeps['hostExternalSessionAction'];
  /** Canonical daemon-owned workspace conflict Action execution. */
  /** Exact daemon-owned Session spawn transport; never a generic peer forwarder. */
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  /** In-process transport to the current daemon's canonical machine Action handlers. */
  machineActionDirectTargetTransport?: MachineActionDirectTargetTransport;
  sessionActionRpcTransport?: SessionActionRpcTransport;
  machineAdmissionTransport?: CliActionMachineAdmissionTransport;
  /** Late-bound plugin-runtime Composer attachments for declared Session input. */
  resolveComposerAttachmentSendPreparation?: () => ComposerAttachmentSendPreparationRegistryV1 | null;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
  }>;
  /**
   * Daemon composition injects its process-lifetime registry so finite Action
   * requests can release leases retained by earlier requests.
   */
  transcriptFollowLeaseRegistry?: SessionTranscriptFollowLeaseRegistry;
  /** Exact installation key used only for proof-bound external Action Home requests. */
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
  /** Cryptographic identity observed from this exact Home endpoint. */
  serverIdentityId?: string;
  /** Exact Action Home's existing feature snapshot source; never probes from a detail read. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
}> & CliActionFixedServerTarget): ReturnType<typeof createCliActionExecutor> & Readonly<{
  bindInvocation(signal: AbortSignal): ReturnType<typeof createCliActionExecutor>;
  resolveSessionTarget(idOrPrefix: string): Promise<CliActionSessionTarget>;
  resolveMachineTarget(): Promise<CliActionMachineTarget>;
}> {
  if (
    (params.serverId === undefined) !== (params.serverApiUrl === undefined)
    || (params.serverId !== undefined && params.serverId.trim().length === 0)
    || (params.serverApiUrl !== undefined && params.serverApiUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  // The guard above already proved both halves travel together; keeping them as
  // one value is what lets the pair reach each Home-bound dependency owner intact.
  const fixedHome: CliActionExactHomeTarget =
    params.serverId !== undefined && params.serverApiUrl !== undefined
      ? {
          serverId: params.serverId.trim(),
          serverHttpBaseUrl: normalizeServerHttpBaseUrl(params.serverApiUrl),
        }
      : {};
  const fixedServerId = fixedHome.serverId ?? null;
  const fixedServerApiUrl = fixedHome.serverHttpBaseUrl ?? null;
  const approvalServerId = fixedServerId ?? configuration.activeServerId;
  const daemonMachineAdmissionTransport = getDaemonMachineAdmissionTransport(approvalServerId);
  if (configuration.isDaemonProcess && !daemonMachineAdmissionTransport) {
    throw new MachineAdmissionTransportUnavailableError();
  }
  const machineAdmissionTransport = daemonMachineAdmissionTransport ?? params.machineAdmissionTransport;
  const approvalServerApiUrl = fixedServerApiUrl ?? configuration.apiServerUrl;
  const resolveActionServerApiUrl = (): string => fixedServerApiUrl ?? configuration.apiServerUrl;
  const runWithActionServer = <T>(run: () => T): T => fixedServerApiUrl
    ? runWithServerHttpBaseUrl(fixedServerApiUrl, run)
    : run();
  const resolveServerFeaturesSnapshotForCredentials = async (
    credentials: StoredCredentials,
  ): Promise<CliServerFeaturesSnapshot | undefined> => params.resolveServerFeaturesSnapshot
    ? await params.resolveServerFeaturesSnapshot()
    : await fetchServerFeaturesSnapshot({
        serverUrl: approvalServerApiUrl,
        token: credentials.token,
      });
  const enrichApprovalRoutingContext = async (
    context: ActionExecutorContext | undefined,
    credentials: StoredCredentials,
  ): Promise<ActionExecutorContext> => {
    let serverIdentityId = readNonEmptyString(context?.serverIdentityId)
      ?? readNonEmptyString(params.serverIdentityId);
    if (!serverIdentityId) {
      const snapshot = await resolveServerFeaturesSnapshotForCredentials(credentials).catch(() => undefined);
      if (snapshot?.status === 'ready' && snapshot.provenance === 'authenticated') {
        serverIdentityId = normalizeServerIdentityIdCapability(
          snapshot.features.capabilities.serverIdentity?.serverIdentityId,
        ) ?? null;
      }
    }
    let machineId = readNonEmptyString(context?.defaultSessionMachineId)
      ?? readNonEmptyString(params.machineId);
    if (!machineId && fixedServerId === null) {
      machineId = readNonEmptyString((await readSettings().catch(() => null))?.machineId);
    }
    return {
      ...(context ?? {}),
      ...(serverIdentityId ? { serverIdentityId } : {}),
      ...(machineId ? { defaultSessionMachineId: machineId } : {}),
    };
  };
  const bindExecutorToActionServer = (source: CliActionExecutor): CliActionExecutor => ({
    prepare: async (...args) => {
      const prepared = await runWithActionServer(async () => await source.prepare(...args));
      if (prepared.kind !== 'ready') return prepared;
      const invocation = prepared.invocation;
      return {
        ...prepared,
        invocation: {
          ...invocation,
          run: () => runWithActionServer(() => invocation.run()),
        },
      };
    },
    execute: async (...args) => await runWithActionServer(async () => await source.execute(...args)),
    replayApprovedApprovalRequest: async (...args) => await runWithActionServer(
      async () => await source.replayApprovedApprovalRequest(...args),
    ),
  });
  const createFollowLeaseRegistry = (): SessionTranscriptFollowLeaseRegistry => (
    params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    })
  );
  const createExecutor = (
    credentials: StoredCredentials,
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
  ): ReturnType<typeof createCliActionExecutor> => {
    const resolveServerFeaturesSnapshot = params.resolveServerFeaturesSnapshot
      ?? (async () => await resolveServerFeaturesSnapshotForCredentials(credentials));
    const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
    const cryptoContext = ctx
      ? { mode: 'e2ee' as const, ctx }
      : { mode: 'plain' as const, ctx: null };

    const isApprovalExecutionOriginCurrent = params.isApprovalExecutionOriginCurrent ?? (async (args) => {
      const currentMachineId = readNonEmptyString(params.machineId)
        ?? (fixedServerId === null
          ? readNonEmptyString((await readSettings().catch(() => null))?.machineId)
          : null);
      if (!currentMachineId) return false;
      const checker = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({
        credentials,
        machineId: currentMachineId,
        serverId: approvalServerId,
        serverApiUrl: approvalServerApiUrl,
        resolveServerFeaturesSnapshot,
        ...(params.isAutomationRunCurrent ? { isAutomationRunCurrent: params.isAutomationRunCurrent } : {}),
        // The same accepted-authorization currentness owner the live Workflow
        // admission below already consumes; a replayed Workflow origin rechecks
        // its principal through it instead of a second check.
        ...(params.workflowAcceptedAuthorizationCurrentness
          ? { isWorkflowRunAuthorizationCurrent: params.workflowAcceptedAuthorizationCurrentness }
          : {}),
      });
      return checker ? await checker(args) : false;
    });

    const sessionFollowActionDeps = createSessionFollowActionDeps({
      token: credentials.token,
      ...fixedHome,
      ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
      ...(params.externalActionMachineRequestPrivateKey
        ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
        : {}),
      prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
        credentials,
        serverHttpBaseUrl: approvalServerApiUrl,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        resolveServerFeaturesSnapshot,
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      }),
    });
    return createCliActionExecutor({
      ...cryptoContext,
      clientActionExecute: params.clientActionExecute ?? getDaemonClientActionExecutor(approvalServerId),
      ...(params.scmFilesystemAccessPolicy ? { scmFilesystemAccessPolicy: params.scmFilesystemAccessPolicy } : {}),
      ...(params.resolveExactSessionEncryptionMaterial
        ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial }
        : {}),
      ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
      serverId: approvalServerId,
      ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
      serverHttpBaseUrl: approvalServerApiUrl,
      ...(params.externalActionMachineRequestPrivateKey
        ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
        : {}),
      ...(params.externalActionMachineInstallationId
        ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
        : {}),
      sessionFollowActionDeps,
      sessionTrackedTargetCompatibilityDeps: createSessionTrackedTargetCompatibilityDep({
        serverId: approvalServerId,
        replaceSessionVoiceInclusions: sessionFollowActionDeps.replaceSessionVoiceInclusions,
      }),
      sessionReadStateActionDeps: createSessionReadStateActionDeps({
        token: credentials.token,
        ...fixedHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
      }),
      accountServerActionDeps: createAccountServerActionDeps({
        token: credentials.token,
        ...(params.onAccountServerRequestIssued
          ? { onRequestIssued: params.onAccountServerRequestIssued }
          : {}),
        credentials,
        ...(params.readCredentials
          ? {
              isCredentialCurrent: async () => sameStoredCredentials(
                credentials,
                await params.readCredentials!().catch(() => null),
              ),
            }
          : {}),
        ...fixedHome,
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.externalActionMachineRequestPrivateKey
          ? { externalActionMachineRequestPrivateKey: params.externalActionMachineRequestPrivateKey }
          : {}),
        ...(params.externalActionMachineInstallationId
          ? { externalActionMachineInstallationId: params.externalActionMachineInstallationId }
          : {}),
        resolveServerFeaturesSnapshot,
      }),
      token: credentials.token,
      credentials,
      resolveServerFeaturesSnapshot,
      ...(params.resolvePluginNotifications ? { resolvePluginNotifications: params.resolvePluginNotifications } : {}),
      ...(params.pluginActionExecutionOwner
        ? { pluginActionExecutionOwner: params.pluginActionExecutionOwner }
        : {}),
      sessionId: 'cli-global',
      ...(params.getCurrentTurnWorkDepth ? { getCurrentTurnWorkDepth: params.getCurrentTurnWorkDepth } : {}),
      ...(params.readRegisteredPromptAssetAdapters
        ? { readRegisteredPromptAssetAdapters: params.readRegisteredPromptAssetAdapters }
        : {}),
      ...(params.resolveAutomationEventAdoptedDefinitionSet
        ? { resolveAutomationEventAdoptedDefinitionSet: params.resolveAutomationEventAdoptedDefinitionSet }
        : {}),
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidatePluginActionCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
      ...(params.revalidatePluginActionCallerOccurrence
        ? { revalidatePluginActionCallerOccurrence: params.revalidatePluginActionCallerOccurrence }
        : {}),
      ...(params.sessionActionConfirmation ? { sessionActionConfirmation: params.sessionActionConfirmation } : {}),
      ...(params.runtimeActionExecute
        ? { runtimeActionExecute: params.runtimeActionExecute }
        : {}),
      ...(params.workflowAction ? { workflowAction: params.workflowAction } : {}),
      ...(params.workflowAcceptedAuthorizationCurrentness
        ? { workflowAcceptedAuthorizationCurrentness: params.workflowAcceptedAuthorizationCurrentness }
        : {}),
      ...(params.invokeContributedAction
        ? { invokeContributedAction: params.invokeContributedAction }
        : {}),
      ...(params.targetActionApprovalReplay
        ? { targetActionApprovalReplay: params.targetActionApprovalReplay }
        : {}),
      isApprovalExecutionOriginCurrent,
      ...(params.listContributedActionDefinitions
        ? { listContributedActionDefinitions: params.listContributedActionDefinitions }
        : {}),
      ...(params.inputTypeDeps ? { inputTypeDeps: params.inputTypeDeps } : {}),
      ...(params.hostExternalSessionAction
        ? { hostExternalSessionAction: params.hostExternalSessionAction }
        : {}),
      ...(params.sessionSpawnDirectTargetTransport
        ? { sessionSpawnDirectTargetTransport: params.sessionSpawnDirectTargetTransport }
        : {}),
      ...(params.machineActionDirectTargetTransport
        ? { machineActionDirectTargetTransport: params.machineActionDirectTargetTransport }
        : {}),
      ...(params.sessionActionRpcTransport ? { sessionActionRpcTransport: params.sessionActionRpcTransport } : {}),
      ...(params.externalSessionPluginAdmissionOwner
        ? {
            externalSessionPluginAdmissionOwner:
              params.externalSessionPluginAdmissionOwner,
          }
        : {}),
      ...(machineAdmissionTransport
        ? { machineAdmissionTransport }
        : {}),
      ...(params.resolveComposerAttachmentSendPreparation
        ? {
            resolveComposerAttachmentSendPreparation:
              params.resolveComposerAttachmentSendPreparation,
          }
        : {}),
      resolveTranscriptStore: async (sessionId) => {
        const serverFeaturesSnapshot = await resolveServerFeaturesSnapshotForCredentials(credentials);
        const transport = await resolveSessionTransportContext({
          credentials,
          idOrPrefix: sessionId,
          ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        });
        if (!transport.ok) {
          throw Object.assign(new Error(transport.code), { code: transport.code });
        }
        return createServerBackedSessionTranscriptStore({
          token: credentials.token,
          sessionId: transport.sessionId,
          ...(transport.mode === 'plain' ? { mode: transport.mode, ctx: null } : { mode: transport.mode, ctx: transport.ctx }),
          readOpenedSessionState: (versions) => fetchOpenedSessionStateFromServer({
            token: credentials.token,
            sessionId: transport.sessionId,
            credentials,
            accountEncryptionCurrentness: transport.accountEncryptionCurrentness,
            currentMetadataLayoutVersion: transport.rawSession.metadataLayoutVersion ?? 0,
            currentMetadataVersion: versions.sharedMetadataVersion,
            currentAgentStateVersion: versions.agentStateVersion,
            ...(transport.mode === 'plain' ? { mode: transport.mode, ctx: null } : { mode: transport.mode, ctx: transport.ctx }),
          }),
        });
      },
      transcriptFollowLeaseRegistry,
      writeTranscriptItems: async (sessionId: string, items: readonly SessionTranscriptActionItem[]) =>
        await importHistoricalSessionTranscript({
          token: credentials.token,
          sessionId,
          items,
        }),
      ...(params.sessionLogAccess ? { sessionLogAccess: params.sessionLogAccess } : {}),
    });
  };

  const createCredentialRefreshingExecutor = (
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
    invocationSignal?: AbortSignal,
  ): CliActionExecutor => {
    const readCurrentCredentials = async (): Promise<StoredCredentials | null> => params.readCredentials
      ? await params.readCredentials().catch(() => null)
      : params.credentials;
    const fixedExecutor = params.readCredentials
      ? null
      : shouldUsePatPublicActionTransport(params.credentials, undefined)
        ? null
        : createExecutor(params.credentials, transcriptFollowLeaseRegistry);
    return bindExecutorToActionServer({
      prepare: async (...args) => {
        const listAccessFailure = resolveActionSessionListAccessFailure(args[0], args[2]);
        if (listAccessFailure) return { kind: 'settled' as const, result: listAccessFailure };
        const credentials = await readCurrentCredentials();
        if (!credentials) {
          return {
            kind: 'settled' as const,
            result: { ok: false as const, errorCode: 'not_authenticated', error: 'not_authenticated' },
          };
        }
        const [actionId, input, rawContext] = args;
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          const plan = await resolvePatActionTransportPlan({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverApiUrl: resolveActionServerApiUrl(),
            allowConfiguredMachineTarget: fixedServerId === null,
          });
          if (plan.kind === 'settled') {
            return { kind: 'settled' as const, result: plan.result };
          }
          return {
            kind: 'ready' as const,
            invocation: createOneShotPatInvocation(async () => await executePatPublicActionPlan({
              actionId,
              credentials,
              plan,
              context: rawContext,
              ...(invocationSignal ? { invocationSignal } : {}),
              serverApiUrl: resolveActionServerApiUrl(),
            })),
          };
        }
        const context = await enrichApprovalRoutingContext(rawContext, credentials);
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        // An explicitly supplied policy provider is already the admitted
        // principal's policy authority. Do not widen it by bootstrapping
        // ambient Account settings before execution.
        if (
          !params.actionsSettingsProvider
          && !context?.externalActionExecutionAuthorization
        ) {
          await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
        }
        return await executor.prepare(actionId, input, context);
      },
      execute: async (...args) => {
        const listAccessFailure = resolveActionSessionListAccessFailure(args[0], args[2]);
        if (listAccessFailure) return listAccessFailure;
        const credentials = await readCurrentCredentials();
        if (!credentials) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        const [actionId, input, rawContext] = args;
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          return await executePatPublicAction({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverApiUrl: resolveActionServerApiUrl(),
            allowConfiguredMachineTarget: fixedServerId === null,
          });
        }
        const context = await enrichApprovalRoutingContext(rawContext, credentials);
        if (params.externalActionClient && hasStoredSessionCredentialProvenance(credentials)) {
          const parsedActionId = SignedRootActionIdSchema.safeParse(actionId);
          if (!parsedActionId.success) return actionFailure('unsupported');
          const signal = combineInvocationSignals(invocationSignal, context?.signal);
          const daemonControlTarget = fixedServerId
            ? await resolveLiveDaemonControlTargetForServer(fixedServerId).catch(() => null)
            : undefined;
          if (fixedServerId && !daemonControlTarget) return actionFailure('daemon_unavailable');
          return await requestDaemonSignedRootActionExecution({
            actionId: parsedActionId.data,
            input,
            ...(context?.externalActionTarget
              ? { target: context.externalActionTarget }
              : params.machineId
                ? { target: { kind: 'machine' as const, machineId: params.machineId } }
                : {}),
            ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
          }, {
            ...(signal ? { signal } : {}),
            ...(daemonControlTarget ? { target: daemonControlTarget } : {}),
          });
        }
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        if (
          !params.actionsSettingsProvider
          && !context?.externalActionExecutionAuthorization
        ) {
          await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
        }
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        return await executor.execute(actionId, input, signal ? { ...context, signal } : context);
      },
      replayApprovedApprovalRequest: async (args) => {
        const credentials = await readCurrentCredentials();
        if (!credentials) {
          return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
        }
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        const signal = combineInvocationSignals(invocationSignal, args.signal);
        return await executor.replayApprovedApprovalRequest({
          ...args,
          ...(signal ? { signal } : {}),
        });
      },
    });
  };

  const executor = createCredentialRefreshingExecutor(createFollowLeaseRegistry());
  const resolveSessionTarget = async (idOrPrefix: string): Promise<CliActionSessionTarget> =>
    await runWithActionServer(async () => {
      const credentials = params.readCredentials
        ? await params.readCredentials().catch(() => null)
        : params.credentials;
      if (!credentials) {
        return { ok: false, code: 'not_authenticated' };
      }
      if (shouldUsePatPublicActionTransport(credentials, { surface: 'cli' })) {
        return await resolvePatSessionTarget({
          credentials,
          idOrPrefix,
          ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
          serverApiUrl: resolveActionServerApiUrl(),
          allowConfiguredMachineTarget: fixedServerId === null,
        });
      }
      const serverFeaturesSnapshot = await resolveServerFeaturesSnapshotForCredentials(credentials);
      const resolved = await resolveSessionTransportContext({
        credentials,
        idOrPrefix,
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      });
      return resolved.ok
        ? { ok: true, sessionId: resolved.sessionId }
        : {
            ok: false,
            code: resolved.code,
            ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
          };
    });
  return Object.freeze({
    ...executor,
    resolveSessionTarget,
    async resolveMachineTarget() {
      return await runWithActionServer(async () => {
        const credentials = params.readCredentials
          ? await params.readCredentials().catch(() => null)
          : params.credentials;
        if (!credentials) return { ok: false as const, code: 'not_authenticated' };
        return await resolvePatMachineTarget({
          credentials,
          ...(params.machineId !== undefined ? { requestedMachineId: params.machineId } : {}),
          serverApiUrl: resolveActionServerApiUrl(),
          allowConfiguredMachineTarget: fixedServerId === null,
        });
      });
    },
    bindInvocation(signal: AbortSignal) {
      if (params.transcriptFollowLeaseRegistry) {
        return createCredentialRefreshingExecutor(params.transcriptFollowLeaseRegistry, signal);
      }
      const transcriptFollowLeaseRegistry = createFollowLeaseRegistry();
      const dispose = (): void => {
        void transcriptFollowLeaseRegistry.dispose().catch(() => undefined);
      };
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
      return createCredentialRefreshingExecutor(transcriptFollowLeaseRegistry, signal);
    },
  });
}
