import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';

import { getActionSpec, resolveActionExecutionPlacementForInput, isActionSpecSurfacedOn, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema, isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import { WorkspaceSyncRelationshipWriteActionInputV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { isActionExecutableFromStandaloneMcp } from '@happier-dev/protocol/actions/actionToolExposure';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { REGISTRY_ACTION_IDS_V1 } from '@happier-dev/protocol/registries';
import { DeploymentActionInputSchemasV1, type ActionId } from '@happier-dev/protocol';
import { executeDeploymentAction } from '@happier-dev/protocol/actions/executor/deploymentAction';

import type { StoredCredentials } from '@/persistence';
import { listHappierMcpToolNames, registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import {
  createMcpActionEnablementWithServerFeatureAvailability,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { cacheMcpToolList } from '@/mcp/server/cacheMcpToolList';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createHostApprovalOriginCurrentness } from '@/session/actions/approvals/hostOriginCurrentness';
import { isControllerDeploymentMutationAction } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials, resolveAccountWorkspaceMachine } from '@/session/actions/createCliActionExecutorFromCredentials';
import { dispatchOriginalAccountAction, prepareOriginalAccountPresetAcquire, readExternalActionRequesterInvocation } from '@/api/externalActionExecutionAuthorization';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { createDaemonPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import {
  requestDaemonPluginActionExecution,
  requestDaemonSignedRootActionExecution,
  type DaemonControlRequestOptions,
} from '@/daemon/controlClient';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { reconcileExternalActionTarget, requiresManagedMachineDaemonIngress, resolveManagedControlControllerTarget, resolveSelectedExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import {
  resolveServerHttpBaseUrl,
  runWithServerHttpBaseUrl,
} from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { logger } from '@/ui/logger';

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function readSessionIdFromToolArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const sessionId = normalizeId((args as any).sessionId);
  return sessionId || null;
}

export function createExternalMcpServer(params: Readonly<{
  credentials: StoredCredentials;
  defaultSessionId?: string | null;
  /** Current device Machine identity used by the existing durable approval replay owner. */
  machineId?: string | null;
  pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
  /**
   * `undefined` preserves the ordinary ambient daemon lifecycle owner. A
   * concrete target pins an explicit Home; `null` means that Home has no live
   * daemon and must never fall back to another lifecycle scope.
   */
  daemonControlTarget?: DaemonControlRequestOptions['target'] | null;
  /** Exact authenticated Home feature projection captured by the command owner. */
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Readonly<{ mcp: McpServer; toolNames: string[] }> {
  const serverHttpBaseUrl = resolveServerHttpBaseUrl();
  const serverId = configuration.activeServerId;
  const serverIdentityId = params.serverFeaturesSnapshot?.status === 'ready'
    ? normalizeServerIdentityIdCapability(
        params.serverFeaturesSnapshot.features.capabilities.serverIdentity?.serverIdentityId,
      ) ?? null
    : null;
  const toolSurface = 'mcp' as const;
  const usesApiToken = params.credentials.credentialProvenance === 'api_token';
  const resolveServerFeaturesSnapshot = async () => await fetchServerFeaturesSnapshot({
    serverUrl: serverHttpBaseUrl,
    token: params.credentials.token,
  });
  // A PAT has no Account E2EE material. Keep its MCP presentation narrowed to
  // Actions the public API can admit, then delegate their execution to the
  // daemon that owns the selected machine/Session. Plugin tools have no public
  // Action-id admission path yet, so do not advertise a local PAT bypass.
  const pluginToolCatalog = usesApiToken ? Object.freeze([]) : params.pluginToolCatalog;
  const actionsSettingsProvider = createMcpActionSettingsProvider({ credentials: params.credentials });
  const actionsSettings = actionsSettingsProvider.getActionsSettings();
  const isServerFeatureAvailable = createMcpActionEnablementWithServerFeatureAvailability({
    actionSettingsProvider: actionsSettingsProvider,
    surface: toolSurface,
    hasAuthenticatedRuntime: true,
    readServerFeaturesSnapshot: () => params.serverFeaturesSnapshot,
  });
  const isActionEnabled = (id: ActionId): boolean => (
    (!usesApiToken || PublicActionIdSchema.safeParse(id).success)
    && isActionExecutableFromStandaloneMcp(getActionSpec(id))
    && isServerFeatureAvailable(id)
  );

  let defaultSessionAddress: Readonly<{ serverId: string; sessionId: string }> | null = (() => {
    const sessionId = normalizeId(params.defaultSessionId);
    return sessionId ? { serverId, sessionId } : null;
  })();
  const daemonRelayUnavailable = (actionId: string, cause: 'target_absent' | 'request_failed') => {
    logger.warnLocalFile('[happierMCP] Action daemon relay unavailable', {
      actionId,
      serverId,
      ...(defaultSessionAddress ? { sessionId: defaultSessionAddress.sessionId } : {}),
      cause,
    });
    return { ok: false as const, errorCode: 'daemon_unavailable', error: 'daemon_unavailable' };
  };
  const executor = usesApiToken
    ? createCliActionExecutorFromCredentials({
        credentials: params.credentials,
        actionsSettingsProvider,
        serverId,
        serverApiUrl: serverHttpBaseUrl,
        ...(params.machineId ? { machineId: params.machineId } : {}),
        ...(serverIdentityId ? { serverIdentityId } : {}),
        resolveServerFeaturesSnapshot,
      })
    : (() => {
        const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);
        const cryptoContext = ctx
          ? { mode: 'e2ee' as const, ctx }
          : { mode: 'plain' as const, ctx: null };
        // The command captured these credentials; each Action's signal owns cancellation.
        const isCredentialCurrent = async () => true;
        const { projectWorkerAction: projectWorkerAccountAction, ...accountServerActionPorts } = createAccountServerActionDeps({
          token: params.credentials.token,
          credentials: params.credentials,
          isCredentialCurrent,
          serverId,
          serverHttpBaseUrl,
          ...(serverIdentityId ? { serverIdentityId } : {}),
          resolveServerFeaturesSnapshot,
        });
        const followDeps = createSessionFollowActionDeps({
          token: params.credentials.token,
          credentials: params.credentials,
          isCredentialCurrent,
          serverId,
          serverHttpBaseUrl,
          ...(serverIdentityId ? { serverIdentityId } : {}),
          prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
            credentials: params.credentials,
            serverHttpBaseUrl,
            ...(serverIdentityId ? { serverIdentityId } : {}),
            resolveServerFeaturesSnapshot,
          }),
        });
        const host = {
          ...cryptoContext,
          actionsSettingsProvider,
          token: params.credentials.token,
          credentials: params.credentials,
          isCredentialCurrent,
          serverId,
          ...(serverIdentityId ? { serverIdentityId } : {}),
          serverHttpBaseUrl,
          sessionId: 'cli-global',
          ...(projectWorkerAccountAction ? { projectWorkerAccountAction } : {}),
        };
        const { executor: baseExecutor, deps } = createCliActionExecutorHarness(
          host,
          {
            invokeContributedAction: async (request) => pluginExecutor.invokeContributedAction(request),
            ...accountServerActionPorts,
            ...followDeps,
            isApprovalExecutionOriginCurrent: createHostApprovalOriginCurrentness({ credentials: params.credentials,
              serverId, serverApiUrl: serverHttpBaseUrl, resolveServerFeaturesSnapshot }),
            ...createDiscussionActionDeps({
              credentials: params.credentials,
              serverId,
              serverHttpBaseUrl,
              ...(serverIdentityId ? { serverIdentityId } : {}),
              resolveServerFeaturesSnapshot,
            }),
          },
        );
        const pinnedBaseExecutor = {
          execute: async (...args: Parameters<typeof baseExecutor.execute>) =>
            await runWithServerHttpBaseUrl(
              serverHttpBaseUrl,
              async () => await baseExecutor.execute(...args),
            ),
        };
        const daemonControlTarget = params.daemonControlTarget;
        const requestPluginActionExecution = daemonControlTarget === undefined
          ? undefined
          : daemonControlTarget
            ? async (
                request: Parameters<typeof requestDaemonPluginActionExecution>[0],
                options?: Readonly<{ signal?: AbortSignal }>,
              ) => await requestDaemonPluginActionExecution(request, {
                ...options,
                target: daemonControlTarget,
              })
            : async () => ({
                matched: true as const,
                result: {
                  ok: false as const,
                  errorCode: 'daemon_unavailable',
                  error: 'daemon_unavailable',
                },
              });
        const pluginExecutor = createDaemonPluginActionExecutor({
          base: pinnedBaseExecutor,
          executeInCurrentProcess: (actionId, input, context) => executeAccountPluginAction({
            host, deps, actionId, input, ...(context ? { context } : {}),
          }),
          ...(requestPluginActionExecution ? { requestPluginActionExecution } : {}),
        });
        return {
          execute: async (...args: Parameters<typeof baseExecutor.execute>) => {
            const [actionId, input, context] = args;
            if (actionId === 'machines.managed.acquire') {
              const invocation = readExternalActionRequesterInvocation({ ...context,
                surface: 'mcp', authority: context?.authority ?? 'account_automation' });
              if (!invocation) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
              const selected = await prepareOriginalAccountPresetAcquire({ actionId, input,
                requestId: context?.actionRequestId ?? randomUUID(), credentials: params.credentials,
                serverHttpBaseUrl, ...(serverIdentityId ? { serverIdentityId } : {}),
                invocation, authority: invocation.authority, ...(context?.signal ? { signal: context.signal } : {}) });
              if (selected) return await selected();
            }
            if (isControllerDeploymentMutationAction(actionId, input)) {
              const parsed = DeploymentActionInputSchemasV1[actionId].safeParse(input);
              if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
              if (!deps.deploymentAction) return { ok: false as const, errorCode: 'deployment_executor_unavailable', error: 'deployment_executor_unavailable' };
              // The Environment controller prepares and admits the original
              // intent; local admission would create an unprepared Ask first.
              // The shared deployment owner projects the domain result.
              return await executeDeploymentAction(actionId, parsed.data, {
                ...context,
                surface: 'mcp',
                authority: 'account_automation',
                actionRequestId: context?.actionRequestId ?? randomUUID(),
              }, deps);
            }
            const builtInActionId = ActionIdSchema.safeParse(actionId);
            const syncWrite = builtInActionId.success && isWorkspaceSyncRelationshipWriteActionId(builtInActionId.data);
            if (builtInActionId.success && (syncWrite || builtInActionId.data === 'projects.service.relocate')) {
              const parsed = syncWrite ? WorkspaceSyncRelationshipWriteActionInputV1Schema.safeParse(input)
                : ProjectServiceRelocateInputV1Schema.safeParse(input);
              if (!parsed.success) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
              const workspace = 'sourceWorkspaceRefId' in parsed.data
                ? { serverId: serverIdentityId ?? serverId, id: parsed.data.sourceWorkspaceRefId }
                : { serverId: parsed.data.workspace.serverId, id: parsed.data.workspace.refId };
              const source = await resolveAccountWorkspaceMachine({ credentials: params.credentials,
                workspace, serverId,
                ...(serverIdentityId ? { serverIdentityId } : {}), serverApiUrl: serverHttpBaseUrl,
                ...(context?.signal ? { signal: context.signal } : {}) });
              if (!source.ok) return { ok: false as const, errorCode: source.code, error: source.code };
              const target = context?.externalActionTarget;
              if (target && (target.kind !== 'machine' || target.machineId !== source.machineId)) {
                return { ok: false as const, errorCode: 'target_mismatch', error: 'target_mismatch' };
              }
              const invocation = readExternalActionRequesterInvocation({ ...context,
                surface: 'mcp', authority: context?.authority ?? 'account_automation' });
              if (!invocation) return { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
              // Home admits the original requester before the source daemon
              // creates Ask; approval and Move's worker children retain that root.
              return await dispatchOriginalAccountAction({ actionId: builtInActionId.data, input: parsed.data,
                requestId: context?.actionRequestId ?? randomUUID(), target: { kind: 'machine', machineId: source.machineId },
                credentials: params.credentials, serverHttpBaseUrl,
                ...(serverIdentityId ? { serverIdentityId } : {}), invocation, authority: invocation.authority,
                ...(context?.signal ? { signal: context.signal } : {}) });
            }
            const executionPlacement = builtInActionId.success
              ? resolveActionExecutionPlacementForInput(getActionSpec(builtInActionId.data), input, context?.actionCaller, toolSurface) : null;
            const controlControllerTarget = await resolveManagedControlControllerTarget({ actionId, rawInput: input,
              credentials: params.credentials, serverHttpBaseUrl, ...(context?.signal ? { signal: context.signal } : {}) });
            if (!builtInActionId.success || (
              executionPlacement !== 'client'
              && !requiresManagedMachineDaemonIngress(builtInActionId.data, executionPlacement, controlControllerTarget)
              && !REGISTRY_ACTION_IDS_V1.some(id => id === builtInActionId.data)
            )) {
              return await pluginExecutor.execute(...args);
            }
            // Delegate before local admission: this exact Home's daemon owns
            // client delivery and the admitted plugin registry occurrence.
            if (daemonControlTarget === null) return daemonRelayUnavailable(actionId, 'target_absent');
            const admittedActionId = SignedRootActionIdSchema.safeParse(actionId);
            if (!admittedActionId.success) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const sessionId = context?.defaultSessionId && context.defaultSessionId !== 'cli-global'
              ? context.defaultSessionId : null;
            const reconciliation = reconcileExternalActionTarget({
              actionId: admittedActionId.data,
              rawInput: input,
              target: context?.externalActionTarget
                ?? controlControllerTarget
                ?? (params.machineId ? { kind: 'machine', machineId: params.machineId } : undefined),
              currentMachineId: params.machineId ?? '',
              context: { actionCaller: context?.actionCaller, surface: toolSurface },
            });
            if (reconciliation.kind === 'rejected') return reconciliation.execution;
            // The same ingress owner selects explicit parsed Session targets.
            // A primary-target clear addresses the client, not the old cursor.
            const target = executionPlacement !== 'client' || reconciliation.target?.kind === 'session' || context?.externalActionTarget
              || actionId === 'session.target.primary.set' || !sessionId
              ? reconciliation.target : { kind: 'session' as const, sessionId };
            const result = await requestDaemonSignedRootActionExecution({
              actionId: admittedActionId.data,
              input,
              surface: 'mcp',
              ...(target ? { target } : {}),
              ...(context?.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
            }, {
              ...(daemonControlTarget ? { target: daemonControlTarget } : {}),
              ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (actionId === 'session.target.primary.set' && result.ok) {
              const cursor = result.result;
              // This cursor is caller context only. Observe the canonical UI
              // target owner's accepted result; never execute its mutation here.
              if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)
                && 'ok' in cursor && cursor.ok === true && 'status' in cursor && cursor.status === 'ok'
                && 'sessionId' in cursor && 'serverId' in cursor) {
                if (cursor.sessionId === null && cursor.serverId === null) defaultSessionAddress = null;
                else if (typeof cursor.serverId === 'string' && await isServerProfileHomeIdentity(serverId, cursor.serverId)
                  && typeof cursor.sessionId === 'string' && cursor.sessionId.trim()) {
                  defaultSessionAddress = { serverId, sessionId: cursor.sessionId.trim() };
                }
              }
            }
            return !result.ok && result.errorCode === 'daemon_unavailable'
              ? daemonRelayUnavailable(actionId, 'request_failed') : result;
          },
        };
      })();
  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  }, { capabilities: { resources: { subscribe: true } } });
  cacheMcpToolList(mcp);

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    isActionEnabled: (id) => {
      const spec = getActionSpec(id);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabled(id);
    },
    surface: toolSurface,
    actionsSettings,
    pluginToolCatalog,
    defaultSessionMachineId: params.machineId,
    resolveSessionListAccess: (defaultSessionId) => (
      defaultSessionAddress?.sessionId === defaultSessionId ? 'current_session' : undefined
    ),
  });

  registerHappierMcpResources(mcp, {
    surface: toolSurface,
    isActionEnabled,
    watch: { server: mcp, execute: actionToolBridge.executeActionByToolName,
      defaultSessionId: defaultSessionAddress?.sessionId ?? 'cli-global', isEnabled: () => isActionEnabled('wait') },
  });

  const { toolNames } = registerHappierMcpBuiltInTools(mcp, {
    sessionId: 'cli-global',
    surface: toolSurface,
    actionsSettings,
    pluginToolCatalog,
    resolveSessionId: (toolArgs) => readSessionIdFromToolArgs(toolArgs) ?? defaultSessionAddress?.sessionId ?? 'cli-global',
    deps: {
      changeTitle: createChangeTitleToolHandler({
        executor,
        surface: toolSurface,
      }),
      executeActionByToolName: actionToolBridge.executeActionByToolName,
      resolveActionOptions: async (resolverArgs) =>
        await actionToolBridge.resolveActionOptions(
          resolverArgs,
          readSessionIdFromToolArgs(resolverArgs) ?? defaultSessionAddress?.sessionId ?? 'cli-global',
        ),
      isActionEnabled: actionToolBridge.isActionEnabled,
    },
  });

  return { mcp, toolNames: listHappierMcpToolNames(toolNames) };
}
