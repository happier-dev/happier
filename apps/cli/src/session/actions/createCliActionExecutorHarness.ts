import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildActionExecuteResultFromRecordedApprovalExecution, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isActionEnabledWithSessionMemory } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { resolveRuntimeActionExecutionFamily } from '@happier-dev/protocol/actions/executor/dispatch';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliBrowserRuntimeActionExecutor } from '@/daemon/browser/actions/controlTransport';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];
type ApprovalCreateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0];

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
  }>,
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
  observeRecordedApprovalExecution(args: RecordedApprovalExecutionObservationArgs): Promise<ActionExecuteResult>;
}> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const baseDeps = createCliActionDeps(params);
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
  const isActionEnabled: NonNullable<ActionExecutorDeps['isActionEnabled']> = (id, ctx) =>
    isActionEnabledWithSessionMemory(id, params.sessionMemoryEnabled) && isActionEnabledByActionsSettings(
      id,
      params.actionsSettingsProvider?.getActionsSettings()
        ?? ctx.actionsSettings
        ?? actionSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? 'cli',
        placement: ctx.placement ?? null,
      },
    );
  const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx) =>
    isApprovalRequiredByActionsSettings(
      id,
      params.actionsSettingsProvider?.getActionsSettings()
        ?? ctx.actionsSettings
        ?? actionSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? null,
        authority: ctx.authority,
        presentUserConfirmation: ctx.presentUserConfirmation,
      },
    );
  const rawDeps: MutableActionExecutorDeps = {
    ...baseDepsForRuntime,
    approvalsWaitForDecision: async (args: ApprovalWaitForDecisionArgs) => {
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const result = await coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: args.signal,
        subscribeChanges: (onChange, onError) => observeAccountChanges({
          token: params.token,
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
      });
      return { ...result, request: StoredApprovalRequestSchema.parse(result.request) };
    },
    approvalsResolveBlockingDecision: async (args: ApprovalResolveBlockingDecisionArgs) =>
      await coordinator.resolveBlockingDecision({
        artifactId: args.artifactId,
        request: args.request,
        decision: args.decision,
        decisionAuthority: args.decisionAuthority,
      }),
    isActionEnabled,
    isActionApprovalRequired,
    runtimeActionExecute: (() => {
      const browser = createCliBrowserRuntimeActionExecutor({ sessionId: params.sessionId });
      const execute: NonNullable<ActionExecutorDeps['runtimeActionExecute']> = async args =>
        resolveRuntimeActionExecutionFamily(args.actionId) === 'localServices'
        && baseDepsForRuntime.runtimeActionExecute
        ? await baseDepsForRuntime.runtimeActionExecute(args) : await browser(args);
      return execute;
    })(),
    ...createActionExecutionHookDeps(),
    ...(overrides ?? {}),
  };
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
  const resolveContext = (context: Parameters<typeof executor.execute>[2]) => {
    const accountSettings = !context?.externalActionExecutionAuthorization && context?.surface !== 'rpc'
      ? originationSettingsProvider.getAccountSettings?.() : null;
    return {
      ...(context ?? {}),
      // A received Action already represents another origin. Do not recheck the
      // controller's Account preference, including on same-Account reception.
      ...(accountSettings ? { managedMachineCreationEnabled: accountSettings.managedMachineCreationEnabled } : {}),
      ...(params.serverId ? { serverId: params.serverId } : {}),
      ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
      ...(params.actionsSettingsProvider
        ? { actionsSettings: params.actionsSettingsProvider.getActionsSettings() }
        : {}),
      ...(params.getCurrentSessionMetadata ? {
        sessionRoleConfiguration: readSessionRolesV1(params.getCurrentSessionMetadata()) ?? undefined,
      } : {}),
    };
  };

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
      prepare: (actionId, input, context) => executor.prepare(actionId, input, resolveContext(context)),
      execute: (actionId, input, context) => executor.execute(actionId, input, resolveContext(context)),
      continueConfidentialApprovalRequest: (input, context) => executor.continueConfidentialApprovalRequest(input, resolveContext(context)),
      replayApprovedApprovalRequest: (args) => executor.replayApprovedApprovalRequest(args),
    },
  };
}
