import { createSessionFollowActionDeps, createSessionTrackedTargetCompatibilityDep } from '@/api/sessionFollowActionDeps';
import { randomUUID } from 'node:crypto';
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
import { getDaemonMachineAdmissionTransport, getDaemonClientActionExecutor, getDaemonConfidentialSecretFillExecutor, MachineAdmissionTransportUnavailableError } from '@/daemon/machineAdmissionTransport';
import { resolveCliApiTokenForSdk } from '@/auth/cliApiToken';
import {
  normalizeServerHttpBaseUrl,
  runWithServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import { requestDaemonSignedRootActionExecution } from '@/daemon/controlClient';
import { buildTerminalAuthorityCeiling } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import {
  resolveLiveDaemonControlTargetForServer,
  resolveLiveDaemonExternalActionEndpoint,
} from '@/daemon/multiDaemon';
import {
  hasStoredSessionCredentialProvenance,
  readSettings,
  readStoredCredentialsForServerId,
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
import { getActionSpec, resolveActionExecutionPlacementForInput, PublicActionIdSchema, SignedRootActionIdSchema, projectSessionSpawnNewApiRequest } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { resolveActionSessionListAccessFailure } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { SessionListResultSchema } from '@happier-dev/protocol/sessions/control/listResult';
import type { ApprovalExecutionOriginV1, ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps, RuntimeActionExecute } from '@happier-dev/protocol';
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
  createCliActionDeps,
  CliActionExactHomeTarget,
  MachineActionDirectTargetTransport,
  SessionActionRpcTransport,
  SessionSpawnDirectTargetTransport,
} from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { resolveActionOriginationPreferenceFailureV1 } from '@happier-dev/protocol/actions/executor/actionOriginationPreferences';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveFilesystemTransferCustodyFailure } from './filesystemTransferCustody';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { dispatchOriginalAccountAction, requiresOriginalAccountMachineActionProof, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { MachineEnvironmentApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isSessionBoardActionIdV1 } from '@happier-dev/protocol/sessions/board/actionIds';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, readLocalServiceControlActionRequest } from '@happier-dev/protocol/actions/specs/localServices';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { FilesystemPreparedCopyInputSchema, FilesystemTargetCopyInputSchema, FilesystemUploadOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createCredentialedFilesystemTransferClient } from '@/machines/transfer/createCredentialedFilesystemTransferClient';
import { createPreparedFilesystemTransferClient } from '@/machines/transfer/preparedFilesystemTransferClient';
import { resolveActionCliCredentialTarget } from '@/cli/actions/actionServerTarget';
import { getServerProfile } from '@/server/serverProfiles';
import { createCliBoundSessionMetadataReader } from './resolveCliActionCallerSession';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { dispatchRequesterSessionSpawnNewRpc } from '@/session/transport/rpc/machineRpc';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

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

async function resolveServiceRelocationSource(params: Readonly<{
  credentials: StoredCredentials; input: unknown; serverId: string; serverApiUrl: string; signal?: AbortSignal;
}>): Promise<CliActionMachineTarget> {
  const parsed = ProjectServiceRelocateInputV1Schema.safeParse(params.input);
  if (!parsed.success) return { ok: false, code: 'invalid_parameters' };
  if (parsed.data.workspace.serverId !== params.serverId) return { ok: false, code: 'server_target_mismatch' };
  try {
    const rows = await runWithServerHttpBaseUrl(params.serverApiUrl, async () => await readProjectAccountRows({
      credentials: params.credentials, serverId: params.serverId, ...(params.signal ? { signal: params.signal } : {}),
    }));
    const ref = resolveWorkspaceRefById(rows.workspaceRefs, parsed.data.workspace.refId, params.serverId);
    return ref ? { ok: true, machineId: ref.machineId } : { ok: false, code: 'workspace_ref_unavailable' };
  } catch {
    return { ok: false, code: params.signal?.aborted ? 'cancelled' : 'workspace_ref_unavailable' };
  }
}

