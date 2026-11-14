import { logger } from '@/ui/logger';
import { StoredApprovalRequestSchema, isHistoricalPublishApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildActionExecuteResultFromRecordedApprovalExecution, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { settleApprovalRequestReplayInputs } from '@happier-dev/protocol/approvals/approvalRequestTransition';
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
import { DeploymentActionInputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentTemplateInstantiateInputV1Schema, projectDeploymentTemplateInstantiationResultV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createCliActionDeps } from './createCliActionDeps';
import { enrichCliActionApprovalContext } from './enrichCliActionApprovalContext';
import { readControllerDeploymentDispatch } from './controllerDeploymentDispatch';
import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { consumeDeferredCliApprovalResult, subscribeCliApprovalChanges, type CliApprovalRequestedHandler } from './approvals/deferredResult';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { createLiveCliApprovalOrigin } from './approvals/liveOrigin';
import { carriesNativeConfirmation } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import { createCliApprovalsArtifactStore } from './approvals/artifactStore';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];
type ApprovalCreateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0];

export { consumeDeferredCliApprovalResult } from './approvals/deferredResult';

/** Admission can defer Ask only when the receiving Account policy retains it. */
export function isOriginalCliApprovalPreservedAtAccount(actionId: ActionSettingsActionId, input: unknown,
  context: ActionExecutorContext, provider: RuntimeActionSettingsProvider): boolean {
  const accountSettings = provider.getAccountSettings?.();
  return Boolean(accountSettings && isApprovalRequiredByActionsSettings(actionId,
    normalizeActionsSettingsV1(accountSettings.actionsSettingsV1),
    { surface: 'cli', authority: context.authority }, undefined, undefined, input));
}

