import type { CliMachineActionCall } from './machineTransport';
import type { CliActionDepsParams } from './types';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createArtifactAccessActionsV1 } from '@happier-dev/protocol/actions/executor/artifactAccessActions';
import { createWidgetSurfaceArtifactPortV1, readWidgetSurfaceArtifactV1, WIDGET_SURFACE_ARTIFACT_KIND_V1, WidgetAreaMutationErrorV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import type { CliWidgetActionDeps } from './widgets';
import type { ArtifactRequestAuthorizationHeaders } from '@/api/artifacts/accountArtifactStore';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareAccountRoleArtifactDeletionV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { createCliArtifactActions } from '../artifactActions';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readRequesterDeploymentArtifactStore } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { PROJECT_SETUP_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
export function createCliArtifactsActionDeps(
  params: Pick<CliActionDepsParams, 'machineActionDirectTargetTransport' | 'onPublicLinkIssued' | 'consumeArtifactSignedInLinkSecret' | 'onArtifactSignedInLinkOpened' | 'serverHttpBaseUrl' | 'serverId'>,
  { artifactCallerContext, callMachineAction, homeAccountId, readRawRoleSettings, mutateRawAccountSettings, requireLocalPromptActionMachine, resolveServerRequestHeaders, resolveWorkspacePublishCaller, roleAccountLifetimeToken, roleAccountScopeKey, roleArtifactStore, readWidgetTitles, widgetAccountScope, isWidgetScopeCurrent }: Readonly<{
    artifactCallerContext: (context: ActionExecutorContext) => ActionExecutorContext;
    callMachineAction: CliMachineActionCall;
    homeAccountId: string | null;
    readRawRoleSettings: ((options?: Readonly<{ requireCurrentNetwork: boolean }>) => Promise<Readonly<Record<string, unknown>>>) | undefined;
    mutateRawAccountSettings: Parameters<typeof prepareAccountRoleArtifactDeletionV1>[0]['mutateRawAccountSettings'];
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
    readWidgetTitles: CliWidgetActionDeps['readWidgetTitles'];
    widgetAccountScope: NonNullable<ActionExecutorDeps['widgetAccountScope']>;
    isWidgetScopeCurrent: CliWidgetActionDeps['isWidgetScopeCurrent'];
  }>,
): Pick<ActionExecutorDeps, 'artifactAction' | 'artifactAccessAction'> {
  return {
    artifactAction: async (args) => {
      const authorization = args.context.externalActionExecutionAuthorization;
      const setupDecision = authorization?.binding.actionId === PROJECT_SETUP_SET_ACTION_ID_V1;
      const requesterStore = setupDecision ? readRequesterDeploymentArtifactStore(authorization) : null;
      if (setupDecision && !requesterStore) return { ok: false, errorCode: 'project_requester_authority_unavailable', error: 'project_requester_authority_unavailable' };
      const store = requesterStore ?? roleArtifactStore;
      if (!store) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      // The captured content owner also supplies new revision attribution.
      const context = { ...artifactCallerContext(args.context),
        ...(requesterStore && authorization ? { runtimeAccountId: authorization.binding.accountId } : {}) };
      const { createCliArtifactActions } = await import("../artifactActions");
      const execute = createCliArtifactActions({ store, onPublicLinkIssued: params.onPublicLinkIssued,
        consumeArtifactSignedInLinkSecret: params.consumeArtifactSignedInLinkSecret,
        onArtifactSignedInLinkOpened: params.onArtifactSignedInLinkOpened,
        authorizationHeaders: (context, effectActionId) => async request => {
          const headers = resolveServerRequestHeaders(context, effectActionId, request);
          if (!headers) throw Object.assign(new Error('execution_not_authorized'), { code: 'execution_not_authorized' });
          return { ...headers };
        },
        beforeDelete: async ({ artifactId, expectedRevision, signal }) => {
          signal?.throwIfAborted();
          const assertCurrent = () => {
            if (!isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken })) {
              throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
            }
          };
          if (!homeAccountId || !readRawRoleSettings) {
            throw Object.assign(new Error('account_settings_content_unavailable'), { code: 'account_settings_content_unavailable' });
          }
          const rawSettings = await readRawRoleSettings({ requireCurrentNetwork: true });
          signal?.throwIfAborted();
          let targetRead: ReturnType<typeof store.read> | undefined;
          const readTarget = () => targetRead ??= store.read(artifactId, { signal, includeSharedAudience: false });
          await prepareAccountRoleArtifactDeletionV1({ artifactId, expectedRevision, signal, accountId: homeAccountId, rawSettings,
            // The Role snapshot lifetime governs predecessor Settings cleanup;
            // ordinary Artifact reads/deletion use the captured Artifact credentials.
            mutateRawAccountSettings: mutateRawAccountSettings ? async (mutate, signal) => {
              assertCurrent();
              await mutateRawAccountSettings(mutate, signal);
            } : undefined,
            readTargetArtifactRevision: async () => {
              const artifact = await readTarget();
              signal?.throwIfAborted();
              return artifact?.revision;
            },
            readTargetArtifactKind: async () => {
              const artifact = await readTarget();
              signal?.throwIfAborted();
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
        ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute({ ...args, context }))
        : execute({ ...args, context });
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
        prepareSharing: async (resource, signal) => {
          if (resource.header.kind !== WIDGET_SURFACE_ARTIFACT_KIND_V1) return;
          if (typeof resource.body !== 'string') throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
          const layout = readWidgetSurfaceArtifactV1({ artifactId: resource.artifactId, header: resource.header, body: resource.body });
          if (!layout) throw new WidgetAreaMutationErrorV1('invalid_widget_area_record');
          const scope = widgetAccountScope();
          if (!scope || !(scope.isSameServerId?.(layout.surface.serverId) ?? scope.serverId === layout.surface.serverId)) {
            throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
          }
          const isCurrent = () => {
            const current = widgetAccountScope();
            return current?.serverId === scope.serverId && current.accountId === scope.accountId
              && isWidgetScopeCurrent();
          };
          const transport = createAcknowledgedAccountArtifactTransport({
            read: (id, readOptions) => roleArtifactStore.read(id, { ...readOptions, ...options,
              prepareRecipients: false, includeSharedAudience: false }),
            create: input => roleArtifactStore.create({ ...input, ...options }),
            update: input => roleArtifactStore.update({ ...input, ...options }),
          });
          await createWidgetSurfaceArtifactPortV1(transport, {
            surface: { ...layout.surface, artifactId: resource.artifactId }, isCurrent,
            readTitles: (instances, signal) => readWidgetTitles(instances, signal, authorizationHeaders),
          }).prepareSharing(signal);
        },
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
