import type { CliMachineActionCall } from './machineTransport';
import type { CliActionDepsParams } from './types';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createArtifactAccessActionsV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import type { ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { assertAccountRoleArtifactDeletionV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { createCliArtifactActions } from '../artifactActions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
export function createCliArtifactsActionDeps(
  params: Pick<CliActionDepsParams, 'machineActionDirectTargetTransport' | 'onPublicLinkIssued' | 'consumeArtifactSignedInLinkSecret' | 'onArtifactSignedInLinkOpened' | 'serverHttpBaseUrl' | 'serverId'>,
  { artifactCallerContext, callMachineAction, homeAccountId, readRawRoleSettings, requireLocalPromptActionMachine, resolveServerRequestHeaders, resolveWorkspacePublishCaller, roleAccountLifetimeToken, roleAccountScopeKey, roleArtifactStore }: Readonly<{
    artifactCallerContext: (context: ActionExecutorContext) => ActionExecutorContext;
    callMachineAction: CliMachineActionCall;
    homeAccountId: string | null;
    readRawRoleSettings: ((options?: Readonly<{ requireCurrentNetwork: boolean }>) => Promise<Readonly<Record<string, unknown>>>) | undefined;
    requireLocalPromptActionMachine: (machineId: string) => Promise<Readonly<{
    ok: true;
  }> | Readonly<{
    ok: false;
    errorCode: 'machine_not_found';
    error: 'machine_not_found';
  }>>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveWorkspacePublishCaller: (context: ActionExecutorContext) => Promise<import("../publishArtifactFromWorkspaceFile").ArtifactWorkspaceCaller | null>;
    roleAccountLifetimeToken: ReturnType<typeof getActiveAccountSettingsSnapshotLifetimeToken>;
    roleAccountScopeKey: ReturnType<typeof resolveAccountSettingsScopeKeyForToken>;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
  }>,
): Pick<ActionExecutorDeps, 'artifactAction' | 'artifactAccessAction'> {
  return {
    artifactAction: async (args) => {
      if (!roleArtifactStore) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const { createCliArtifactActions } = await import("../artifactActions");
      const execute = createCliArtifactActions({ store: roleArtifactStore, onPublicLinkIssued: params.onPublicLinkIssued,
        consumeArtifactSignedInLinkSecret: params.consumeArtifactSignedInLinkSecret,
        onArtifactSignedInLinkOpened: params.onArtifactSignedInLinkOpened,
        authorizationHeaders: (context, effectActionId) => async request => {
          const headers = resolveServerRequestHeaders(context, effectActionId, request);
          if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
          return { ...headers };
        },
        beforeDelete: async ({ artifactId, signal }) => {
          signal?.throwIfAborted();
          const assertCurrent = () => {
            if (!isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken })) {
              throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
            }
          };
          assertCurrent();
          if (!homeAccountId || !readRawRoleSettings) {
            throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
          }
          const rawSettings = await readRawRoleSettings({ requireCurrentNetwork: true });
          signal?.throwIfAborted();
          assertCurrent();
          await assertAccountRoleArtifactDeletionV1({ artifactId, accountId: homeAccountId, rawSettings,
            readTargetArtifactKind: async () => {
              const artifact = await roleArtifactStore.read(artifactId, { signal, includeSharedAudience: false });
              signal?.throwIfAborted();
              assertCurrent();
              return typeof artifact?.header.kind === 'string' ? artifact.header.kind : undefined;
            } });
        }, resolvePublishCaller: async (context, workspace) => {
          if (!workspace) return await resolveWorkspacePublishCaller(context);
          if (!(await requireLocalPromptActionMachine(workspace.machineId)).ok) return null;
          return { machineId: workspace.machineId, rootPath: workspace.rootPath, directory: workspace.rootPath };
        },
        forwardWorkspacePublication: async (input, context, signal) => {
          // The existing Machine Action owns acquisition and publication. Never
          // copy from the invoking Session or create another Account publisher.
          if (params.machineActionDirectTargetTransport?.machineId === input.workspace.machineId
            || context.externalActionExecutionAuthorization?.binding.machineId === input.workspace.machineId)
            return { ok: false, errorCode: 'artifact_source_unavailable', error: 'artifact_source_unavailable' };
          const target = { kind: 'machine' as const, machineId: input.workspace.machineId };
          const method = getActionSpec('artifact.publish_from_file').bindings?.rpcMethod;
          if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
          return await callMachineAction({ machineId: input.workspace.machineId,
            serverId: context.serverId ?? params.serverId, method,
            request: createTargetedActionRpcRequestV1(input, target, context),
            context: { ...context, externalActionTarget: target },
            authority: context.authority, authorization: context.rpcSessionAuthorization,
            effectActionId: 'artifact.publish_from_file', exactMachine: true,
            ...(signal ? { signal } : {}), timeoutMs: null });
        } });
      return params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute({ ...args, context: artifactCallerContext(args.context) }))
        : execute({ ...args, context: artifactCallerContext(args.context) });
    },
    artifactAccessAction: async (args) => {
      if (!roleArtifactStore) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const authorizationHeaders: ArtifactRequestAuthorizationHeaders | undefined =
        args.context.externalActionCredential || args.context.externalActionExecutionAuthorization ? async request => {
          const headers = resolveServerRequestHeaders(args.context, args.actionId, request);
          if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
          return { ...headers };
        } : undefined;
      const options = authorizationHeaders ? { authorizationHeaders } : undefined;
      const artifactAccessAction = createArtifactAccessActionsV1({
        read: (artifactId, readOptions) => roleArtifactStore.read(artifactId, { ...readOptions,
          ...(authorizationHeaders ? { authorizationHeaders, includeSharedAudience: false } : {}) }),
        transport: {
          list: (input, signal) => roleArtifactStore.accessGrants.list(input, signal, options),
          set: (input, signal) => roleArtifactStore.accessGrants.set(input, signal, options),
          remove: (input, signal) => roleArtifactStore.accessGrants.remove(input, signal, options),
        },
      });
      return params.serverHttpBaseUrl
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => artifactAccessAction(args)) : artifactAccessAction(args);
    },
  };
}
