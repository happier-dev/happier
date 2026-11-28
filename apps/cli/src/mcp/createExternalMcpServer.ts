import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';

import { getActionSpec, hasDeclaredActionDaemonIngress, resolveActionExecutionPlacementForInput, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { isActionExecutableFromStandaloneMcp } from '@happier-dev/protocol/actions/actionToolExposure';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { REGISTRY_ACTION_IDS_V1 } from '@happier-dev/protocol/registries';
import { DeploymentActionInputSchemasV1, type ActionId } from '@happier-dev/protocol';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
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
import { DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, isDeploymentReadActionIdV1, isDeploymentTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isDeploymentEnvironmentPlacementActionV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createCliActionExecutorFromCredentials, readSourceWorkspaceWrite, resolveAccountWorkspaceMachine } from '@/session/actions/createCliActionExecutorFromCredentials';
import { dispatchOriginalAccountAction, prepareOriginalAccountPresetAcquire, readExternalActionRequesterInvocation, resolveOriginalAccountActionPlacement } from '@/api/externalActionExecutionAuthorization';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { resolveCliActionCallerWorkflowTarget } from '@/session/actions/resolveCliActionCallerSession';
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
import { isWorkspaceSyncStopAction, prepareWorkspaceSyncStopPlacement } from '@/workspaces/sync/resolveWorkspaceSyncStopController';
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
  defaultSessionWorkspace?: WorkspaceAddressV1 | null;
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
  const readDecision = (id: ActionId) => {
    if ((usesApiToken && !PublicActionIdSchema.safeParse(id).success)
      || !isActionExecutableFromStandaloneMcp(getActionSpec(id))) return { enabled: false };
    return isServerFeatureAvailable.readDecision?.(id) ?? { enabled: isServerFeatureAvailable(id) };
  };
  const isActionEnabled = Object.assign((id: ActionId) => readDecision(id).enabled, { readDecision });

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
          resolveServerFeaturesSnapshot,
          ...(projectWorkerAccountAction ? { projectWorkerAccountAction } : {}),
        };
        const { executor: baseExecutor, deps, resolveContext } = createCliActionExecutorHarness(
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
            host, deps, resolveContext, actionId, input, ...(context ? { context } : {}),
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
            if (isDeploymentTransportActionIdV1(actionId) && isDeploymentEnvironmentPlacementActionV1(actionId, input,
              resolveActionExecutionPlacementForInput(getActionSpec(actionId), input, context?.actionCaller, 'mcp'),
              { canPrepareAccountBindings: true }) && !isDeploymentReadActionIdV1(actionId)
              && (actionId !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || getActionSpec(actionId).safetyForInput?.(input) !== 'safe')) {
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
            if (isWorkspaceSyncStopAction(actionId)) {
              const placement = await prepareWorkspaceSyncStopPlacement({ rawInput: input,
                credentials: params.credentials, serverId: serverIdentityId ?? serverId, serverHttpBaseUrl,
                machineId: params.machineId, target: context?.externalActionTarget, signal: context?.signal,
              });
              if (!placement) return await pluginExecutor.execute(actionId, input, context);
              if (!placement.ok) return placement;
              return await pluginExecutor.execute(actionId, placement.input, { ...context, externalActionTarget: placement.target });
            }
            const builtInActionId = ActionIdSchema.safeParse(actionId);
            const sourceWrite = readSourceWorkspaceWrite(actionId, input, serverIdentityId ?? serverId);
            if (sourceWrite !== undefined) {
              if (!sourceWrite) return { ok: false as const, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
              const source = await resolveAccountWorkspaceMachine({ credentials: params.credentials,
                workspace: sourceWrite.workspace, serverId,
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
              return await dispatchOriginalAccountAction({ actionId: sourceWrite.actionId, input: sourceWrite.input,
                requestId: context?.actionRequestId ?? randomUUID(), target: { kind: 'machine', machineId: source.machineId },
                credentials: params.credentials, serverHttpBaseUrl,
                ...(serverIdentityId ? { serverIdentityId } : {}), invocation, authority: invocation.authority,
                ...(context?.signal ? { signal: context.signal } : {}) });
            }
            const builtInSpec = builtInActionId.success ? getActionSpec(builtInActionId.data) : null;
            const placement = builtInSpec ? resolveOriginalAccountActionPlacement(builtInSpec, input, {
              actionCaller: context?.actionCaller, surface: toolSurface,
            }) : null;
            if (placement && !placement.ok) return placement;
            const executionPlacement = placement?.placement ?? null;
            const controlControllerTarget = await resolveManagedControlControllerTarget({ actionId, rawInput: input,
              credentials: params.credentials, serverHttpBaseUrl, ...(context?.signal ? { signal: context.signal } : {}) });
            const sessionId = context?.defaultSessionId && context.defaultSessionId !== 'cli-global'
              ? context.defaultSessionId : null;
            let requestedTarget = context?.externalActionTarget ?? controlControllerTarget ?? undefined;
            if ((actionId === 'workflow.run.start' || actionId === 'machines.command.run') && sessionId
              && !(requestedTarget?.kind === 'machine' && requestedTarget.project)) {
              // Focus supplies placement only; it never authenticates the MCP
              // caller as this Session or grants present-user authority.
              const focusedTarget = await resolveCliActionCallerWorkflowTarget({
                context: { ...context, defaultSessionId: sessionId }, credentials: params.credentials,
                boundSessionId: sessionId, ...(requestedTarget ? { target: requestedTarget } : {}),
                resolveTransportForSession: (idOrPrefix, signal) => runWithServerHttpBaseUrl(serverHttpBaseUrl, async () =>
                  resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials, idOrPrefix,
                    serverFeaturesSnapshot: await resolveServerFeaturesSnapshot(), ...(signal ? { signal } : {}) })),
              });
              if (!focusedTarget) {
                const errorCode = actionId === 'machines.command.run' ? 'command_target_required' : 'target_unavailable';
                return { ok: false as const, errorCode, error: errorCode };
              }
              requestedTarget = focusedTarget;
            }
            if (!builtInActionId.success || !builtInSpec || (
              executionPlacement !== 'client'
              && !(hasDeclaredActionDaemonIngress(builtInSpec, 'cli')
                && (daemonControlTarget !== null || builtInSpec.originalExecution?.accountRoot !== 'allowed'))
              && !requiresManagedMachineDaemonIngress(builtInActionId.data, executionPlacement, controlControllerTarget)
              && !REGISTRY_ACTION_IDS_V1.some(id => id === builtInActionId.data)
            )) {
              return await pluginExecutor.execute(actionId, input, actionId === 'machines.command.run' && requestedTarget
                ? { ...context, externalActionTarget: requestedTarget } : context);
            }
            // Delegate before local admission: this exact Home's daemon owns
            // client delivery and the admitted plugin registry occurrence.
            if (daemonControlTarget === null) return daemonRelayUnavailable(actionId, 'target_absent');
            const admittedActionId = SignedRootActionIdSchema.safeParse(actionId);
            if (!admittedActionId.success) return { ok: false as const, errorCode: 'unsupported_action', error: 'unsupported_action' };
            const reconciliation = reconcileExternalActionTarget({
              actionId: admittedActionId.data,
              rawInput: input,
              target: requestedTarget ?? (params.machineId ? { kind: 'machine', machineId: params.machineId } : undefined),
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
    isActionEnabled,
    surface: toolSurface,
    actionsSettings,
    pluginToolCatalog,
    defaultSessionMachineId: params.machineId,
    defaultSessionWorkspace: params.defaultSessionWorkspace,
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
    sessionWorkspace: params.defaultSessionWorkspace,
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
