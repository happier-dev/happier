import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { resolveSessionCapabilityItemIdentityV1, resolveSessionCapabilitiesGetFailureV1 } from '@happier-dev/protocol/actions/executor/sessionCapabilities';
import { SpawnCapabilitiesPreviewSuccessV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { readCapabilityLaunchRestartFromMetadataV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { readPendingCapabilityApplyV1, readCapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';
import type { SkillRulesActionPortV1 } from '@happier-dev/protocol/prompts/library/skillRulesActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import type { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import type { tryDecryptSessionOwnerMetadataView, readSessionOwnerLocality } from '@/session/transport/encryption/sessionEncryptionContext';
import type { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import type { findCatalogEntry } from '@/agent/catalog/registry';
import type { resolveCapabilityApplyAgentFacts } from '@/session/runtime/capabilityApplyFacts';
import type { readPluginMcpServerMetadata } from '@/mcp/runtime/pluginMcpServerItems';
import type { createCliMcpServerStore, createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

type CapabilityDeps = Pick<ActionExecutorDeps, 'sessionCapabilities' | 'sessionCapabilitiesGet' | 'spawnCapabilitiesPreview'>;

/** Account selection writes and exact-machine previews retain the invocation's captured Home. */
export function createCliSessionCapabilitiesActionDeps(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1; skillRules: SkillRulesActionPortV1;
  resolveAuthorizationHeaders: (actionId: 'session.capabilities.set' | 'session.capabilities.get', context: ActionExecutorContext, request: Readonly<{
    method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  callMachineAction: (input: Readonly<{ machineId: string; serverId?: string; method: string; request: unknown;
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true; signal?: AbortSignal;
    timeoutMs?: number | null }>) => Promise<unknown>;
}>): CapabilityDeps {
  const withinHome = <T>(run: () => Promise<T>) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run);
  const read = async (sessionId: string, context: ActionExecutorContext, actionId: 'session.capabilities.set' | 'session.capabilities.get' = 'session.capabilities.set') => {
    context.signal?.throwIfAborted();
    if (context.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId)) return null;
    const [{ resolveSessionTransportContext }, { tryDecryptSessionOwnerMetadataView }] = await Promise.all([import("@/session/services/resolveSessionTransportContext"), import("@/session/transport/encryption/sessionEncryptionContext")]);
    const transport = await withinHome(() => resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials, idOrPrefix: sessionId,
      resolveAuthorizationHeaders: request => params.resolveAuthorizationHeaders(actionId, context, request), signal: context.signal }));
    if (!transport.ok) {
      if (transport.code === 'session_not_found') return null;
      throw Object.assign(new Error(transport.code), { code: 'session_unavailable' });
    }
    if (transport.sessionId !== sessionId || transport.rawSession.id !== sessionId) return null;
    const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
      accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession });
    if (!metadata) throw Object.assign(new Error('Session metadata is unavailable'), { code: 'session_unavailable' });
    return { transport, metadata };
  };
  const preview = async (input: Parameters<NonNullable<ActionExecutorDeps['spawnCapabilitiesPreview']>>[0], context: ActionExecutorContext) => {
    context.signal?.throwIfAborted();
    try {
      const result = await params.callMachineAction({ machineId: input.machineId, serverId: context.serverId ?? params.serverId,
        method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, request: input, context,
        // Account/native inventory preparation belongs to the containing Action's lifetime.
        effectActionId: 'sessions.spawn.capabilities.preview', exactMachine: true, timeoutMs: null, signal: context.signal });
      const wire = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
      // A machine reply proves reachability; producer/preparation failures are not transport failures.
      if (wire.ok !== true) return { ok: false, reason: 'invalid_input' } as const;
      const output = SpawnCapabilitiesPreviewSuccessV1Schema.safeParse({ ok: true, machinePlatform: wire.machinePlatform,
        mcp: wire.mcp, skills: wire.skills, applyTiming: wire.applyTiming });
      return output.success ? output.data : { ok: false, reason: 'invalid_input' } as const;
    } catch (error) { context.signal?.throwIfAborted();
      return { ok: false, reason: isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error) ? 'invalid_input' : 'machine_unreachable' } as const;
    }
  };
  return {
    spawnCapabilitiesPreview: preview,
    sessionCapabilitiesGet: async (input, context) => {
      try {
        const session = await read(input.sessionId, context, 'session.capabilities.get');
        if (!session) return { ok: false, code: 'not_found' };
        const [{ readSessionOwnerLocality }, { resolveBackendTargetFromSessionMetadata }] = await Promise.all([import("@/session/transport/encryption/sessionEncryptionContext"), import("@/session/backendTargets/resolveBackendTargetFromSessionMetadata")]);
        const machineId = readSessionOwnerLocality({ metadata: session.metadata, rawSession: session.transport.rawSession })?.machineId;
        const agent = resolveBackendTargetFromSessionMetadata(session.metadata);
        if (!machineId || agent?.kind !== 'backend') return { ok: false, code: 'session_unavailable' };
        const wire = await params.callMachineAction({ machineId, serverId: context.serverId ?? params.serverId,
          method: RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW, request: { machineId, agentId: agent.backendId, sessionId: input.sessionId },
          context, effectActionId: 'session.capabilities.get', exactMachine: true, timeoutMs: null, signal: context.signal });
        const result = wire !== null && typeof wire === 'object' ? wire as Record<string, unknown> : {};
        if (result.ok !== true) return resolveSessionCapabilitiesGetFailureV1(result);
        const generic = SpawnCapabilitiesPreviewSuccessV1Schema.parse({ ok: true, machinePlatform: result.machinePlatform,
          mcp: result.mcp, skills: result.skills, applyTiming: result.applyTiming });
        const apply = readCapabilitySelectionApplyV1(session.metadata);
        const pendingApply = readPendingCapabilityApplyV1(session.metadata);
        const refusal = pendingApply.mcp ? apply.mcp : apply.skills;
        return { ok: true, mcp: { items: generic.mcp.items }, skills: generic.skills,
          pendingApply: { ...pendingApply, ...(refusal ? {
            reason: refusal.reason, ...(refusal.restartBy ? { restartBy: refusal.restartBy } : {}),
          } : {}) }, applyTiming: generic.applyTiming };
      } catch (error) { context.signal?.throwIfAborted(); return resolveSessionCapabilitiesGetFailureV1(error); }
    },
    sessionCapabilities: {
      readSession: async (input, context) => {
        const session = await read(input.sessionId, context);
        if (!session) return null;
        const [{ resolveBackendTargetFromSessionMetadata }, { findCatalogEntry }, { resolveCapabilityApplyAgentFacts }] = await Promise.all([import("@/session/backendTargets/resolveBackendTargetFromSessionMetadata"), import("@/agent/catalog/registry"), import("@/session/runtime/capabilityApplyFacts")]);
        const target = resolveBackendTargetFromSessionMetadata(session.metadata);
        if (target?.kind !== 'backend') throw Object.assign(new Error('Session Agent is unavailable'), { code: 'session_unavailable' });
        const entry = findCatalogEntry(target.backendId);
        if (!entry) throw Object.assign(new Error('Session Agent is unavailable'), { code: 'session_unavailable' });
        return { metadata: session.metadata,
          sessionRunning: session.transport.rawSession.active === true,
          agent: await resolveCapabilityApplyAgentFacts({ agentId: target.backendId, metadata: session.metadata,
            sessionRunning: session.transport.rawSession.active === true }),
          launchRestart: readCapabilityLaunchRestartFromMetadataV1(session.metadata) };
      },
      resolveItem: async (input, context) => withinHome(async () => {
        context.signal?.throwIfAborted();
        // Native overlay ids are desired exact names, so saving Off stays Account-only while the Machine is offline.
        if (input.kind === 'native_skill') return input.id;
        if (input.kind === 'skill') {
          // Opaque ids need only their addressed content. Names still require
          // the complete catalog to preserve duplicate-name refusal.
          const addressed = await params.skillRules.listSkills(context.signal, [input.id]).catch(() => {
            // A failed addressed read cannot replace the existing name-catalog
            // result or its available-only plugin-source semantics.
            context.signal?.throwIfAborted();
            return [];
          });
          if (addressed.some(item => item.id === input.id)) return input.id;
          return resolveSessionCapabilityItemIdentityV1(await params.skillRules.listSkills(context.signal), input.id);
        }
        if (!params.operationContext) {
          const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
          await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
        }
        const [{ readPluginMcpServerMetadata }, { createCliMcpServerStoreForOperation, createCliMcpServerStore }] = await Promise.all([import("@/mcp/runtime/pluginMcpServerItems"), import("@/settings/mcp/mcpServerStore")]);
        const store = params.operationContext ? createCliMcpServerStoreForOperation({ operationContext: params.operationContext,
          serverId: params.serverId, signal: context.signal }) : createCliMcpServerStore({ credentials: params.credentials,
          serverId: params.serverId, signal: context.signal });
        const catalog = await store.readCatalogForOperation();
        if (catalog.status !== 'ready') throw new Error('mcp_catalog_unavailable');
        return resolveSessionCapabilityItemIdentityV1([...catalog.catalog.servers, ...await readPluginMcpServerMetadata()], input.id);
      }),
      writeMetadata: async (input, context) => withinHome(async () => {
        let result;
        try { 
        const { updateSessionMetadataForTarget } = await import("@/session/services/updateSessionMetadataForTarget");
        result = await updateSessionMetadataForTarget({ credentials: params.credentials, idOrPrefix: input.sessionId,
          expectedSessionId: input.sessionId,
          currentness: { signal: context.signal },
          resolveAuthorizationHeaders: request => params.resolveAuthorizationHeaders('session.capabilities.set', context, request),
          updater: metadata => ({ ...input.update(metadata) }) }); }
        catch (error) { context.signal?.throwIfAborted();
          if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'conflict') return 'conflict';
          throw error;
        }
        if (!result.ok) { if (result.code === 'conflict') return 'conflict'; throw new Error(result.code); }
        return 'updated';
      }),
    },
  };
}
