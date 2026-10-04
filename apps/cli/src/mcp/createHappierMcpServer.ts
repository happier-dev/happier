import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionWorkerPublishInputV1 } from '@happier-dev/protocol';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';
import type { RpcLocalActionContext } from '@/api/rpc/types';

import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import type { HappierBuiltInToolDispatchResult } from '@/agent/tools/happierTools/types';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import {
  readStoredCredentialsForServerId,
  sameStoredCredentials,
  type StoredCredentials,
} from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import {
  createDaemonPluginActionExecutor,
  createPluginActionExecutor,
} from '@/session/actions/createDaemonPluginActionExecutor';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  resolveSessionEncryptionContextFromCredentials,
  type SessionTransportEncryptionMaterial,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { resolvePermissionIntentFromMetadataSnapshot } from '@/agent/runtime/permissions/modeFromMetadata';
import { resolveExecutionRunPublicBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import {
  PromptRegistryInstallRequestV1Schema,
  PromptRegistryInstallResponseV1Schema,
  type ActionId,
  type AccountSettings,
  type ActionExecutorDeps,
  type BackendTargetRefV2,
  getActionSpec,
  isActionSpecSurfacedOn,
  normalizeServerIdentityIdCapability,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MemorySearchResultV1Schema, MemoryWindowV1Schema, type MemorySearchResultV1, type MemoryWindowV1, type SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import { createSessionStateSyncEngine } from '@happier-dev/agents';
import {
  createMcpActionApprovalRequirement,
  createMcpActionEnablementWithServerFeatureAvailability,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { isSessionBoundMemoryTarget } from '@/mcp/sessionBoundMemoryTarget';
import { createSessionDiscussionActionDeps } from '@/session/discussions/sessionDiscussionActionDeps';
import { createSessionBoardActionDeps } from '@/session/board/sessionBoardActionDeps';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { createSessionAccountActionExecutor } from '@/mcp/runtime/createSessionAccountActionExecutor';

const MCP_SESSION_STATE_CAPABILITIES: SessionStateCapabilitiesV1 = {
  display: {
    title: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
  },
};

function resolveLiveClientPermissionMode(client: HappyMcpSessionClient): string | null {
  const mode = client.getPermissionMode?.();
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

/**
 * The active-turn witness is host-owned. Preserve its raw value through the
 * host-only Action context so the canonical strict parser can reject malformed
 * authority rather than treating it as absent and broadening a call.
 */
function resolveLiveClientActiveTurnPermissionWitness(client: HappyMcpSessionClient): unknown {
  try {
    return client.getActiveTurnPermissionWitness?.() ?? null;
  } catch {
    return null;
  }
}

function resolveLiveClientBackendTarget(client: HappyMcpSessionClient): BackendTargetRefV2 | null {
  return client.getBackendTarget?.() ?? null;
}

function resolveLiveClientLocation(client: HappyMcpSessionClient): Readonly<{
  path?: string | null;
  host?: string | null;
  machineId?: string | null;
}> | null {
  return client.getCurrentSessionLocation?.() ?? null;
}

async function writeMcpSessionTitleMetadata(params: Readonly<{
  client: HappyMcpSessionClient;
  title: string;
  metadataReason: string;
}>): Promise<boolean> {
  const engine = createSessionStateSyncEngine({
    capabilities: MCP_SESSION_STATE_CAPABILITIES,
    facet: null,
    metadataPort: {
      update: async (_sessionId, updater) => {
        await Promise.resolve(params.client.updateMetadata((metadata) => updater(metadata) as Metadata));
        return { ok: true, version: 0 };
      },
    },
  });
  const result = await engine.writeHappierField({
    sessionId: params.client.sessionId,
    fieldId: 'display.title',
    value: {
      title: params.title,
      staleBehavior: 'bump-if-value-changed',
    },
    reason: 'user-mutation',
    metadataReason: params.metadataReason,
    mirrorToProvider: false,
  });
  return result.ok;
}

export function createHappierMcpServer(
  client: HappyMcpSessionClient,
  opts?: Readonly<{
    /** Session transport authentication; does not grant Account-wide Action authority. */
    sessionCredentials?: StoredCredentials | null;
    /** Account-scoped Action authority. Existing callers default this from credentials. */
    credentials?: StoredCredentials | null;
    authorityScope?: 'account' | 'session';
    sessionList?: ActionExecutorDeps['sessionList'];
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    accountSettings?: AccountSettings | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
    /** Exact caller-owned registry lease for daemonless scoped runtimes. */
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
    requiredDirectActionIds?: readonly ActionId[];
    sessionInputVia?: 'action' | 'mcp';
  }>,
): {
  mcp: McpServer;
  toolNames: string[];
  executeTool(request: Readonly<{
    toolName: string;
    args: unknown;
    toolCallId?: string;
  }>): Promise<HappierBuiltInToolDispatchResult>;
} {
  // This server is the per-session MCP bridge that a running session agent uses.
  // It must use the `agent` surface so action enablement + approvals can be
  // configured separately from the external MCP surface (`mcp`).
  const toolSurface = 'agent' as const;
  const credentials = opts?.authorityScope === 'session' ? null : opts?.credentials ?? null;
  const sessionCredentials = opts?.sessionCredentials ?? opts?.credentials ?? null;
  const { serverId, serverUrl: serverHttpBaseUrl } = client.getServerBinding();
  const serverFeaturesSnapshot = client.getServerFeaturesSnapshot?.();
  const serverIdentityId = serverFeaturesSnapshot?.status === 'ready'
    ? normalizeServerIdentityIdCapability(
        serverFeaturesSnapshot.features.capabilities.serverIdentity?.serverIdentityId,
      ) ?? null
    : null;
  const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: opts?.accountSettings ?? null,
    getAccountSettings: opts?.getAccountSettings ?? null,
    scopeKey: credentials
      ? resolveAccountSettingsScopeKeyForToken(credentials.token)
      : null,
  });
  const readActionsSettings = () => actionSettingsProvider.getActionsSettings();
  const readSessionAgentSpawnPolicyV1 = () =>
    actionSettingsProvider.getAccountSettings?.()?.sessionAgentSpawnPolicyV1;
  const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
    actionSettingsProvider,
    surface: toolSurface,
    hasAuthenticatedRuntime: sessionCredentials !== null,
    authorityScope: opts?.authorityScope,
    readServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.(),
  });
  const isActionApprovalRequired = createMcpActionApprovalRequirement({
    actionSettingsProvider,
    surface: toolSurface,
  });
  const ctx = sessionCredentials
    ? resolveSessionEncryptionContextFromCredentials(sessionCredentials)
    : null;
  const cryptoContext = ctx
    ? { mode: 'e2ee' as const, ctx }
    : { mode: 'plain' as const, ctx: null };
  // Board and Discussions are Session-placed owners. They need this Session's
  // transport credentials and its stored-content material, not Account
  // authority: a Session-scoped runtime (a Runner) holds no Account
  // credentials, and its live Session client is the only holder of the key.
  // The material answers for the bound Session only, so another Session keeps
  // the credential resolution, which fails closed without Account material.
  const sessionContentCredentials = credentials ?? sessionCredentials;
  const resolveExactSessionEncryptionMaterial = (
    requestedSessionId: string,
  ): SessionTransportEncryptionMaterial | null => {
    if (requestedSessionId !== client.sessionId) return null;
    const stored = client.getStoredContentEncryptionContext?.();
    if (!stored) return null;
    if (stored.mode === 'plain') return { mode: 'plain' };
    return stored.ctx?.encryptionVariant === 'dataKey'
      ? { mode: 'e2ee', dataEncryptionKey: stored.ctx.encryptionKey }
      : null;
  };
  const sessionContentOwnerOptions = sessionContentCredentials
    ? {
        credentials: sessionContentCredentials,
        resolveExactSessionEncryptionMaterial,
        serverId,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        serverHttpBaseUrl,
        ...(client.getServerFeaturesSnapshot
          ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
          : {}),
      }
    : null;

  const mcp = new McpServer({
    name: 'Happier MCP',
    version: '1.0.0',
  }, { capabilities: { resources: { subscribe: true } } });

  // Only the host-only Action-context arm supplies options; every other method
  // keeps the plain two-argument local invocation it has always used rather than
  // widening the call with an absent third argument.
  const sessionScopedRpc = async (
    method: string,
    params: unknown,
    options?: Parameters<HappyMcpSessionClient['rpcHandlerManager']['invokeLocal']>[2],
  ) => await (options === undefined
    ? client.rpcHandlerManager.invokeLocal(method, params)
    : client.rpcHandlerManager.invokeLocal(method, params, options));
  const resolveAgentCallerPermissionMode = () => resolveLiveClientPermissionMode(client)
    ?? resolvePermissionIntentFromMetadataSnapshot({
      metadata: client.getMetadataSnapshot?.() ?? null,
    })?.intent
    ?? null;
  const sessionMetadataSnapshot = client.getMetadataSnapshot?.() ?? null;
  const sessionLocation = resolveLiveClientLocation(client);
  const rawSession = sessionMetadataSnapshot || sessionLocation
    ? {
        ...(sessionMetadataSnapshot ? { metadata: sessionMetadataSnapshot } : {}),
        ...(typeof sessionLocation?.path === 'string' ? { path: sessionLocation.path } : {}),
        ...(typeof sessionLocation?.host === 'string' ? { host: sessionLocation.host } : {}),
        ...(typeof sessionLocation?.machineId === 'string' ? { machineId: sessionLocation.machineId } : {}),
      }
    : null;
  const executionRuns = {
    start: async (
      request: unknown,
      localActionContext?: RpcLocalActionContext,
    ) =>
      normalizeExecutionRunRpcPayload(
        await (localActionContext
          ? sessionScopedRpc('execution.run.start', request, { localActionContext })
          : client.executionRuns?.start?.(request) ?? sessionScopedRpc('execution.run.start', request)),
      ),
    list: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.list?.(request) ?? sessionScopedRpc('execution.run.list', request)),
      ),
    get: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.get?.(request) ?? sessionScopedRpc('execution.run.get', request)),
      ),
    stop: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.stop?.(request) ?? sessionScopedRpc('execution.run.stop', request)),
      ),
    action: async (request: unknown) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.action?.(request) ?? sessionScopedRpc('execution.run.action', request)),
      ),
    wait: async (request: unknown, signal?: AbortSignal) =>
      normalizeExecutionRunRpcPayload(
        await (client.executionRuns?.wait?.(request, signal ? { signal } : undefined)
          ?? sessionScopedRpc('execution.run.wait', request, signal ? { signal } : undefined)),
      ),
  };
  const executionRunScopeMismatch = () => ({
    ok: false as const,
    errorCode: 'execution_run_scope_mismatch' as const,
    error: 'The session-bound MCP bridge cannot operate on a different or detached execution-run scope',
  });
  const runForBoundSession = async <T>(
    requestedSessionId: string | null,
    operation: () => Promise<T>,
  ): Promise<T | ReturnType<typeof executionRunScopeMismatch>> => {
    if (requestedSessionId !== client.sessionId) return executionRunScopeMismatch();
    return await operation();
  };
  const executionRunStartRpc = async (
    sessionId: string | null,
    request: unknown,
    actionOptions?: Parameters<ActionExecutorDeps['executionRunStart']>[2],
  ) => {
    const hasCausalPermissionAuthority = Boolean(
      actionOptions
      && Object.prototype.hasOwnProperty.call(actionOptions, 'causalPermissionAuthority'),
    );
    return await runForBoundSession(
      sessionId,
      async () => await executionRuns.start(
        request,
        hasCausalPermissionAuthority || actionOptions?.workDepth !== undefined || actionOptions?.workspaceWrites !== undefined
          ? {
              surface: toolSurface,
              callerPermissionMode: resolveAgentCallerPermissionMode(),
              causalPermissionAuthority: actionOptions?.causalPermissionAuthority ?? null,
              ...(actionOptions?.agentStartContext ? { agentStartContext: actionOptions.agentStartContext } : {}),
              ...(actionOptions?.workDepth !== undefined ? { agentStartWorkDepth: actionOptions.workDepth } : {}),
              ...(actionOptions?.workspaceWrites !== undefined ? { agentStartWorkspaceWrites: actionOptions.workspaceWrites } : {}),
              ...(actionOptions?.sessionAgentSpawnPolicyV1 !== undefined ? { sessionAgentSpawnPolicyV1: actionOptions.sessionAgentSpawnPolicyV1 } : {}),
            }
          : undefined,
      ),
    );
  };

  const machineAdmissionTransport = client.getMachineAdmissionTransport?.();
  const harness = createCliActionExecutorHarness(
    {
      actionsSettingsProvider: actionSettingsProvider,
      token: sessionCredentials?.token ?? '',
      ...(credentials ? { credentials } : {}),
      sessionId: client.sessionId,
      ...(client.enqueueSessionEventCommitted ? {
        publishWorkerReport: (report: SessionWorkerPublishInputV1) => client.enqueueSessionEventCommitted!({ type: 'worker-report', ...report }),
      } : {}),
      ...cryptoContext,
      rawSession,
      getCurrentSessionBackendTarget: () => resolveLiveClientBackendTarget(client),
      getCurrentSessionMetadata: () => client.getMetadataSnapshot?.() ?? null,
      ...(client.getCurrentResolvedRoles ? { getCurrentResolvedRoles: () => client.getCurrentResolvedRoles!() } : {}),
      ...(client.readRoleSources ? { readRoleSources: (signal) => client.readRoleSources!(signal) } : {}),
      ...(client.getCurrentWorkspaceWrites ? { getCurrentWorkspaceWrites: () => client.getCurrentWorkspaceWrites!() } : {}),
      ...(client.prepareWorkspaceWritesPolicy ? { prepareWorkspaceWritesPolicy: (workspaceWrites, context) => client.prepareWorkspaceWritesPolicy!(workspaceWrites, context) } : {}),
      ...(client.enqueueRegisteredSessionStateFieldMutation ? {
        stageSessionStateMutation: async (mutation) => { await client.enqueueRegisteredSessionStateFieldMutation!(mutation); },
      } : {}),
      getCurrentSessionWorkDepth: () => client.getWorkDepth?.(),
      ...(client.getAgentStartRunCaller ? { getAgentStartRunCaller: () => client.getAgentStartRunCaller!() } : {}),
      // U6 owns the exact active SessionTurn facts; read by witness identity, never mutable metadata.
      getCurrentTurnWorkDepth: (expectedTurnId) => {
        const witness = resolveLiveClientActiveTurnPermissionWitness(client);
        if (witness && typeof witness === 'object' && 'turnId' in witness && typeof witness.turnId === 'string') {
          if (expectedTurnId !== undefined && witness.turnId !== expectedTurnId) return undefined;
          const depth = client.getHostTurnWorkDepth?.(witness.turnId);
          if (depth !== undefined) return depth;
        } else if (expectedTurnId !== undefined) return undefined;
        return witness && typeof witness === 'object' && 'workDepth' in witness && typeof witness.workDepth === 'number'
          ? witness.workDepth : undefined;
      },
      serverId,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      serverHttpBaseUrl,
      ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}),
      ...(client.getServerFeaturesSnapshot
        ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
        : {}),
    },
    {
      invokeContributedAction: async (request) => localExecutor.invokeContributedAction(request),
      ...(credentials
        ? {
            ...createAccountServerActionDeps({
              token: credentials.token,
              credentials,
              isCredentialCurrent: async () => sameStoredCredentials(
                credentials,
                await readStoredCredentialsForServerId(serverId).catch(() => null),
              ),
              serverId,
              serverHttpBaseUrl,
              ...(serverIdentityId ? { serverIdentityId } : {}),
              ...(client.getServerFeaturesSnapshot
                ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
                : {}),
            }),
            ...createSessionFollowActionDeps({
              token: credentials.token,
              serverId,
              serverHttpBaseUrl,
              ...(serverIdentityId ? { serverIdentityId } : {}),
              prepareSourceKeyAfterSet: createSessionFollowSourceKeyPreparationAfterSet({
                credentials,
                serverHttpBaseUrl,
                ...(serverIdentityId ? { serverIdentityId } : {}),
                ...(client.getServerFeaturesSnapshot
                  ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
                  : {}),
              }),
            }),
          }
        : {}),
      sessionActionConfirmation: async (request) => {
        if (!client.confirmSessionAction) return null;
        if (client.getSessionActionConfirmationBinding) {
          return await client.confirmSessionAction(request, client.getSessionActionConfirmationBinding());
        }
        const witness = client.getActiveTurnPermissionWitness?.();
        const lifetimeSignal = client.getRuntimeLifetimeSignal?.();
        return await client.confirmSessionAction(request, witness && lifetimeSignal ? {
          turnId: witness.turnId,
          lifetimeSignal,
          isCurrent: () => client.getRuntimeLifetimeSignal?.() === lifetimeSignal
            && client.getActiveTurnPermissionWitness?.()?.turnId === witness.turnId,
        } : null);
      },
      ...(sessionContentOwnerOptions
        ? createSessionBoardActionDeps(sessionContentOwnerOptions)
        : {}),
      ...(sessionContentOwnerOptions
        ? createSessionDiscussionActionDeps({
            ...sessionContentOwnerOptions,
            ...(client.postAgentDiscussionMessage
              ? {
                  postAgentMessage: async (request, options) => await client.postAgentDiscussionMessage!(
                    {
                      discussionId: request.discussionId,
                      request: request.request,
                      ...(request.runId ? { runId: request.runId } : {}),
                      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
                    },
                    options,
                  ),
                }
              : {}),
          })
        : {}),
      sessionTitleSet: async ({ sessionId, title }) => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        const normalizedTitle = String(title ?? '').trim();
        if (!normalizedTitle) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        if (normalizedSessionId !== client.sessionId) {
          return { ok: false as const, errorCode: 'not_authenticated' as const, error: 'not_authenticated' as const };
        }

        try {
          const ok = await writeMcpSessionTitleMetadata({
            client,
            title: normalizedTitle,
            metadataReason: 'mcp-session-title-set',
          });
          if (!ok) {
            return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
          }
        } catch (error) {
          logger.debug('[mcp] Failed to update title metadata via session-scoped bridge', {
            sessionId: normalizedSessionId,
            error,
          });
          return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
        }

        return {
          ok: true as const,
          sessionId: normalizedSessionId,
          title: normalizedTitle,
          metadataUpdated: true as const,
        };
      },
      executionRunStart: executionRunStartRpc,
      executionRunList: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.list(request)),
      executionRunGet: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.get(request)),
      executionRunStop: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.stop(request)),
      executionRunAction: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.action(request)),
      executionRunWait: async (sessionId, request, options) => await runForBoundSession(sessionId, async () => await executionRuns.wait(request, options?.signal)),

      ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),

      ...(credentials
        ? {}
        : {
          // Compatibility MCP clients without Account credentials can only reach
          // the daemon already bound to their session. Authenticated callers keep
          // the canonical machine-aware dependencies from createCliActionDeps.
          daemonMemorySearch: async ({ query, signal }): Promise<MemorySearchResultV1> => {
            const res = await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_SEARCH, query);
            signal?.throwIfAborted();
            const result = MemorySearchResultV1Schema.parse(res);
            return result.ok
              ? {
                  ...result,
                  hits: result.hits.filter((hit) => isSessionBoundMemoryTarget({
                    boundSessionId: client.sessionId,
                    requestedSessionId: hit.sessionId,
                  })),
                }
              : result;
          },
          daemonMemoryGetWindow: async ({ sessionId, seqFrom, seqTo }): Promise<MemoryWindowV1> => {
            if (!isSessionBoundMemoryTarget({
              boundSessionId: client.sessionId,
              requestedSessionId: sessionId,
            })) {
              throw Object.assign(
                new Error('Memory window access is limited to the MCP-bound Session'),
                { code: 'not_authenticated' as const },
              );
            }
            const res = await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_GET_WINDOW, { v: 1, sessionId, seqFrom, seqTo });
            return MemoryWindowV1Schema.parse(res);
          },
          daemonMemoryEnsureUpToDate: async ({ sessionId }) =>
            await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_ENSURE_UP_TO_DATE, sessionId ? { sessionId } : {}),
        }),

      promptRegistryInstall: async (args) => {
        if (!args.installTarget) {
          return { ok: false as const, errorCode: 'invalid_request' as const, error: 'installTarget is required' };
        }

        const request = PromptRegistryInstallRequestV1Schema.parse({
          sourceId: args.sourceId,
          itemId: args.itemId,
          configuredSources: args.configuredSources ?? [],
          installTarget: args.installTarget,
        });
        const res = await sessionScopedRpc(RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL, request);
        return PromptRegistryInstallResponseV1Schema.parse(res);
      },

      resetGlobalVoiceAgent: async () => {},
      isActionEnabled: (id) => isActionEnabled(id),
      isActionApprovalRequired: (id) => isActionApprovalRequired(id),
    },
  );

  const scopedPluginRuntimeRegistryLease = opts?.pluginRuntimeRegistryLease;
  const boundCallerSessionId = client.sessionId.trim();
  const localExecutor = scopedPluginRuntimeRegistryLease
    ? createPluginActionExecutor({
        base: harness.executor,
        ...(boundCallerSessionId ? { startedBy: 'agent' as const } : {}),
        requestPluginActionExecution: async (request, options) => await executeContributedAction({
          runtimeRegistry: scopedPluginRuntimeRegistryLease.registry,
          actionId: request.actionId,
          input: request.input,
          actionsSettings: actionSettingsProvider.getActionsSettings(),
          ...(request.expectedContributorOccurrenceId
            ? { expectedContributorOccurrenceId: request.expectedContributorOccurrenceId }
            : {}),
          context: {
            surface: request.surface,
            ...(request.startedBy ? { startedBy: request.startedBy } : {}),
            ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
          },
        }),
      })
    : createDaemonPluginActionExecutor({ base: harness.executor,
        ...(boundCallerSessionId ? { startedBy: 'agent' } : {}),
      });
  const executor = createSessionAccountActionExecutor({ base: localExecutor, client });

  const actionToolBridge = createActionToolExecutorBridge({
    executor,
    resolveSessionListAccess: () => credentials ? 'led_subtree' : 'current_session',
    isActionEnabled: (id) => {
      const spec = getActionSpec(id as any);
      return isActionSpecSurfacedOn(spec, toolSurface) && isActionEnabled(id as any);
    },
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    resolveCallerPermissionMode: resolveAgentCallerPermissionMode,
    resolveActiveTurnPermissionWitness: () => resolveLiveClientActiveTurnPermissionWitness(client),
    resolveReviewCommentActor: () => {
      const target = resolveLiveClientBackendTarget(client);
      return target ? { kind: 'agent', agentId: resolveExecutionRunPublicBackendId(target), sessionId: client.sessionId } : null;
    },
    sessionInputVia: opts?.sessionInputVia ?? 'mcp',
    sessionAgentSpawnPolicyV1: readSessionAgentSpawnPolicyV1(),
    getSessionAgentSpawnPolicyV1: readSessionAgentSpawnPolicyV1,
    resolveRuntimeRunId: () => {
      const caller = client.getAgentStartRunCaller?.();
      return caller && 'callingRunId' in caller ? caller.callingRunId : client.getSessionActionConfirmationBinding?.()?.run?.runId;
    },
    pluginToolCatalog: opts?.pluginToolCatalog,
    requiredDirectActionIds: opts?.requiredDirectActionIds,
    defaultSessionMachineId: sessionLocation?.machineId ?? null,
  });

  registerHappierMcpResources(mcp, {
    surface: toolSurface,
    isActionEnabled,
    watch: { server: mcp, execute: actionToolBridge.executeActionByToolName,
      defaultSessionId: client.sessionId, isEnabled: () => isActionEnabled('wait') },
  });

  const toolDeps = {
    changeTitle: createChangeTitleToolHandler({
      executor,
      surface: toolSurface,
    }),
    executeActionByToolName: actionToolBridge.executeActionByToolName,
    resolveActionOptions: (args: Parameters<typeof actionToolBridge.resolveActionOptions>[0]) =>
      actionToolBridge.resolveActionOptions(args, client.sessionId),
    isActionEnabled: actionToolBridge.isActionEnabled,
  };
  const { toolNames } = registerHappierMcpBuiltInTools(mcp as any, {
    sessionId: client.sessionId,
    workingDirectory: sessionLocation?.path,
    sessionMachineId: sessionLocation?.machineId ?? null,
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    pluginToolCatalog: opts?.pluginToolCatalog,
    requiredDirectActionIds: opts?.requiredDirectActionIds,
    deps: toolDeps,
  });

  return {
    mcp,
    toolNames: [...toolNames, 'watch'],
    executeTool: async (request) => await dispatchBuiltInHappierTool({
      toolName: request.toolName,
      args: request.args,
      sessionId: client.sessionId,
      sessionMachineId: sessionLocation?.machineId ?? null,
      surface: toolSurface,
      actionsSettings: readActionsSettings(),
      getActionsSettings: readActionsSettings,
      pluginToolCatalog: opts?.pluginToolCatalog,
      requiredDirectActionIds: opts?.requiredDirectActionIds,
      ...(request.toolCallId
        ? {
            approvalOrigin: {
              kind: 'transcript_tool_call' as const,
              sessionId: client.sessionId,
              toolCallId: request.toolCallId,
              toolName: request.toolName,
            },
          }
        : {}),
      deps: toolDeps,
    }),
  };
}