/** Extra host-local requester custody; never an Action, SDK or transported field. */
export type RecordedApprovalExecutionObservationArgs = Readonly<{
  artifactId: string;
  expectedOrigin: Readonly<{ actionId: string; requestId: string; accountId: string; serverIdentityId: string; machineId: string }>;
  signal: AbortSignal;
  isCurrent?(): Promise<boolean>;
  authorizationHeaders?: ArtifactRequestAuthorizationHeaders;
  accountEncryptionMode?: 'plain' | 'e2ee';
}>;

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0] & Readonly<{
    /** Host-owned reviewed policy; never resolved from Action input or endpoint environment. */
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    /** Current host-read Session choice; omission preserves unbound Account rights. */
    sessionMemoryEnabled?: boolean;
    /** Machine owning an installed runtime override; remote children retain Machine transport. */
    runtimeActionMachineId?: string;
    /** Host prompt/notification for an actual wait; decisions still use approval.request.decide. */
    onApprovalRequested?: CliApprovalRequestedHandler;
  }>,
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: Omit<ReturnType<typeof createActionExecutor>, 'executeAdmittedClientAction'>;
  observeRecordedApprovalExecution(args: RecordedApprovalExecutionObservationArgs): Promise<ActionExecuteResult>;
}> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const liveOrigin = createLiveCliApprovalOrigin({ token: params.credentials?.token ?? params.token,
    accountId: readAccountIdFromToken(params.credentials?.token ?? params.token),
    serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
    decide: (input, context) => runOnCapturedHome(() => executor.execute('approval.request.decide', input, context)),
  });
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
  const readApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input, defaultUiConfirmation, approvedOperation, approvalScope, defaultSafety) =>
    // A contained Workflow invitation retains its admitted restrictions; a
    // later provider waiver is not consent. Current restrictions still apply.
    // Retain admitted caller provenance: the shared policy distinguishes a
    // person's host UI intent from automation and unstamped invocations.
    (hasAcceptedReservationPolicy(id, ctx) && isApprovalRequiredByActionsSettings(id, ctx.actionsSettings!, ctx, defaultSafety, undefined, input, defaultUiConfirmation, undefined, approvedOperation, approvalScope)) || isApprovalRequiredByActionsSettings(
      id,
      params.actionsSettingsProvider?.getActionsSettings()
        ?? ctx.actionsSettings
        ?? actionSettingsProvider.getActionsSettings(),
      ctx,
      defaultSafety, undefined, input, defaultUiConfirmation, undefined, approvedOperation, approvalScope,
    );
  const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx, input, defaultUiConfirmation, approvedOperation, approvalScope, defaultSafety) =>
    // projectAction refuses a policy that cannot survive admission before it
    // sends anything. The receiver persists Ask with the signed Machine root.
    requiresOriginalCliFiniteAdmission(id, ctx) ? false : readApprovalRequired(id, ctx, input, defaultUiConfirmation, approvedOperation, approvalScope, defaultSafety);
  const rawDeps: MutableActionExecutorDeps = {
    ...baseDepsForRuntime,
    prepareApprovalExecutionOriginContext: async () => {
      // Session features can arrive after composition. Capture authenticated
      // Home identity at the existing origin boundary, without changing caller custody.
      const context = await enrichCliActionApprovalContext({
        serverIdentityId: params.serverIdentityId,
        machineId: params.runtimeActionMachineId ?? params.machineActionDirectTargetTransport?.machineId,
        fixedServerId: params.serverId ?? null,
        resolveServerFeaturesSnapshot: async () => params.resolveServerFeaturesSnapshot?.(),
      });
      return context.serverIdentityId ? { serverIdentityId: context.serverIdentityId } : {};
    },
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
      const result = await timeWebLatencyPhase('approval.wait', async () => {
        const notificationLifetime = new AbortController();
        const signal = args.signal ? AbortSignal.any([args.signal, notificationLifetime.signal]) : notificationLifetime.signal;
        const observerLifetime = new AbortController();
        const observerSignal = args.signal ? AbortSignal.any([args.signal, observerLifetime.signal]) : observerLifetime.signal;
        const pending = coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: observerSignal,
        subscribeChanges: subscribeCliApprovalChanges({
          // The Artifact store uses Account credentials; the Session transport
          // bearer cannot subscribe to the Account's decision invalidations.
          token: params.credentials?.token ?? params.token,
          serverHttpBaseUrl: serverUrl,
          artifactId: args.artifactId,
        }),
        readRequest: async () => {
          const getApproval = rawDeps.approvalsGet;
          return getApproval ? await runWithServerHttpBaseUrl(serverUrl, () => getApproval({
            artifactId: args.artifactId,
            serverId: args.serverId ?? null,
          })) : null;
        },
        });
        try {
          liveOrigin.waiterReady(args.artifactId);
          // An external decision may settle while this terminal is prompting.
          // End that prompt with the wait; a prompt/decision failure must also
          // release the observer instead of leaving an invisible local waiter.
          const notification = Promise.resolve().then(() => params.onApprovalRequested?.(args.artifactId, signal,
            decision => executor.execute('approval.request.decide', { artifactId: args.artifactId, decision },
              resolveContext({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, signal },
                'approval.request.decide'))));
          return await Promise.race([pending, notification.then(() => pending)]);
        } catch (error) {
          observerLifetime.abort();
          throw error;
        } finally {
          notificationLifetime.abort();
        }
      }, undefined, () => ({ artifactId: args.artifactId,
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
  const originalApprovalsGet = rawDeps.approvalsGet;
  if (originalApprovalsGet) {
    rawDeps.approvalsGet = async args => liveOrigin.validateRead(args.artifactId, await originalApprovalsGet(args));
  }
  const originalApprovalsUpdate = rawDeps.approvalsUpdate;
  const originalApprovalsCreate = rawDeps.approvalsCreate;
  const signedApprovalStoreForRequest = (request: ApprovalCreateArgs['request'] | ApprovalUpdateArgs['request']) => {
    const origin = request.v === 2 && !isHistoricalPublishApprovalRequestV2(request) ? request.executionOriginV1 : null;
    const authorization = origin?.externalActionExecutionAuthorization;
    const binding = authorization?.binding;
    const patBinding = binding && 'credentialId' in binding ? binding : null;
    if (patBinding && (!params.credentials || patBinding.accountId !== readAccountIdFromToken(params.credentials.token))) {
      throw Object.assign(new Error('credential_scope_denied'), { code: 'credential_scope_denied' });
    }
    if (patBinding && (!patBinding.accountEncryptionMode || params.serverIdentityId !== patBinding.serverIdentityId
      || !params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId)) {
      throw Object.assign(new Error('approval_context_unavailable'), { code: 'approval_context_unavailable' });
    }
    return patBinding && params.credentials && authorization
      ? createCliApprovalsArtifactStore({
        credentials: params.credentials, serverId: params.serverId,
        serverHttpBaseUrl: params.serverHttpBaseUrl,
        getAccountEncryptionMode: async () => patBinding.accountEncryptionMode!,
        approvalAuthorizationHeaders: async request => {
          const signed = resolveExternalActionServerRequestHeaders({
            context: { externalActionExecutionAuthorization: authorization,
              externalActionTarget: patBinding.target },
            effectActionId: patBinding.actionId, method: request.method, path: request.path,
            ...(request.body === undefined ? {} : { body: request.body }),
            daemonToken: params.credentials!.token, serverIdentityId: params.serverIdentityId,
            privateKey: params.externalActionMachineRequestPrivateKey,
            installationId: params.externalActionMachineInstallationId,
          });
          if (!signed.ok) throw Object.assign(new Error('approval_context_unavailable'), { code: 'approval_context_unavailable' });
          return { ...signed.headers, [requesterAccountEncryptionMode]: patBinding.accountEncryptionMode! };
        },
      }) : null;
  };
  if (originalApprovalsCreate) {
    rawDeps.approvalsCreate = async (args: ApprovalCreateArgs) => {
      const signedApprovalStore = signedApprovalStoreForRequest(args.request);
      const result = await liveOrigin.publish(args, () => signedApprovalStore
        ? signedApprovalStore.approvalsCreate(args) : originalApprovalsCreate(args));
      const artifactId = typeof (result as { artifactId?: unknown }).artifactId === 'string'
        ? (result as { artifactId: string }).artifactId
        : null;
      if (artifactId) coordinator.notifyApprovalUpdated({ artifactId, request: args.request });
      return result;
    };
  }
  if (originalApprovalsUpdate) {
    rawDeps.approvalsUpdate = async (args: ApprovalUpdateArgs) => {
      const signedApprovalStore = signedApprovalStoreForRequest(args.request);
      const result = await (signedApprovalStore?.approvalsUpdate ?? originalApprovalsUpdate)(args);
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
  const executor = createActionExecutor({ ...deps, recordActionOutputDiagnostic: diagnostic => {
    logger.warnLocalFile('[Action] Private failure diagnostic', diagnostic);
    deps.recordActionOutputDiagnostic?.(diagnostic);
  } });
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
      ...(params.actionsSettingsProvider
        ? { actionsSettings: actionId && context && hasAcceptedReservationPolicy(actionId, context)
          // Retain accepted invitation restrictions, but resolve references from
          // the current Account collection at this new Action admission.
          ? { ...context.actionsSettings!, approvalProfiles: params.actionsSettingsProvider.getActionsSettings().approvalProfiles }
          : params.actionsSettingsProvider.getActionsSettings() }
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
  const consumeDeferredApproval = (result: ActionExecuteResult, context: ActionExecutorContext) =>
    consumeDeferredCliApprovalResult(result, { onApprovalRequested: params.onApprovalRequested,
      token: params.credentials?.token ?? params.token,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      execute: (actionId, input, actionContext) => runOnCapturedHome(() => executor.execute(actionId, input, actionContext)), context });

  // The installed controller owns preparation and Ask under the signed root.
  // An unsigned local Ask cannot later capture native custody.
  // Preparation returns only a thunk: the coordinator admits it before run().
  const prepareControllerDeploymentDispatch = (actionId: string, input: unknown, context: ActionExecutorContext) => {
    const dispatch = readControllerDeploymentDispatch({ ...params,
      deploymentAction: overrides?.deploymentAction ?? params.deploymentAction,
      deploymentMoveToRepository: overrides?.deploymentMoveToRepository ?? params.deploymentMoveToRepository,
      deploymentTemplateInstantiate: overrides?.deploymentTemplateInstantiate ?? params.deploymentTemplateInstantiate }, actionId, input, context);
    if (!dispatch) return null;
    let result: Promise<ActionExecuteResult> | undefined;
    return { run: () => result ??= Promise.resolve().then(async (): Promise<ActionExecuteResult> => {
      const parsed = dispatch.actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
        ? { actionId: 'deployments.templates.instantiate' as const, result: DeploymentTemplateInstantiateInputV1Schema.safeParse(input) }
        : dispatch.actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
        ? { actionId: dispatch.actionId, result: DeploymentActionInputSchemasV1[dispatch.actionId].safeParse(input) }
        : { actionId: dispatch.actionId, result: DeploymentActionInputSchemasV1[dispatch.actionId].safeParse(input) };
      if (!parsed.result.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      if (dispatch.caller === 'host') {
        if (!isActionEnabled(dispatch.actionId, context)) return { ok: false, errorCode: 'action_disabled', error: 'action_disabled' };
        if (readApprovalRequired(dispatch.actionId, context, parsed.result.data)
          && !isOriginalCliApprovalPreservedAtAccount(dispatch.actionId, parsed.result.data, context, originationSettingsProvider))
          return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      }
      if (parsed.actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1) {
        return projectDeploymentTemplateInstantiationResultV1(
          await baseDepsForRuntime.deploymentTemplateInstantiate!(parsed.result.data, context));
      }
      if (parsed.actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1) {
        const result = await baseDepsForRuntime.deploymentMoveToRepository!(parsed.result.data, context,
          async () => ({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' }));
        return 'ok' in result ? result : { ok: true, result };
      }
      const dispatched = await baseDepsForRuntime.deploymentAction!(parsed.actionId, parsed.result.data, context);
      if ('ok' in dispatched && !dispatched.ok) return 'errorCode' in dispatched
        ? dispatched : { ok: false, errorCode: dispatched.error, error: dispatched.error };
      return { ok: true, result: dispatched };
    }) };
  };

  return {
    deps,
    observeRecordedApprovalExecution: async args => {
      const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
      if (!params.credentials || !args.authorizationHeaders
        && readAccountIdFromToken(params.credentials.token) !== args.expectedOrigin.accountId) return failure('approval_context_unavailable');
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const authorizedStore = args.authorizationHeaders ? createCliApprovalsArtifactStore({
        credentials: params.credentials, serverId: params.serverId, serverHttpBaseUrl: serverUrl,
        approvalAuthorizationHeaders: args.authorizationHeaders,
        getAccountEncryptionMode: async () => args.accountEncryptionMode ?? 'unknown',
      }) : null;
      const getApproval = authorizedStore?.approvalsGet ?? deps.approvalsGet;
      if (!getApproval) return failure('approval_context_unavailable');
      const observed: { request: Awaited<ReturnType<typeof getApproval>> } = { request: null };
      const current = async () => !args.signal.aborted
        && (!args.isCurrent || await args.isCurrent()) && !args.signal.aborted;
      const observe = async (): Promise<ActionExecuteResult> => {
        let generation = 0;
        let wake: (() => void) | undefined;
        let feedFailed = false;
        const invalidate = () => { generation++; wake?.(); wake = undefined; };
        const local = coordinator.subscribeApprovalChanges(change => {
          if (change.artifactId === args.artifactId) invalidate();
        });
        const abort = () => invalidate();
        args.signal.addEventListener('abort', abort, { once: true });
        let accountChanges: ReturnType<ReturnType<typeof subscribeCliApprovalChanges>> | undefined;
        try {
          if (!args.authorizationHeaders) accountChanges = subscribeCliApprovalChanges({ token: params.credentials!.token,
            serverHttpBaseUrl: serverUrl, artifactId: args.artifactId })(invalidate,
            () => { feedFailed = true; invalidate(); });
          while (true) {
            const readGeneration = generation;
            if (args.signal.aborted) return failure('cancelled');
            if (feedFailed) return failure('approval_context_unavailable');
            if (!args.signal.aborted && !await current() && !args.signal.aborted) return failure('approval_stale');
            // Cancellation before the first read still withdraws this exact child.
            const request = await runWithServerHttpBaseUrl(serverUrl, () => getApproval({ artifactId: args.artifactId, serverId: params.serverId ?? null }));
            if (!request) return failure(args.signal.aborted ? 'cancelled' : 'approval_not_found');
            const origin = 'executionOriginV1' in request ? request.executionOriginV1 : undefined;
            if (!origin || (request.v !== 2 && !('kind' in request && request.kind === 'plugin_target_action'))
              || Object.entries(args.expectedOrigin).some(([key, value]) => Reflect.get(origin, key) !== value)
              // Machine-hosted core Actions need no external target. The exact
              // origin Machine above still binds their recorded execution.
              || request.v === 2 && request.executionOriginV1.target !== undefined && (request.executionOriginV1.target.kind !== 'machine'
                || request.executionOriginV1.target.machineId !== args.expectedOrigin.machineId)) return failure(args.signal.aborted ? 'cancelled' : 'approval_stale');
            observed.request = request;
            if (!await current()) return failure(args.signal.aborted ? 'cancelled' : 'approval_stale');
            const result = buildActionExecuteResultFromRecordedApprovalExecution(request);
            if (result) return result;
            if (request.status === 'rejected') return failure('approval_rejected');
            if (request.status === 'canceled') return failure('approval_canceled');
            // A returned approval id is the deferred flow. Its observer must not
            // claim another Machine's live blocking decision continuation.
            if (request.v === 2 ? request.approval?.flow !== 'deferred'
              : !('kind' in request && request.kind === 'plugin_target_action') || request.approvalInputCustody === 'live_only')
              return failure('approval_context_unavailable');
            // A receipt observer must not claim the authenticated decision's
            // live waiter. Both local updates and Account socket changes only
            // invalidate this durable read; approval alone is not execution.
            if (generation === readGeneration && !args.signal.aborted) {
              await new Promise<void>(resolve => {
                wake = resolve;
                if (generation !== readGeneration || args.signal.aborted) invalidate();
              });
            }
          }
        } catch {
          return failure(args.signal.aborted ? 'cancelled' : 'approval_context_unavailable');
        } finally {
          wake = undefined;
          args.signal.removeEventListener('abort', abort);
          local.dispose();
          await accountChanges?.dispose();
        }
      };
      const result = await observe();
      const request = observed.request;
      if (args.signal.aborted && request?.v === 2 && request.status === 'open' && request.approval?.flow === 'deferred') {
        const updateApproval = authorizedStore?.approvalsUpdate ?? deps.approvalsUpdate;
        if (!updateApproval) return failure('approval_context_unavailable');
        try {
          const updated = await runWithServerHttpBaseUrl(serverUrl, () => updateApproval({
            artifactId: args.artifactId, serverId: params.serverId ?? null,
            request: { ...settleApprovalRequestReplayInputs(request), status: 'canceled',
              updatedAtMs: Math.max(Date.now(), request.updatedAtMs) },
          }));
          // The transition owner/CAS preserves a decision that won withdrawal.
          if (!updated.ok && updated.errorCode !== 'invalid_transition' && updated.errorCode !== 'subject_mismatch') return updated;
        } catch {
          return failure('approval_context_unavailable');
        }
      }
      return result;
    },
    executor: {
      prepare: (actionId, input, context) => runOnCapturedHome(() => {
        const resolved = resolveContext(context, actionId);
        const dispatch = prepareControllerDeploymentDispatch(actionId, input, resolved);
        if (dispatch) return Promise.resolve({ kind: 'ready' as const,
          invocation: { run: async () => consumeDeferredApproval(await dispatch.run(), resolved) } });
        return liveOrigin.prepare(resolved, async () => {
          const prepared = await executor.prepare(actionId, input, resolved);
          return prepared.kind === 'ready' ? { ...prepared,
            invocation: { run: async () => consumeDeferredApproval(await prepared.invocation.run(), resolved) } } : prepared;
        });
      }),
      execute: (actionId, input, context) => runOnCapturedHome(() => {
        const resolved = resolveContext(context, actionId);
        const dispatch = prepareControllerDeploymentDispatch(actionId, input, resolved);
        if (dispatch) return dispatch.run().then(result => consumeDeferredApproval(result, resolved));
        return liveOrigin.run(resolved, async () => {
          if (carriesNativeConfirmation(actionId, resolved)) {
            const runActionOperation = resolved.runActionOperation ?? deps.runActionOperation;
            if (!runActionOperation) return { ok: false,
              errorCode: 'admission_unavailable', error: 'admission_unavailable' };
            // The existing request owner consumes or rejoins this invocation
            // before the common owner can honour its carried confirmation.
            return await consumeDeferredApproval(await runActionOperation({ actionId, input, context: resolved,
              execute: owned => executor.execute(actionId, input, owned) }), resolved);
          }
          return await consumeDeferredApproval(await executor.execute(actionId, input, resolved), resolved);
        });
      }),
      continueConfidentialApprovalRequest: (input, context) => runOnCapturedHome(() => executor.continueConfidentialApprovalRequest(input, resolveContext(context))),
      replayApprovedApprovalRequest: (args, machineIngress) => runOnCapturedHome(() => executor.replayApprovedApprovalRequest(args, machineIngress)),
    },
  };
}