async function resolvePatActionTransportPlan(params: Readonly<{
  actionId: string;
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext | undefined;
  machineId?: string;
  invocationSignal?: AbortSignal;
  serverId: string;
  serverApiUrl: string;
  allowConfiguredMachineTarget: boolean;
}>): Promise<PatActionTransportPlan> {
  const publicActionId = PublicActionIdSchema.safeParse(params.actionId);
  if (!publicActionId.success) {
    return { kind: 'settled', result: actionFailure('unsupported') };
  }

  const spec = getActionSpec(publicActionId.data);
  const signal = combineInvocationSignals(params.invocationSignal, params.context?.signal);
  if (publicActionId.data === 'projects.service.relocate') {
    const source = await resolveServiceRelocationSource({ ...params, ...(signal ? { signal } : {}) });
    if (!source.ok) return { kind: 'settled', result: actionResolutionFailure(source) };
    const capturedTarget = params.context?.externalActionTarget;
    if ((params.machineId !== undefined && params.machineId !== source.machineId)
      || (capturedTarget && (capturedTarget.kind !== 'machine' || capturedTarget.machineId !== source.machineId))) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const local = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
    if (local && local !== source.machineId) return { kind: 'settled', result: actionFailure('target_not_local') };
    return { kind: 'ready', input: params.input,
      target: capturedTarget ?? (local ? encryptedDaemonTarget(params.credentials, local)
        : { kind: 'machine', machineId: source.machineId }) };
  }
  if (Object.hasOwn(LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS, publicActionId.data)) {
    const request = readLocalServiceControlActionRequest(publicActionId.data, params.input);
    if (!request) return { kind: 'settled', result: actionFailure('invalid_parameters') };
    const machineId = request.target.machineId;
    const capturedTarget = params.context?.externalActionTarget;
    if ((params.machineId !== undefined && params.machineId !== machineId)
      || (capturedTarget && (capturedTarget.kind !== 'machine' || capturedTarget.machineId !== machineId))) {
      return { kind: 'settled', result: actionFailure('target_unavailable') };
    }
    const local = await resolveDaemonLocalActionMachineId(params.serverApiUrl);
    if (local && local !== machineId) return { kind: 'settled', result: actionFailure('target_unavailable') };
    if (local) {
      return { kind: 'ready', input: request,
        target: capturedTarget ?? encryptedDaemonTarget(params.credentials, local) };
    }
    const target = await resolvePatMachineTarget({
      credentials: params.credentials,
      requestedMachineId: machineId,
      ...(signal ? { signal } : {}),
      serverApiUrl: params.serverApiUrl,
      allowConfiguredMachineTarget: params.allowConfiguredMachineTarget,
    });
    if (!target.ok) return { kind: 'settled', result: actionResolutionFailure(target) };
    return { kind: 'ready', input: request,
      target: capturedTarget ?? { kind: 'machine', machineId: target.machineId } };
  }
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
  const executionPlacement = resolveActionExecutionPlacementForInput(spec, params.input);
  // The generic Session command resolves its positional selector before
  // invoking this adapter; first-class CLI and MCP Actions carry `sessionId`.
  // In each case the selector remains this adapter's only Session-target input
  // and is resolved to the immutable Session id before crossing the API seam.
  const requestedSessionId = (spec.contextualDefaults?.sessionId === 'current_session'
    ? readNonEmptyString(params.context?.defaultSessionId)
    : null)
    ?? (executionPlacement === 'session' ? inputSessionId : null);
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

  if (executionPlacement === 'session') {
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
  serverId: string;
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

function createCliActionExecutionCoreFromCredentials(params: Readonly<{
  credentials: StoredCredentials;
  requesterSessionBootstrap?: Parameters<typeof createCliActionDeps>[0]['requesterSessionBootstrap'];
  savedSecretOperationContext?: Parameters<typeof createCliActionDeps>[0]['savedSecretOperationContext'];
  onRequesterSessionCredentialDisclosure?: Parameters<typeof dispatchRequesterSessionSpawnNewRpc>[0]['onRequesterSessionCredentialDisclosure'];
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
  readPluginVoiceProviders?: Parameters<typeof createCliActionExecutor>[0]['readPluginVoiceProviders'];
  /** Explicit CLI machine selector for public Action transport. */
  machineId?: string;
  readCredentials?: () => Promise<StoredCredentials | null>;
  readRegisteredPromptAssetAdapters?: () => ReadonlyMap<string, PromptAssetAdapter>;
  resolveAutomationEventAdoptedDefinitionSet?: ResolveAutomationEventAdoptedDefinitionSetV1;
  revalidatePluginActionCallerMaterialization?: RevalidatePluginActionCallerMaterialization;
  revalidatePluginActionCallerOccurrence?: RevalidatePluginActionCallerOccurrence;
  runtimeActionExecute?: RuntimeActionExecute;
  clientActionExecute?: ActionExecutorDeps['clientActionExecute'];
  confidentialSecretFill?: ActionExecutorDeps['confidentialSecretFill'];
  workflowAction?: ActionExecutorDeps['workflowAction'];
  managedMachineAction?: ActionExecutorDeps['managedMachineAction'];
  machineEnvironmentApply?: ActionExecutorDeps['machineEnvironmentApply'];
  hostActionApprovalLifetime?: ActionExecutorDeps['hostActionApprovalLifetime'];
  projectAction?: ActionExecutorDeps['projectAction'];
  projectWorkerAction?: ActionExecutorDeps['projectWorkerAction'];
  projectDefinitionAction?: ActionExecutorDeps['projectDefinitionAction'];
  filesystemActionExecute?: ActionExecutorDeps['filesystemActionExecute'];
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
    observeRecordedApprovalExecution: async args => await runWithActionServer(() => source.observeRecordedApprovalExecution(args)),
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
    continueConfidentialApprovalRequest: async (...args) => await runWithActionServer(
      async () => await source.continueConfidentialApprovalRequest(...args),
    ),
    replayApprovedApprovalRequest: async (...args) => await runWithActionServer(
      async () => await source.replayApprovedApprovalRequest(...args),
    ),
  });
  const createFollowLeaseRegistry = (): SessionTranscriptFollowLeaseRegistry => (
    params.transcriptFollowLeaseRegistry
    ?? createSessionTranscriptFollowLeaseRegistry({
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    })
  );
  const readCurrentCredentials = async (): Promise<StoredCredentials | null> => params.readCredentials
    ? await params.readCredentials().catch(() => null)
    : params.credentials;
  const createExecutor = (
    credentials: StoredCredentials,
    transcriptFollowLeaseRegistry: ReturnType<typeof createFollowLeaseRegistry>,
    sessionMemoryEnabled?: boolean,
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
      ...(sessionMemoryEnabled !== undefined ? { sessionMemoryEnabled } : {}),
      clientActionExecute: params.clientActionExecute ?? getDaemonClientActionExecutor(approvalServerId),
      confidentialSecretFill: params.confidentialSecretFill ?? getDaemonConfidentialSecretFillExecutor(approvalServerId),
      ...(params.scmFilesystemAccessPolicy ? { scmFilesystemAccessPolicy: params.scmFilesystemAccessPolicy } : {}),
      ...(params.resolveExactSessionEncryptionMaterial
        ? { resolveExactSessionEncryptionMaterial: params.resolveExactSessionEncryptionMaterial }
        : {}),
      ...(params.actionsSettingsProvider ? { actionsSettingsProvider: params.actionsSettingsProvider } : {}),
      ...(params.managedMachineAction ? { managedMachineAction: params.managedMachineAction } : {}),
      ...(params.machineEnvironmentApply ? { machineEnvironmentApply: params.machineEnvironmentApply } : {}),
      ...(params.hostActionApprovalLifetime ? { hostActionApprovalLifetime: params.hostActionApprovalLifetime } : {}),
      ...(params.projectAction ? { projectAction: params.projectAction } : {}),
      ...(params.projectWorkerAction ? { projectWorkerAction: params.projectWorkerAction } : {}),
      ...(params.projectDefinitionAction ? { projectDefinitionAction: params.projectDefinitionAction } : {}),
      ...(params.filesystemActionExecute ? { filesystemActionExecute: params.filesystemActionExecute } : {}),
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
      isCredentialCurrent: async () => sameStoredCredentials(credentials, await readCurrentCredentials()),
      ...(params.onRequesterSessionCredentialDisclosure
        ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
      ...(params.requesterSessionBootstrap ? { requesterSessionBootstrap: params.requesterSessionBootstrap } : {}),
      ...(params.savedSecretOperationContext ? { savedSecretOperationContext: params.savedSecretOperationContext } : {}),
      resolveServerFeaturesSnapshot,
      ...(params.resolvePluginNotifications ? { resolvePluginNotifications: params.resolvePluginNotifications } : {}),
      ...(params.readPluginVoiceProviders ? { readPluginVoiceProviders: params.readPluginVoiceProviders } : {}),
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
    const fixedExecutor = params.readCredentials
      ? null
      : shouldUsePatPublicActionTransport(params.credentials, undefined)
        ? null
        : createExecutor(params.credentials, transcriptFollowLeaseRegistry);
    const originationPreferenceFailure = async (actionId: string, credentials: StoredCredentials,
      context: ActionExecutorContext | undefined) => {
      if (actionId !== 'machines.managed.acquire' || context?.externalActionExecutionAuthorization || context?.surface === 'rpc') return null;
      if (!params.actionsSettingsProvider) await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
      const provider = params.actionsSettingsProvider ?? createActionSettingsProvider({
        scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token),
      });
      return resolveActionOriginationPreferenceFailureV1(actionId, {
        managedMachineCreationEnabled: provider.getAccountSettings?.()?.managedMachineCreationEnabled,
      });
    };
    return bindExecutorToActionServer({
      observeRecordedApprovalExecution: async args => {
        const credentials = await readCurrentCredentials();
        if (!credentials) return actionFailure('not_authenticated');
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        const signal = combineInvocationSignals(invocationSignal, args.signal) ?? args.signal;
        return await executor.observeRecordedApprovalExecution({ ...args, signal });
      },
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
        const preferenceFailure = await originationPreferenceFailure(actionId, credentials, rawContext);
        if (preferenceFailure) return { kind: 'settled' as const, result: preferenceFailure };
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          const plan = await resolvePatActionTransportPlan({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverId: approvalServerId,
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
          && actionId !== 'machines.managed.acquire'
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
        const preferenceFailure = await originationPreferenceFailure(actionId, credentials, rawContext);
        if (preferenceFailure) return preferenceFailure;
        if (shouldUsePatPublicActionTransport(credentials, rawContext)) {
          return await executePatPublicAction({
            actionId,
            input,
            context: rawContext,
            credentials,
            ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            ...(invocationSignal ? { invocationSignal } : {}),
            serverId: approvalServerId,
            serverApiUrl: resolveActionServerApiUrl(),
            allowConfiguredMachineTarget: fixedServerId === null,
          });
        }
        const context = await enrichApprovalRoutingContext(rawContext, credentials);
        const mountedFilesystemCopy = params.filesystemActionExecute && actionId === 'daemon.filesystem.copy'
          && (FilesystemPreparedCopyInputSchema.safeParse(input).success || FilesystemTargetCopyInputSchema.safeParse(input).success);
        // Finite original CLI work is admitted at Home before the selected
        // retained guest is online. Keep policy/approval in the shared executor;
        // admitted Session/Run origins retain their existing credentialed owner.
        const originalCliCaller = (context.surface === undefined || context.surface === 'cli')
          && (!context.actionCaller || context.actionCaller.kind === 'host')
          && !context.externalActionCredential && !context.externalActionExecutionAuthorization
          && !context.rpcSessionAuthorization && !context.causalPermissionAuthority;
        const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: true });
        const ordinary = provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user'
          && context.authority !== 'account_automation';
        // A paired terminal uses its own daemon ingress when locally placed;
        // another selected Machine uses Home's named Session-start admission.
        // Both retain terminal policy and exact Machine admission.
        const pairedSessionCreation = actionId === 'session.spawn_new' && provenance?.provenance.kind === 'terminal'
          ? SessionSpawnNewInputV2Schema.safeParse(input) : null;
        const originalContext = params.externalActionClient && originalCliCaller && provenance?.provenance.kind === 'terminal'
          ? { ...context, authority: 'account_automation' as const } : context;
        const originalMachineEnvironment = actionId === 'machines.environment.apply' && originalCliCaller
          ? MachineEnvironmentApplyInputV1Schema.safeParse(input) : null;
        if (originalMachineEnvironment && (!originalMachineEnvironment.success
          || originalMachineEnvironment.data.homeId !== context.serverIdentityId)) return actionFailure('target_unavailable');
        const originalMachineTarget = context.externalActionTarget
          ? context.externalActionTarget.kind === 'machine' : Boolean(params.machineId);
        const originalFiniteProjectAction = Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) && originalCliCaller;
        if (params.externalActionClient && hasStoredSessionCredentialProvenance(credentials)
          && originalCliCaller && (ordinary || pairedSessionCreation?.success || originalMachineTarget || actionId === 'projects.service.relocate')
          && !mountedFilesystemCopy && !originalFiniteProjectAction) {
          const parsedActionId = SignedRootActionIdSchema.safeParse(actionId);
          if (!parsedActionId.success) return actionFailure('unsupported');
          const signal = combineInvocationSignals(invocationSignal, context?.signal);
          let target = context?.externalActionTarget
            ?? (params.machineId ? { kind: 'machine' as const, machineId: params.machineId } : undefined);
          if (originalMachineEnvironment?.success) {
            if (target && (target.kind !== 'machine' || target.machineId !== originalMachineEnvironment.data.machineId)) return actionFailure('target_unavailable');
            target ??= { kind: 'machine', machineId: originalMachineEnvironment.data.machineId };
          }
          // Public V2 already names the Machine. Keep the same exact Account /
          // publication check when the caller omits the optional outer flag.
          if (!target && pairedSessionCreation?.success) {
            target = { kind: 'machine', machineId: pairedSessionCreation.data.executionTarget.machineId };
          }
          if (parsedActionId.data === 'projects.service.relocate') {
            const source = await resolveServiceRelocationSource({ credentials, input, serverId: approvalServerId,
              serverApiUrl: resolveActionServerApiUrl(), ...(signal ? { signal } : {}) });
            if (!source.ok) return actionResolutionFailure(source);
            if (target && (target.kind !== 'machine' || target.machineId !== source.machineId)) {
              return actionFailure('target_unavailable');
            }
            target ??= { kind: 'machine', machineId: source.machineId };
          }
          const daemonControlTarget = fixedServerId
            ? await resolveLiveDaemonControlTargetForServer(fixedServerId).catch(() => null)
            : undefined;
          if (target?.kind === 'machine') {
            // Home's API URL need not be the daemon's control URL. Preserve
            // the fixed-Home publication's own Account/Machine offline dispatcher.
            const localEndpoint = await resolveLiveDaemonExternalActionEndpoint(resolveActionServerApiUrl()).catch(() => null);
            const accountId = readAccountIdFromToken(credentials.token);
            const localPublication = daemonControlTarget ?? localEndpoint;
            const ownLocal = (ordinary || pairedSessionCreation?.success) && accountId && localPublication?.machineId === target.machineId
              && localPublication.accountId === accountId;
            if (!ownLocal || requiresOriginalAccountMachineActionProof(parsedActionId.data)) {
              try {
                const requester = await dispatchOriginalAccountAction({ actionId: parsedActionId.data, input,
                  requestId: context.actionRequestId ?? randomUUID(), target, credentials,
                  serverHttpBaseUrl: resolveActionServerApiUrl(), serverIdentityId: context.serverIdentityId,
                  // Accepted legacy publications omit Account identity. Keep their
                  // incumbent own-target bridge while Home still admits foreign work.
                  ...(ordinary && localPublication && !localPublication.accountId ? { foreignTargetOnly: true as const } : {}),
                  ...(originalContext.authority ? { authority: originalContext.authority } : {}),
                  ...(params.onRequesterSessionCredentialDisclosure
                    ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
                  isCurrent: async () => sameStoredCredentials(credentials, await readCurrentCredentials()),
                  ...(signal ? { signal } : {}) });
                if (requester) return requester;
              } catch { return actionFailure(signal?.aborted ? 'cancelled' : 'target_unavailable'); }
            }
          }
          if (fixedServerId && !daemonControlTarget) return actionFailure('daemon_unavailable');
          return await requestDaemonSignedRootActionExecution({
            actionId: parsedActionId.data,
            input,
            ...(target ? { target } : {}),
            ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
          }, {
            ...(signal ? { signal } : {}),
            ...(daemonControlTarget ? { target: daemonControlTarget } : {}),
            ...(pairedSessionCreation?.success
              ? context.authority === 'account_automation'
                ? { authorityCeiling: 'account_automation' as const }
                : buildTerminalAuthorityCeiling({ token: credentials.token, serverHttpBaseUrl: resolveActionServerApiUrl() })
              : {}),
          });
        }
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        let sessionMemoryEnabled: boolean | undefined;
        const catalogSessionId = readNonEmptyString(context?.defaultSessionId);
        if (params.pluginActionExecutionOwner === 'current_process' && context?.surface === 'agent'
          && catalogSessionId && (actionId === 'action.spec.get' || actionId === 'action.spec.search')) {
          // A reader belongs to one invocation: its preparation-local cache must
          // never turn a daemon's long-lived catalog into a stale Session policy.
          const ctx = resolveSessionEncryptionContextFromCredentials(credentials);
          const readMetadata = createCliBoundSessionMetadataReader({
            credentials, token: credentials.token, sessionId: catalogSessionId,
            ...(ctx ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null }),
            resolveTransportForSession: (sessionId) => resolveSessionTransportContext({
              credentials, idOrPrefix: sessionId, ...(signal ? { signal } : {}),
            }),
          });
          const metadata = await readMetadata();
          if (signal?.aborted) return actionFailure('cancelled');
          if (!metadata) return actionFailure('target_unavailable');
          sessionMemoryEnabled = readSessionMemoryEnabledV1(metadata);
        }
        const executor = sessionMemoryEnabled !== undefined
          ? createExecutor(credentials, transcriptFollowLeaseRegistry, sessionMemoryEnabled)
          : fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        if (
          !params.actionsSettingsProvider
          && !context?.externalActionExecutionAuthorization
          && actionId !== 'machines.managed.acquire'
        ) {
          await ensureCliActionPolicySettings(credentials, resolveActionServerApiUrl());
        }
        return await executor.execute(actionId, input, signal ? { ...originalContext, signal } : originalContext);
      },
      continueConfidentialApprovalRequest: async (input, context) => {
        const credentials = await readCurrentCredentials();
        if (!credentials) return actionFailure('not_authenticated');
        const executor = fixedExecutor ?? createExecutor(credentials, transcriptFollowLeaseRegistry);
        const signal = combineInvocationSignals(invocationSignal, context?.signal);
        const resolvedContext = await enrichApprovalRoutingContext(
          // The receiver's bound or authenticated Home identity admits a private
          // claim; an invocation context cannot substitute another Home's stamp.
          { ...context, ...(signal ? { signal } : {}), serverIdentityId: params.serverIdentityId },
          credentials,
        );
        return await executor.continueConfidentialApprovalRequest(input, resolvedContext);
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

/** Public caller ingress; concrete byte drivers alone consume the private transport core. */
export function createCliActionExecutorFromCredentials(params: Parameters<typeof createCliActionExecutionCoreFromCredentials>[0]): ReturnType<typeof createCliActionExecutionCoreFromCredentials> {
  const core = createCliActionExecutionCoreFromCredentials(params);
  const wrap = (executor: CliActionExecutor, invocationSignal?: AbortSignal): CliActionExecutor => {
    const prepareConcreteCopy = async (input: unknown, context: ActionExecutorContext | undefined) => {
      const copy = FilesystemPreparedCopyInputSchema.safeParse(input);
      const targetCopy = copy.success ? null : FilesystemTargetCopyInputSchema.safeParse(input);
      const parsed = copy.success ? copy.data : targetCopy?.success ? targetCopy.data : null;
      if (!parsed) return null;
      if (parsed.kind === 'prepared_transfer' && parsed.source.kind === 'entry_tree') {
        return { failure: actionFailure('filesystem_transfer_custody_required') };
      }
      const signal = combineInvocationSignals(invocationSignal, context?.signal);
      try {
        signal?.throwIfAborted();
        const outerCredentials = params.readCredentials ? await params.readCredentials() : params.credentials;
        if (!outerCredentials) return { failure: actionFailure('not_authenticated') };
        const pat = shouldUsePatPublicActionTransport(outerCredentials, context);
        if (pat && parsed.kind === 'target_copy') {
          return { failure: actionFailure('filesystem_transfer_custody_required') };
        }
        if ((params.serverId && params.serverId !== parsed.destination.serverId)
          || (context?.serverId && context.serverId !== parsed.destination.serverId)
          || (params.machineId && params.machineId !== parsed.destination.machineId)
          || (context?.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
            || context.externalActionTarget.machineId !== parsed.destination.machineId))) return { failure: actionFailure('target_unavailable') };
        const resolveHome = async (serverId: string) => {
          const target = await resolveActionCliCredentialTarget({ requestedServerId: serverId,
            deps: { readCredentialsFn: async () => null, readCredentialsForServerIdFn: readStoredCredentialsForServerId, getServerProfileFn: getServerProfile } });
          if (!target.credentials || !target.fixedServer || target.fixedServer.serverId !== serverId) throw new Error('Exact copy Home credentials are unavailable');
          return { credentials: target.credentials, ...target.fixedServer };
        };
        // Capture local custody before policy/approval awaits; the effect never
        // resolves a replacement Account after the containing Action is admitted.
        const [sourceHome, destinationHome] = await Promise.all([resolveHome(parsed.source.serverId), resolveHome(parsed.destination.serverId)]);
        if (!sameStoredCredentials(destinationHome.credentials, outerCredentials)
          || (params.serverApiUrl && normalizeServerHttpBaseUrl(params.serverApiUrl) !== normalizeServerHttpBaseUrl(destinationHome.serverApiUrl))) {
          return { failure: actionFailure('not_authenticated') };
        }
        const assertCurrent = async () => {
          signal?.throwIfAborted();
          const [sourceCurrent, destinationCurrent, outerCurrent] = await Promise.all([
            readStoredCredentialsForServerId(sourceHome.serverId), readStoredCredentialsForServerId(destinationHome.serverId),
            params.readCredentials ? params.readCredentials() : Promise.resolve(params.credentials),
          ]);
          if (!sameStoredCredentials(sourceHome.credentials, sourceCurrent) || !sameStoredCredentials(destinationHome.credentials, destinationCurrent)
            || !sameStoredCredentials(outerCredentials, outerCurrent)) throw Object.assign(new Error('Copy Account custody is no longer current'), { errorCode: 'not_authenticated' });
        };
        const currentCredentialsFor = (home: typeof sourceHome) => async () => {
          await assertCurrent();
          return home.credentials;
        };
        const concreteContext: ActionExecutorContext = { ...context, serverId: destinationHome.serverId,
          externalActionTarget: { kind: 'machine', machineId: parsed.destination.machineId }, ...(signal ? { signal } : {}) };
        const run = async (admittedContext: ActionExecutorContext): Promise<ActionExecuteResult> => {
          const signal = combineInvocationSignals(invocationSignal, context?.signal);
          let sourceTransport: Awaited<ReturnType<typeof createCredentialedFilesystemTransferClient>> | undefined;
          let destinationTransport: Awaited<ReturnType<typeof createCredentialedFilesystemTransferClient>> | undefined;
          let preparedAdmission: Extract<ReturnType<typeof FilesystemUploadOutputSchema.parse>, { success: true; status: 'accepted' }> | undefined;
          try {
            await assertCurrent();
            const invoke = (home: typeof sourceHome, machineId: string): Parameters<typeof createPreparedFilesystemTransferClient>[0]['executeAction'] => async (id, value, targetContext) => {
              await assertCurrent();
              if (targetContext.serverId !== home.serverId || targetContext.externalActionTarget?.kind !== 'machine'
                || targetContext.externalActionTarget.machineId !== machineId) return actionFailure('target_unavailable');
              const endpointContext = { ...targetContext,
                ...(admittedContext.surface ? { surface: admittedContext.surface } : {}), ...(admittedContext.authority ? { authority: admittedContext.authority } : {}),
                ...(admittedContext.actionRequestId ? { actionRequestId: admittedContext.actionRequestId } : {}) };
              let result: ActionExecuteResult;
              if (shouldUsePatPublicActionTransport(home.credentials, endpointContext)) {
                const endpointExecutor = createCliActionExecutionCoreFromCredentials({ ...home, machineId,
                  readCredentials: currentCredentialsFor(home) });
                result = await endpointExecutor.execute(id, value, endpointContext);
              } else {
                const method = getActionSpec(id).bindings?.rpcMethod;
                if (!method) return actionFailure('unsupported');
                const response = await callExactMachineRpc({ credentials: home.credentials, serverUrl: home.serverApiUrl,
                  machineId, method, request: createTargetedActionRpcRequestV1(value, { kind: 'machine', machineId }, admittedContext),
                  requireCurrentMachine: true, timeoutMs: null,
                  ...(admittedContext.authority === 'account_automation' ? { authorityCeiling: 'account_automation' as const } : {}),
                  ...(admittedContext.actionRequestId ? { requestId: admittedContext.actionRequestId } : {}), ...(signal ? { signal } : {}) });
                const failure = ActionExecuteFailureSchema.safeParse(response);
                result = failure.success ? failure.data : { ok: true, result: response };
              }
              await assertCurrent();
              return result;
            };
            const executeSource = invoke(sourceHome, parsed.source.machineId);
            const executeDestination = invoke(destinationHome, parsed.destination.machineId);
            if (pat) {
              // The existing API admits this exact prepared-file write once.
              // Deferred approval is preserved without preparing a source.
              const admission = await executeDestination('daemon.filesystem.copy', parsed, concreteContext);
              if (!admission.ok) return admission;
              if (ActionApprovalRequestCreatedResultSchema.safeParse(admission.result).success) return admission;
              const receipt = FilesystemUploadOutputSchema.parse(admission.result);
              if (!receipt.success || receipt.status !== 'accepted') return admission;
              preparedAdmission = receipt;
            }
            const client = createPreparedFilesystemTransferClient({
              openMachineTunnel: async request => {
                await assertCurrent();
                let transport: typeof sourceTransport;
                if (request.serverId === parsed.source.serverId && request.targetMachineId === parsed.source.machineId) {
                  sourceTransport ??= await createCredentialedFilesystemTransferClient({ ...sourceHome, executeAction: executeSource, ...(signal ? { signal } : {}) });
                  transport = sourceTransport;
                } else if (request.serverId === parsed.destination.serverId && request.targetMachineId === parsed.destination.machineId) {
                  destinationTransport ??= await createCredentialedFilesystemTransferClient({ ...destinationHome, executeAction: executeDestination, ...(signal ? { signal } : {}) });
                  transport = destinationTransport;
                } else throw new Error('Copy endpoint is outside the captured operation');
                await assertCurrent();
                const tunnel = await transport.openMachineTunnel(request);
                try { await assertCurrent(); } catch (error) { await tunnel.close(); throw error; }
                return tunnel;
              },
              executeAction: async (id, value, targetContext) => {
                if (targetContext.serverId === parsed.source.serverId && targetContext.externalActionTarget?.kind === 'machine'
                  && targetContext.externalActionTarget.machineId === parsed.source.machineId) return await executeSource(id, value, targetContext);
                if (targetContext.serverId === parsed.destination.serverId && targetContext.externalActionTarget?.kind === 'machine'
                  && targetContext.externalActionTarget.machineId === parsed.destination.machineId) return await executeDestination(id, value, targetContext);
                return actionFailure('target_unavailable');
              },
            });
            const result = await client.copy({ ...parsed, ...(preparedAdmission ? { preparedAdmission } : {}), ...(signal ? { signal } : {}) });
            return 'kind' in result || result.success ? { ok: true, result }
              : { ok: false, errorCode: result.errorCode ?? 'filesystem_transfer_failed', error: result.error, details: result };
          } catch (error) {
            if (preparedAdmission) return { ok: false, errorCode: 'indeterminate',
              error: 'The admitted copy could not confirm its terminal outcome',
              details: { success: false, status: 'unknown', operationId: preparedAdmission.operationId, errorCode: 'indeterminate' } };
            return { ok: false, errorCode: signal?.aborted ? 'cancelled'
              : error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string' ? error.errorCode : 'target_unavailable',
              error: error instanceof Error ? error.message : 'Copy target is unavailable' };
          } finally {
            try { await sourceTransport?.close(); } finally { await destinationTransport?.close(); }
          }
        };
        if (pat) return { patRun: () => run(concreteContext) };
        const mounted = createCliActionExecutionCoreFromCredentials({ ...params, ...destinationHome,
          readCredentials: currentCredentialsFor(destinationHome), filesystemActionExecute: async request => {
            const result = await run(request.context);
            return result.ok ? result.result : result;
          } });
        return { executor: invocationSignal ? mounted.bindInvocation(invocationSignal) : mounted, context: concreteContext };
      } catch (error) {
        return { failure: { ok: false as const, errorCode: signal?.aborted ? 'cancelled' : 'target_unavailable',
          error: error instanceof Error ? error.message : 'Copy target is unavailable' } };
      }
    };
    const execute: CliActionExecutor['execute'] = async (actionId, input, context) => {
      if (actionId === 'session.spawn_new' && !params.sessionSpawnDirectTargetTransport) {
        const parsed = SessionSpawnNewInputV2Schema.safeParse(input);
        const credentials = params.readCredentials ? await params.readCredentials().catch(() => null) : params.credentials;
        if (parsed.success && credentials && !shouldUsePatPublicActionTransport(credentials, context)) {
          const serverId = params.serverId ?? context?.serverId ?? configuration.activeServerId;
          const serverUrl = params.serverApiUrl ?? resolveServerHttpBaseUrl();
          if (parsed.data.executionTarget.serverId === serverId) {
            const signal = combineInvocationSignals(invocationSignal, context?.signal);
            try {
              const requester = await dispatchRequesterSessionSpawnNewRpc({ credentials, input,
                ...(params.onRequesterSessionCredentialDisclosure ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
                serverId, serverUrl, context: { ...context, ...(signal ? { signal } : {}) } });
              if (requester) return requester;
            } catch {
              const errorCode = signal?.aborted ? 'cancelled' : 'target_unavailable';
              return { ok: false, errorCode, error: errorCode };
            }
          }
        }
      }
      if (!params.filesystemActionExecute && actionId === 'daemon.filesystem.copy') {
        const copy = await prepareConcreteCopy(input, context);
        if (copy?.failure) return copy.failure;
        if (copy?.patRun) return await copy.patRun();
        if (copy?.executor) return await copy.executor.execute(actionId, input, copy.context);
      }
      const custodyFailure = params.filesystemActionExecute ? null : resolveFilesystemTransferCustodyFailure(actionId, context ?? {});
      return custodyFailure ?? await executor.execute(actionId, input, context);
    };
    return {
      ...executor, execute,
      prepare: async (actionId, input, context) => {
        if (actionId === 'session.spawn_new' && !params.sessionSpawnDirectTargetTransport
          && SessionSpawnNewInputV2Schema.safeParse(input).success) {
          // No Machine effect during prepare. The answering target's existing
          // Action owner admits policy and approval when this one-shot is run.
          return { kind: 'ready', invocation: createOneShotPatInvocation(() => execute(actionId, input, context)) };
        }
        const custodyFailure = !params.filesystemActionExecute && resolveFilesystemTransferCustodyFailure(actionId, context ?? {});
        if (custodyFailure) return { kind: 'settled', result: custodyFailure };
        if (!params.filesystemActionExecute && actionId === 'daemon.filesystem.copy'
          && (FilesystemPreparedCopyInputSchema.safeParse(input).success || FilesystemTargetCopyInputSchema.safeParse(input).success)) {
          const copy = await prepareConcreteCopy(input, context);
          if (copy?.failure) return { kind: 'settled', result: copy.failure };
          if (copy?.patRun) return { kind: 'ready', invocation: createOneShotPatInvocation(copy.patRun) };
          if (copy?.executor) return await copy.executor.prepare(actionId, input, copy.context);
        }
        return await executor.prepare(actionId, input, context);
      },
    };
  };
  return Object.freeze({ ...core, ...wrap(core), bindInvocation: signal => wrap(core.bindInvocation(signal), signal) });
}
