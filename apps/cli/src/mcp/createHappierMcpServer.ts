import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { prepareActiveDiscussionAgentPublication } from '@/discussions/discussionAgentPublisher';
import { DiscussionAgentPublisherResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import type { SessionUpdatePostInputV1 } from '@happier-dev/protocol';

import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { logger } from '@/ui/logger';
import type { Metadata } from '@/api/types';
import type { RpcLocalActionContext } from '@/api/rpc/types';

import { listHappierMcpToolNames, registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { cacheMcpToolList } from '@/mcp/server/cacheMcpToolList';
import type { HappierBuiltInToolDispatchResult } from '@/agent/tools/happierTools/types';
import { normalizeExecutionRunRpcPayload } from '@/session/services/executionRuns';
import { registerHappierMcpBuiltInTools, type HappierMcpToolInventory } from '@/mcp/server/registerHappierMcpBuiltInTools';
import {
  readStoredCredentialsForServerId,
  sameStoredCredentials,
  type StoredCredentials,
} from '@/persistence';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
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
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import type { ActionId, AccountSettings, ActionExecutorContext, ActionExecutorDeps, BackendTargetRefV2 } from '@happier-dev/protocol';
import { getActionSpec, isActionSpecSurfacedOn, PUBLIC_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';
import { readServerIdentityIdFromFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isMemorySessionSearchHitV1, negotiateMemorySearchV1 } from '@happier-dev/protocol/memory/memorySearch';
import { MemoryWindowV1Schema } from '@happier-dev/protocol/memory/memoryWindow';
import type { MemorySearchResultV1, MemoryWindowV1, SessionStateCapabilitiesV1 } from '@happier-dev/protocol';
import { createSessionStateSyncEngine } from '@happier-dev/agents';
import {
  createMcpActionApprovalRequirement,
  createMcpActionEnablementWithServerFeatureAvailability,
  createMcpActionSettingsProvider,
} from '@/mcp/server/createMcpActionEnablement';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { RuntimeActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { isSessionBoundMemoryTarget } from '@/mcp/sessionBoundMemoryTarget';
import { createSessionBoardActionDeps } from '@/session/board/sessionBoardActionDeps';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createSessionFollowActionDeps } from '@/api/sessionFollowActionDeps';
import { createSessionFollowSourceKeyPreparationAfterSet } from '@/agent/runtime/session/follow/createSessionFollowSourceKeyPreparationAfterSet';
import { createSessionAccountActionExecutor } from '@/mcp/runtime/createSessionAccountActionExecutor';
import { readCurrentRunnerAgentStartPolicyV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { createNativeAgentSessionEffectBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { readSessionMemoryEnabledV1 } from '@happier-dev/protocol/sessions/context/sessionContextV1';

const MCP_SESSION_STATE_CAPABILITIES: SessionStateCapabilitiesV1 = {
  display: {
    title: {
      supported: true,
      happierToProvider: { supported: false },
      providerToHappier: { supported: false },
    },
    bot: { supported: true, happierToProvider: { supported: false }, providerToHappier: { supported: false } },
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

function resolveLiveClientTurnWorkDepth(client: HappyMcpSessionClient, expectedTurnId?: string): number | undefined {
  const witness = resolveLiveClientActiveTurnPermissionWitness(client);
  if (witness && typeof witness === 'object' && 'turnId' in witness && typeof witness.turnId === 'string') {
    if (expectedTurnId !== undefined && witness.turnId !== expectedTurnId) return undefined;
    const depth = client.getHostTurnWorkDepth?.(witness.turnId);
    if (depth !== undefined) return depth;
  } else if (expectedTurnId !== undefined) return undefined;
  return witness && typeof witness === 'object' && 'workDepth' in witness && typeof witness.workDepth === 'number'
    ? witness.workDepth : undefined;
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

async function writeMcpSessionStateFieldMetadata(params: Readonly<{
  client: HappyMcpSessionClient;
  write: Parameters<NonNullable<ActionExecutorDeps['sessionStateFieldSet']>>[0];
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
    fieldId: params.write.fieldId,
    value: params.write.fieldId === 'display.title'
      ? { title: params.write.value, staleBehavior: 'bump-if-value-changed' }
      : params.write.value,
    reason: 'user-mutation',
    metadataReason: params.metadataReason,
    mirrorToProvider: false,
  });
  return result.ok;
}

export function createHappierMcpServer(
  client: HappyMcpSessionClient,
  opts?: Readonly<{
    mcpToolCallIdMetaKey?: string;
    /** Session transport authentication; does not grant Account-wide Action authority. */
    sessionCredentials?: StoredCredentials | null;
    /** Account-scoped Action authority. Existing callers default this from credentials. */
    credentials?: StoredCredentials | null;
    /** Currentness of the admitted Account custody, including requester Sessions. */
    isCredentialCurrent?: () => boolean | Promise<boolean>;
    authorityScope?: 'account' | 'session';
    sessionList?: ActionExecutorDeps['sessionList'];
    actionsSettingsProvider?: RuntimeActionSettingsProvider;
    accountSettings?: AccountSettings | null;
    getAccountSettings?: (() => AccountSettings | null) | null;
    pluginToolCatalog?: readonly ProjectedPluginToolCatalogEntry[];
    /** Exact caller-owned registry lease for daemonless scoped runtimes. */
    pluginRuntimeRegistryLease?: PluginRuntimeRegistryLease;
    requiredDirectActionIds?: readonly ActionId[];
    toolInventory?: HappierMcpToolInventory;
    sessionInputVia?: 'action' | 'mcp';
    /** Captured containing host/request scope, independent of the Session runtime lifetime. */
    toolExecutionSignal?: AbortSignal;
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
  const isCredentialCurrent = async () => credentials !== null && (opts?.isCredentialCurrent
    ? await opts.isCredentialCurrent()
    : sameStoredCredentials(credentials, await readStoredCredentialsForServerId(serverId).catch(() => null)));
  const serverFeaturesSnapshot = client.getServerFeaturesSnapshot?.();
  const serverIdentityId = readServerIdentityIdFromFeaturesSnapshot(serverFeaturesSnapshot) ?? null;
  const actionSettingsProvider = opts?.actionsSettingsProvider ?? createMcpActionSettingsProvider({
    accountSettings: opts?.accountSettings ?? null,
    getAccountSettings: opts?.getAccountSettings ?? null,
    credentials,
    sessionCredentials,
  });
  const readActionsSettings = () => actionSettingsProvider.getActionsSettings();
  const readSessionAgentSpawnPolicyV1 = async (signal?: AbortSignal) => {
    if (credentials) return actionSettingsProvider.getAccountSettings?.()?.sessionAgentSpawnPolicyV1;
    const policy = await readCurrentRunnerAgentStartPolicyV1(client.sessionId, toolExecutionSignal
      ? signal ? AbortSignal.any([toolExecutionSignal, signal]) : toolExecutionSignal : signal);
    if (!policy) throw createNativeAgentSessionEffectBoundaryError('authority_unavailable_before_effect');
    return policy.sessionAgentSpawnPolicyV1;
  };
  const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
    actionSettingsProvider,
    surface: toolSurface,
    hasAuthenticatedRuntime: sessionCredentials !== null,
    authorityScope: opts?.authorityScope,
    readSessionMemoryEnabled: () => readSessionMemoryEnabledV1(client.getMetadataSnapshot?.()),
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
  // The Board is Session-placed. It needs this Session's
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
  cacheMcpToolList(mcp);

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
        { executionRunStart: true },
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
      // Wait already returns the canonical observation union. Generic service
      // normalization strips its `ok` discriminant and loses a completed result.
      await (client.executionRuns?.wait?.(request, signal ? { signal } : undefined)
        ?? sessionScopedRpc('execution.run.wait', request, signal ? { signal } : undefined)),
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
    actionOptions?: Parameters<NonNullable<ActionExecutorDeps['executionRunStart']>>[2],
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
  const { projectWorkerAction: projectWorkerAccountAction, ...accountServerActionPorts } = credentials
    ? createAccountServerActionDeps({
        token: credentials.token,
        credentials,
        isCredentialCurrent,
        serverId,
        serverHttpBaseUrl,
        ...(serverIdentityId ? { serverIdentityId } : {}),
        ...(client.getServerFeaturesSnapshot
          ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
          : {}),
      })
    : {};
  const harness = createCliActionExecutorHarness(
    {
      actionsSettingsProvider: actionSettingsProvider,
      ...(!credentials ? { readAgentStartPolicy: (signal?: AbortSignal) =>
        readCurrentRunnerAgentStartPolicyV1(client.sessionId, signal) } : {}),
      token: sessionCredentials?.token ?? '',
      ...(credentials ? { credentials } : {}),
      sessionId: client.sessionId,
      ...(client.postAgentDiscussionMessage ? {
        postAgentDiscussionMessage: async (request, options) => {
          if (request.sessionId !== client.sessionId) return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const };
          if (options?.approvedActionReplay) return DiscussionAgentPublisherResponseV1Schema.parse(await sessionScopedRpc(
            SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1, { request, approvedActionReplay: options.approvedActionReplay },
            options.signal ? { signal: options.signal } : undefined));
          const publication = prepareActiveDiscussionAgentPublication({ session: client,
            serverIdentityId: readServerIdentityIdFromFeaturesSnapshot(client.getServerFeaturesSnapshot?.()), request });
          if (!publication) return { v: 1 as const, ok: false as const, error: 'discussion_post_denied' as const };
          return await client.postAgentDiscussionMessage!(publication, options);
        },
      } : {}),
      ...(client.mutateSessionMessageReply && client.publishSessionMessageReply ? {
        sessionMessageReplyPublisher: {
          sessionId: client.sessionId,
          mutateSessionMessageReply: (input, options) => client.mutateSessionMessageReply!(input, options),
          publishSessionMessageReply: (input, options) => client.publishSessionMessageReply!(input, options),
        },
      } : {}),
      invokeBoundSessionRpc: async (method, input, signal, origin) => await sessionScopedRpc(
        method,
        input,
        signal || origin ? {
          ...(signal ? { signal } : {}),
          ...(origin ? { rpcContext: { callerAuthority: 'account_automation' as const, sessionActionOrigin: origin } } : {}),
        } : undefined,
      ),
      ...(client.enqueueSessionEventCommitted ? {
        postSessionUpdate: (report: SessionUpdatePostInputV1) => client.enqueueSessionEventCommitted!({ type: 'worker-report', ...report }),
      } : {}),
      ...cryptoContext,
      rawSession,
      getCurrentSessionBackendTarget: () => resolveLiveClientBackendTarget(client),
      getCurrentSessionMetadata: () => client.getMetadataSnapshot?.() ?? null,
      ...(client.getSessionRoleContext ? { getSessionRoleContext: () => client.getSessionRoleContext!() } : {}),
      ...(client.getCurrentSessionSkillItems ? { getCurrentSessionSkillItems: () => client.getCurrentSessionSkillItems!() } : {}),
      ...(client.getCurrentResolvedRoles ? { getCurrentResolvedRoles: () => client.getCurrentResolvedRoles!() } : {}),
      ...(client.readRoleSources ? { readRoleSources: (signal, options) => client.readRoleSources!(signal, options) } : {}),
      ...(client.getCurrentWorkspaceWrites ? { getCurrentWorkspaceWrites: () => client.getCurrentWorkspaceWrites!() } : {}),
      ...(client.prepareWorkspaceWritesPolicy ? { prepareWorkspaceWritesPolicy: (workspaceWrites, context) => client.prepareWorkspaceWritesPolicy!(workspaceWrites, context) } : {}),
      ...(client.enqueueRegisteredSessionStateFieldMutation ? {
        stageWorkStateMutation: async (mutation) => { await client.enqueueRegisteredSessionStateFieldMutation!(mutation); },
        stageSessionStateMutation: async (mutation) => { await client.enqueueRegisteredSessionStateFieldMutation!(mutation); },
      } : {}),
      getCurrentSessionWorkDepth: () => client.getWorkDepth?.(),
      ...(client.getAgentStartRunCaller ? { getAgentStartRunCaller: () => client.getAgentStartRunCaller!() } : {}),
      // U6 owns the exact active SessionTurn facts; read by witness identity, never mutable metadata.
      getCurrentTurnWorkDepth: (expectedTurnId) => resolveLiveClientTurnWorkDepth(client, expectedTurnId),
      serverId,
      ...(serverIdentityId ? { serverIdentityId } : {}),
      serverHttpBaseUrl,
      ...(machineAdmissionTransport ? { machineAdmissionTransport } : {}),
      ...(projectWorkerAccountAction ? { projectWorkerAccountAction } : {}),
      ...(client.getServerFeaturesSnapshot
        ? { resolveServerFeaturesSnapshot: () => client.getServerFeaturesSnapshot?.() }
        : {}),
    },
    {
      invokeContributedAction: async (request) => localExecutor.invokeContributedAction(request),
      ...(credentials
        ? {
            ...accountServerActionPorts,
            ...createSessionFollowActionDeps({
              token: credentials.token,
              credentials,
              isCredentialCurrent,
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
      sessionStateFieldSet: async (write) => {
        const { sessionId, value, fieldId } = write;
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        if (fieldId === 'display.title' && !value.trim()) {
          return { ok: false as const, errorCode: 'invalid_parameters' as const, error: 'invalid_parameters' as const };
        }
        if (normalizedSessionId !== client.sessionId) {
          return { ok: false as const, errorCode: 'not_authenticated' as const, error: 'not_authenticated' as const };
        }

        try {
          const ok = await writeMcpSessionStateFieldMetadata({
            client,
            write,
            metadataReason: `mcp-${write.actionId}`,
          });
          if (!ok) {
            return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
          }
        } catch (error) {
          logger.debug('[mcp] Failed to update registered metadata via session-scoped bridge', {
            sessionId: normalizedSessionId,
            error,
          });
          return { ok: false as const, errorCode: 'metadata_update_failed' as const, error: 'metadata_update_failed' as const };
        }

        return {
          ok: true as const,
          sessionId: normalizedSessionId,
          ...(fieldId === 'display.title' ? { title: value } : { bot: value }),
          metadataUpdated: true as const,
        };
      },
      executionRunStart: executionRunStartRpc,
      // Like the registered Run executor, this in-process adapter calls the
      // current V2 owner directly. Only remote transports need negotiation;
      // the Session runner has no daemon-local capability catalog to probe.
      executionRunCheckProtocolV2: async (sessionId) => await runForBoundSession(sessionId, async () => ({ ok: true as const })),
      executionRunList: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.list(request)),
      executionRunGet: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.get(request)),
      executionRunStop: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.stop(request)),
      executionRunAction: async (sessionId, request) => await runForBoundSession(sessionId, async () => await executionRuns.action(request)),
      executionRunWait: async (sessionId, request, options) => await runForBoundSession(sessionId, async () => await executionRuns.wait(request, options?.signal)),

      ...(opts?.sessionList ? { sessionList: opts.sessionList } : {}),

      ...(credentials
        ? {}
        : {
          // Admission reads the credentialed inventory through the same Session
          // capability as discovery. Run effects retain this host's bound RPC.
          agentsBackendsList: async (input) => {
            const outcome = await accountExecutor.execute('agents.backends.list', input, { surface: toolSurface });
            if (!outcome.ok) throw Object.assign(new Error(outcome.errorCode), { code: outcome.errorCode });
            return PUBLIC_ACTION_OUTPUT_SCHEMAS['agents.backends.list'].parse(outcome.result);
          },
          // Compatibility MCP clients without Account credentials can only reach
          // the daemon already bound to their session. Authenticated callers keep
          // the canonical machine-aware dependencies from createCliActionDeps.
          daemonMemorySearch: async ({ query, signal }): Promise<MemorySearchResultV1> => {
            const result = await negotiateMemorySearchV1({
              query,
              // This bridge has Session transport, not Account document-read authority.
              readDocumentSearchSupport: async () => false,
              readProjectSearchSupport: async () => false,
              search: async (request) => await sessionScopedRpc(RPC_METHODS.DAEMON_MEMORY_SEARCH, request),
              ...(signal ? { signal } : {}),
            });
            return result.ok
              ? {
                  ...result,
                  hits: result.hits.filter((hit) => isMemorySessionSearchHitV1(hit) && isSessionBoundMemoryTarget({
                    boundSessionId: client.sessionId,
                    requestedSessionId: hit.sessionId,
                  })),
                }
              : result;
          },
          daemonMemoryGetWindow: async (request): Promise<MemoryWindowV1> => {
            if (request.source !== undefined) throw Object.assign(
              new Error('Native memory windows require authenticated Machine access'), { code: 'not_authenticated' as const });
            const { sessionId, seqFrom, seqTo } = request;
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

      resetGlobalVoiceAgent: async () => {},
      isActionEnabled: (id) => isActionEnabled(id),
      isActionApprovalRequired: (id) => isActionApprovalRequired(id),
    },
  );

  const scopedPluginRuntimeRegistryLease = opts?.pluginRuntimeRegistryLease;
  const boundCallerSessionId = client.sessionId.trim();
  const getInitiatingActionCaller = () => {
    const caller = AgentStartSessionCallerV1Schema.safeParse({ kind: 'session', sessionId: boundCallerSessionId,
      starterDepth: client.getWorkDepth?.(), turnDepth: resolveLiveClientTurnWorkDepth(client) });
    return caller.success ? caller.data : null;
  };
  // Built-in Session effects and contributed Actions consume the same live
  // host caller. The plugin adapter alone stamps only its remote requests.
  const sessionActionExecutor = {
    execute: async (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => {
      const actionCaller = getInitiatingActionCaller();
      if (!actionCaller) return { ok: false as const, errorCode: 'target_unavailable', error: 'target_unavailable' };
      return await harness.executor.execute(actionId, input, { ...context, actionCaller });
    },
  };
  const executeInCurrentProcess: NonNullable<Parameters<typeof createDaemonPluginActionExecutor>[0]['executeInCurrentProcess']> =
    async (actionId, input, context) => credentials
      ? await executeAccountPluginAction({
          host: { ...cryptoContext, token: credentials.token, credentials, sessionId: client.sessionId,
            serverId, serverHttpBaseUrl, isCredentialCurrent },
          deps: harness.deps, actionId, input, ...(context ? { context } : {}),
        })
      : { matched: false };
  const localExecutor = scopedPluginRuntimeRegistryLease
    ? createPluginActionExecutor({
        base: sessionActionExecutor,
        executeInCurrentProcess,
        getInitiatingActionCaller,
        ...(boundCallerSessionId ? { startedBy: 'agent' as const } : {}),
        requestPluginActionExecution: async (request, options) => {
          const initiatingActionCaller = getInitiatingActionCaller();
          if (!initiatingActionCaller) return { matched: true, result: {
            ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
          } };
          return await executeContributedAction({
            runtimeRegistry: scopedPluginRuntimeRegistryLease.registry,
            actionId: request.actionId,
            input: request.input,
            actionsSettings: actionSettingsProvider.getActionsSettings(),
            ...(request.expectedContributorOccurrenceId
              ? { expectedContributorOccurrenceId: request.expectedContributorOccurrenceId }
              : {}),
            context: {
              surface: request.surface,
              // The client is bound by the Session host; request targets and surfaces do not establish provenance.
              initiatingActionCaller,
              ...(request.startedBy ? { startedBy: request.startedBy } : {}),
              ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
              ...(options?.signal ? { signal: options.signal } : {}),
            },
          });
        },
      })
    : createDaemonPluginActionExecutor({ base: sessionActionExecutor, executeInCurrentProcess,
        getInitiatingActionCaller,
        ...(boundCallerSessionId ? { startedBy: 'agent' } : {}),
      });
  const accountExecutor = createSessionAccountActionExecutor({ base: localExecutor, client, hasAccountAuthority: credentials !== null });
  const toolExecutionSignal = opts?.toolExecutionSignal ?? client.getHostTurnAbortSignal?.() ?? undefined;
  const executor = toolExecutionSignal ? {
    execute: (actionId: ActionId, input: unknown, context?: ActionExecutorContext) => accountExecutor.execute(actionId, input, {
      ...context,
      signal: context?.signal ? AbortSignal.any([toolExecutionSignal, context.signal]) : toolExecutionSignal,
    }),
  } : accountExecutor;

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
    // Action attribution belongs to the complete admitted input, not the
    // narrower permission/depth view. An installed full reader returning null
    // means no admitted turn; it must not fall back to a different witness.
    resolveActiveTurnPermissionWitness: () => client.getActiveTurnAdmissionWitness
      ? client.getActiveTurnAdmissionWitness()
      : resolveLiveClientActiveTurnPermissionWitness(client),
    resolveReviewCommentActor: () => {
      const target = resolveLiveClientBackendTarget(client);
      return target ? { kind: 'agent', agentId: resolveExecutionRunPublicBackendId(target), sessionId: client.sessionId } : null;
    },
    sessionInputVia: opts?.sessionInputVia ?? 'mcp',
    getSessionAgentSpawnPolicyV1: readSessionAgentSpawnPolicyV1,
    resolveRuntimeRunId: () => {
      const caller = client.getAgentStartRunCaller?.();
      return caller && 'callingRunId' in caller ? caller.callingRunId : client.getSessionActionConfirmationBinding?.()?.run?.runId;
    },
    pluginToolCatalog: opts?.pluginToolCatalog,
    requiredDirectActionIds: opts?.requiredDirectActionIds,
    actionToolNameToId: opts?.toolInventory?.actionToolNameToId,
    defaultSessionMachineId: sessionLocation?.machineId ?? null,
    defaultSessionRootPath: sessionLocation?.path ?? null,
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
  const { toolNames } = registerHappierMcpBuiltInTools(mcp, {
    mcpToolCallIdMetaKey: opts?.mcpToolCallIdMetaKey,
    sessionId: client.sessionId,
    workingDirectory: sessionLocation?.path,
    sessionMachineId: sessionLocation?.machineId ?? null,
    surface: toolSurface,
    actionsSettings: readActionsSettings(),
    getActionsSettings: readActionsSettings,
    pluginToolCatalog: opts?.pluginToolCatalog,
    requiredDirectActionIds: opts?.requiredDirectActionIds,
    toolInventory: opts?.toolInventory,
    deps: toolDeps,
  });

  return {
    mcp,
    toolNames: listHappierMcpToolNames(toolNames),
    executeTool: async (request) => await dispatchBuiltInHappierTool({
      toolName: request.toolName,
      args: request.args,
      sessionId: client.sessionId,
      sessionMachineId: sessionLocation?.machineId ?? null,
      sessionRootPath: sessionLocation?.path ?? null,
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
