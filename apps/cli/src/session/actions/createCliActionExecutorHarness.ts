import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildActionExecuteResultFromRecordedApprovalExecution, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionEnabledByActionsSettings, normalizeActionsSettingsV1, type ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';
import { isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import { parseLocalServiceDomainActionRpcRequest, readLocalServiceControlActionRequest } from '@happier-dev/protocol/actions/specs/localServices';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ProjectWorkerStatusInputV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];
type ApprovalCreateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0];

/** Admission can defer Ask only when the receiving Account policy retains it. */
export function isOriginalCliApprovalPreservedAtAccount(actionId: ActionSettingsActionId, input: unknown,
  context: ActionExecutorContext, provider: RuntimeActionSettingsProvider): boolean {
  const accountSettings = provider.getAccountSettings?.();
  return Boolean(accountSettings && isApprovalRequiredByActionsSettings(actionId,
    normalizeActionsSettingsV1(accountSettings.actionsSettingsV1),
    { surface: 'cli', authority: context.authority }, undefined, undefined, input));
}

/** Host-local requester custody; never an Action, SDK or transported field. */
export type RecordedApprovalExecutionObservationArgs = Readonly<{
  artifactId: string;
  expectedOrigin: Readonly<{ actionId: string; requestId: string; accountId: string; serverIdentityId: string; machineId: string }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}>;

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0] & Readonly<{
    /** Host-owned reviewed policy; never resolved from Action input or endpoint environment. */
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    /** Current host-read Session choice; omission preserves unbound Account rights. */
    sessionMemoryEnabled?: boolean;
    /** Machine owning an installed runtime override; remote children retain Machine transport. */
    runtimeActionMachineId?: string;
  }>,
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: Omit<ReturnType<typeof createActionExecutor>, 'executeAdmittedClientAction'>;
  observeRecordedApprovalExecution(args: RecordedApprovalExecutionObservationArgs): Promise<ActionExecuteResult>;
}> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const browserSessionId = params.sessionId;
  // Nested widget admission must see this host's final registry/transport
  // bindings, including the committed input-type dependencies installed below.
  const baseDeps = createCliActionDeps(params, () => rawDeps);
  const baseDepsForRuntime = (() => {
    if (!params.actionsSettingsProvider || params.actionsSettingsProvider.getAccountSettings) {
      return baseDeps;
    }
    // A reviewed runtime-only policy has no Account authority. Keep its
    // Session Action dependencies, but do not let the restricted bearer make
    // the Account-private approval Artifact carrier appear available.
    const {
      approvalsList: _approvalsList,
      approvalsCreate: _approvalsCreate,
      approvalsGet: _approvalsGet,
      approvalsUpdate: _approvalsUpdate,
      ...scopedDeps
    } = baseDeps;
    return scopedDeps;
  })();
  const actionSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider();
  const originationSettingsProvider = params.actionsSettingsProvider ?? createActionSettingsProvider({
    scopeKey: resolveAccountSettingsScopeKeyForToken(params.token),
  });
  const hasAcceptedReservationPolicy = (id: string, ctx: ActionExecutorContext) =>
    id === 'discussion.invite' && ctx.actionCaller?.kind === 'workflowRun'
      && ctx.actionCaller.discussionModelReservation !== undefined && ctx.actionsSettings !== undefined;
  const isActionEnabled: NonNullable<ActionExecutorDeps['isActionEnabled']> = (id, ctx) =>
    isActionEnabledWithSessionMemory(id, params.sessionMemoryEnabled)
    && (!hasAcceptedReservationPolicy(id, ctx) || isActionEnabledByActionsSettings(id, ctx.actionsSettings!, {
      surface: ctx.surface ?? 'cli', placement: ctx.placement ?? null,
    })) && isActionEnabledByActionsSettings(
      id,
      params.actionsSettingsProvider?.getActionsSettings()
        ?? ctx.actionsSettings
        ?? actionSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? 'cli',
        placement: ctx.placement ?? null,
      },
    );
  const requiresOriginalCliFiniteAdmission = (id: string, ctx: Parameters<NonNullable<ActionExecutorDeps['isActionApprovalRequired']>>[1]) =>
    Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, id)
      && params.credentials && !params.projectAction && !overrides?.projectAction && !params.machineActionDirectTargetTransport
      && (!params.actionsSettingsProvider || params.actionsSettingsProvider.getAccountSettings)
      && ctx.surface === 'cli' && !ctx.externalActionCredential && !ctx.externalActionExecutionAuthorization
      && !ctx.rpcSessionAuthorization && (!ctx.actionCaller || ctx.actionCaller.kind === 'host');
  const readApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input, defaultUiConfirmation?: boolean) =>
    // A contained Workflow invitation retains its admitted restrictions; a
    // later provider waiver is not consent. Current restrictions still apply.
    (hasAcceptedReservationPolicy(id, ctx) && isApprovalRequiredByActionsSettings(id, ctx.actionsSettings!, {
      surface: ctx.surface ?? null, authority: ctx.authority, presentUserConfirmation: ctx.presentUserConfirmation,
    }, undefined, undefined, input, defaultUiConfirmation)) || isApprovalRequiredByActionsSettings(
      id,
      params.actionsSettingsProvider?.getActionsSettings()
        ?? ctx.actionsSettings
        ?? actionSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? null,
        authority: ctx.authority,
        presentUserConfirmation: ctx.presentUserConfirmation,
      },
      undefined, undefined, input, defaultUiConfirmation,
    );
  const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input, defaultUiConfirmation) =>
    // projectAction refuses a policy that cannot survive admission before it
    // sends anything. The receiver persists Ask with the signed Machine root.
    requiresOriginalCliFiniteAdmission(id, ctx) ? false : readApprovalRequired(id, ctx, input, defaultUiConfirmation);
  const rawDeps: MutableActionExecutorDeps = {
    ...baseDepsForRuntime,
    projectAction: async args => {
      if (requiresOriginalCliFiniteAdmission(args.actionId, args.context)
        && readApprovalRequired(args.actionId, args.context, args.input)) {
        if (!isOriginalCliApprovalPreservedAtAccount(args.actionId, args.input, args.context, originationSettingsProvider)) {
          // A custom host policy may be narrower than Account policy. Neither
          // unsigned replay nor a receiver waiver can preserve that requirement.
          return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
        }
      }
      return await baseDepsForRuntime.projectAction!(args);
    },
    approvalsWaitForDecision: async (args: ApprovalWaitForDecisionArgs) => {
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const lifetime = rawDeps.hostActionApprovalLifetime;
      const result = await timeWebLatencyPhase('approval.wait', () => coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: args.signal,
        subscribeChanges: (onChange, onError) => observeAccountChanges({
          // The Artifact store uses Account credentials; the Session transport
          // bearer cannot subscribe to the Account's decision invalidations.
          token: params.credentials?.token ?? params.token,
          serverUrl,
          entityId: args.artifactId,
        }, { onChange, onError }),
        readRequest: async () => {
          const getApproval = rawDeps.approvalsGet;
          return getApproval ? await runWithServerHttpBaseUrl(serverUrl, () => getApproval({
            artifactId: args.artifactId,
            serverId: args.serverId ?? null,
          })) : null;
        },
      }), undefined, () => ({ artifactId: args.artifactId,
        ...(args.request.v === 2 ? { executionRequestId: args.request.executionOriginV1.requestId } : {}),
        ...(lifetime && 'operationId' in lifetime ? { operationId: lifetime.operationId } : {}),
        signalMatchesHostLifetime: Boolean(lifetime && args.signal === lifetime.signal),
        signalAborted: args.signal?.aborted === true,
        liveWaiterCount: coordinator.getLiveWaiterCount(args.artifactId),
        detachedWaiterCount: coordinator.getDetachedWaiterCount(args.artifactId),
      }));
      const decision = { ...result, request: StoredApprovalRequestSchema.parse(result.request) };
      if (result.decision === 'approve' && result.tokenExecution) {
        Object.defineProperty(decision, 'tokenExecution', { value: result.tokenExecution, enumerable: false });
      }
      return decision;
    },
    approvalsResolveBlockingDecision: async (args: ApprovalResolveBlockingDecisionArgs) => {
      let resolved: boolean | undefined;
      return await timeWebLatencyPhase('approval.resolve_blocking', async () => {
        const result = await coordinator.resolveBlockingDecision({
          artifactId: args.artifactId,
          request: args.request,
          decision: args.decision,
          decisionAuthority: args.decisionAuthority,
          ...(args.tokenExecution ? { tokenExecution: args.tokenExecution } : {}),
        });
        resolved = result.resolved;
        return result;
      }, undefined, () => ({ artifactId: args.artifactId,
        ...(args.request.v === 2 ? { executionRequestId: args.request.executionOriginV1.requestId } : {}),
        liveWaiterCount: coordinator.getLiveWaiterCount(args.artifactId),
        detachedWaiterCount: coordinator.getDetachedWaiterCount(args.artifactId),
        ...(resolved === undefined ? {} : { resolved }),
      }));
    },
    isActionEnabled,
    isActionApprovalRequired,
    runtimeActionExecute: async args => {
      if (resolveRuntimeActionExecutionFamily(args.actionId) === 'localServices'
        && baseDepsForRuntime.runtimeActionExecute) return await baseDepsForRuntime.runtimeActionExecute(args);
      const { createCliBrowserRuntimeActionExecutor } = await import('@/daemon/browser/actions/controlTransport');
      return await createCliBrowserRuntimeActionExecutor({ sessionId: browserSessionId })(args);
    },
    ...createActionExecutionHookDeps(),
    ...(overrides ?? {}),
  };
  const installedRuntime = overrides?.runtimeActionExecute;
  const localMachineId = params.runtimeActionMachineId ?? params.machineActionDirectTargetTransport?.machineId;
  const installedWorker = overrides?.projectWorkerAction;
  if (installedWorker && baseDepsForRuntime.projectWorkerAction) {
    const transport = baseDepsForRuntime.projectWorkerAction;
    rawDeps.projectWorkerAction = async args => {
      // Installed finite workers own Status/retirement only. Sync inspection
      // and Account preferences keep their canonical transports.
      if (args.actionId !== 'projects.worker.status' && args.actionId !== 'projects.worker.copy.retire') {
        return await transport(args);
      }
      if (args.actionId === 'projects.worker.status'
        && localMachineId && ProjectWorkerStatusInputV1Schema.parse(args.input).destination.machineId !== localMachineId) {
        return await transport(args);
      }
      return await installedWorker(args);
    };
  }
  if (installedRuntime && localMachineId && baseDepsForRuntime.runtimeActionExecute) {
    const transport = baseDepsForRuntime.runtimeActionExecute;
    rawDeps.runtimeActionExecute = async args => {
      if (resolveRuntimeActionExecutionFamily(args.actionId) === 'localServices') {
        const control = readLocalServiceControlActionRequest(args.actionId, args.input);
        const domain = parseLocalServiceDomainActionRpcRequest(args.actionId, args.input);
        const start = args.actionId === 'localServices.launcher.start'
          ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(args.input) : null;
        const machineId = control?.target.machineId ?? (domain?.success ? domain.data.machineId : undefined)
          ?? (start?.success ? start.data.machineId : undefined);
        if (machineId && machineId !== localMachineId) return await transport(args);
      }
      return await installedRuntime(args);
    };
  }
  const originalApprovalsUpdate = rawDeps.approvalsUpdate;
  const originalApprovalsCreate = rawDeps.approvalsCreate;
  if (originalApprovalsCreate) {
    rawDeps.approvalsCreate = async (args: ApprovalCreateArgs) => {
      const result = await originalApprovalsCreate(args);
      const artifactId = typeof (result as { artifactId?: unknown }).artifactId === 'string'
        ? (result as { artifactId: string }).artifactId
        : null;
      if (artifactId) coordinator.notifyApprovalUpdated({ artifactId, request: args.request });
      return result;
    };
  }
  if (originalApprovalsUpdate) {
    rawDeps.approvalsUpdate = async (args: ApprovalUpdateArgs) => {
      const result = await originalApprovalsUpdate(args);
      if ((result as { ok?: false })?.ok !== false) {
        coordinator.notifyApprovalUpdated({
          artifactId: args.artifactId,
          request: args.request,
        });
      }
      return result;
    };
  }
  const deps = rawDeps as ActionExecutorDeps;
  const executor = createActionExecutor(deps);
  const runtimeAccountId = params.credentials ? readAccountIdFromToken(params.credentials.token) ?? undefined : undefined;
  // Received RPC dispatch passes its host-built requester context through this harness.
  const resolveContext = (context: (ActionExecutorContext & Pick<RpcActionExecutorContext, 'machineAdmission'>) | undefined,
    actionId?: string) => {
    const accountSettings = !context?.externalActionExecutionAuthorization && context?.surface !== 'rpc'
      ? originationSettingsProvider.getAccountSettings?.() : null;
    return {
      ...(context ?? {}),
      // This is the executing Account, never a substitute for the requester.
      // Received RPC/Machine admission keeps its host-built requester context.
      ...(context?.surface !== 'rpc' && !context?.machineAdmission && runtimeAccountId ? { runtimeAccountId } : {}),
      // A received Action already represents another origin. Do not recheck the
      // controller's Account preference, including on same-Account reception.
      ...(accountSettings ? { managedMachineCreationEnabled: accountSettings.managedMachineCreationEnabled } : {}),
      ...(params.serverId ? { serverId: params.serverId } : {}),
      ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
      ...(params.actionsSettingsProvider && !(actionId === 'discussion.invite' && context?.actionCaller?.kind === 'workflowRun'
        && context.actionCaller.discussionModelReservation && context.actionsSettings)
        ? { actionsSettings: params.actionsSettingsProvider.getActionsSettings() }
        : {}),
      ...(params.getCurrentSessionMetadata ? {
        sessionRoleConfiguration: readSessionRolesV1(params.getCurrentSessionMetadata()) ?? undefined,
      } : {}),
    };
  };
  // Every finite Action phase retains the executor's captured Home, including
  // Session resolution/currentness reads and the subsequent RPC transport.
  const runOnCapturedHome = <T>(run: () => T): T => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run)
    : run();

  return {
    deps,
    observeRecordedApprovalExecution: async args => {
      const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
      const getApproval = deps.approvalsGet;
      const waitForDecision = deps.approvalsWaitForDecision;
      if (!params.credentials || !getApproval || !waitForDecision
        || readAccountIdFromToken(params.credentials.token) !== args.expectedOrigin.accountId) return failure('approval_context_unavailable');
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const current = async () => !args.signal.aborted && await args.isCurrent() && !args.signal.aborted;
      try {
        while (true) {
          if (!await current()) return failure(args.signal.aborted ? 'cancelled' : 'approval_stale');
          const request = await runWithServerHttpBaseUrl(serverUrl, () => getApproval({ artifactId: args.artifactId, serverId: params.serverId ?? null }));
          if (!request) return failure('approval_not_found');
          if (request.v !== 2
            || Object.entries(args.expectedOrigin).some(([key, value]) => Reflect.get(request.executionOriginV1, key) !== value)
            || request.executionOriginV1.target?.kind !== 'machine'
            || request.executionOriginV1.target.machineId !== args.expectedOrigin.machineId) return failure('approval_stale');
          if (!await current()) return failure(args.signal.aborted ? 'cancelled' : 'approval_stale');
          const result = buildActionExecuteResultFromRecordedApprovalExecution(request);
          if (result) return result;
          if (request.status === 'rejected') return failure('approval_rejected');
          if (request.status === 'canceled') return failure('approval_canceled');
          // A returned approval id is the deferred flow. Its observer must not
          // claim another Machine's live blocking decision continuation.
          if (request.approval?.flow !== 'deferred') return failure('approval_context_unavailable');
          // Approval is not execution. The same coordinator subscribes before
          // rereading the durable body; no polling or competing replay begins.
          await waitForDecision({ artifactId: args.artifactId, request, serverId: params.serverId ?? null, signal: args.signal });
        }
      } catch {
        return failure(args.signal.aborted ? 'cancelled' : 'approval_context_unavailable');
      }
    },
    executor: {
      prepare: (actionId, input, context) => runOnCapturedHome(() => executor.prepare(actionId, input, resolveContext(context, actionId))),
      execute: (actionId, input, context) => runOnCapturedHome(() => executor.execute(actionId, input, resolveContext(context, actionId))),
      continueConfidentialApprovalRequest: (input, context) => runOnCapturedHome(() => executor.continueConfidentialApprovalRequest(input, resolveContext(context))),
      replayApprovedApprovalRequest: (args) => runOnCapturedHome(() => executor.replayApprovedApprovalRequest(args)),
    },
  };
}
