import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { readSessionRolesV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import type { ActionExecutorDeps } from '@happier-dev/protocol';

import { createActionSettingsProvider, type RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliBrowserRuntimeActionExecutor } from '@/daemon/browser/actions/controlTransport';
import { observeAccountChanges } from '@/api/observeAccountChanges';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';
import { getSharedBlockingApprovalCoordinator } from './approvals/blockingApprovalCoordinator';

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];
type ApprovalCreateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0];

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0] & Readonly<{
    /** Host-owned reviewed policy; never resolved from Action input or endpoint environment. */
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
  }>,
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
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
  const isActionEnabled: NonNullable<ActionExecutorDeps['isActionEnabled']> = (id, ctx) =>
    isActionEnabledByActionsSettings(
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
      return { ...result, request: ApprovalRequestSchema.parse(result.request) };
    },
    approvalsResolveBlockingDecision: async (args: ApprovalResolveBlockingDecisionArgs) =>
      await coordinator.resolveBlockingDecision({
        artifactId: args.artifactId,
        request: args.request,
        decision: args.decision,
      }),
    isActionEnabled,
    isActionApprovalRequired,
    runtimeActionExecute: createCliBrowserRuntimeActionExecutor({ sessionId: params.sessionId }),
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
  const resolveContext = (context: Parameters<typeof executor.execute>[2]) => ({
    ...(context ?? {}),
    ...(params.serverId ? { serverId: params.serverId } : {}),
    ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
    ...(params.actionsSettingsProvider
      ? { actionsSettings: params.actionsSettingsProvider.getActionsSettings() }
      : {}),
    ...(params.getCurrentSessionMetadata ? {
      sessionRoleConfiguration: readSessionRolesV1(params.getCurrentSessionMetadata()) ?? undefined,
    } : {}),
  });

  return {
    deps,
    executor: {
      prepare: (actionId, input, context) => executor.prepare(actionId, input, resolveContext(context)),
      execute: (actionId, input, context) => executor.execute(actionId, input, resolveContext(context)),
      replayApprovedApprovalRequest: (args) => executor.replayApprovedApprovalRequest(args),
    },
  };
}
