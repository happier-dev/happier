import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
    WorkflowRunSummaryV1Schema, WorkflowRunStartRequestV1Schema,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
} from '@happier-dev/protocol';
import { createWorkflowAccountRunActionOwner, type WorkflowAccountRunActionDeps } from '@happier-dev/protocol/actions';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createHappierMcpServer } from '@/mcp/createHappierMcpServer';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from '@/plugins/runtime/invocation/services/production';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDaemonControlAuthGuard } from '@/daemon/controlAuth';
import { createDaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { executeAppliedDaemonPluginActionWithController, registerDaemonPluginChangeRoutes, PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import * as persistence from '@/persistence';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

function starterRuntime() {
    const pluginId = 'acme.starter';
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'starter-root' };
    const runId = '99999999-9999-4999-8999-999999999999';
    let acceptedEnvelope: string | undefined;
    const run = WorkflowRunSummaryV1Schema.parse({ id: runId, sourceArtifactId: null,
        attentionRequired: false, failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        ownerAccountId: 'account-1', visibleTeamId: null, origin: { kind: 'direct' }, state: 'queued', revision: 0,
        machineId: 'machine-1', workflowCustodyState: 'pending', originDeliveryAckRevision: null,
        availability: { pause: true, resumeBoundary: false, restoreWorkspace: false, cancel: true, inspectExecution: false, disabledReasons: [] },
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    const workflowDeps: WorkflowAccountRunActionDeps = {
        resolveAccountId: async () => 'account-1',
        storage: { execute: async operation => {
            if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
            if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
            acceptedEnvelope = String(operation.acceptedEnvelope);
            return { kind: 'created', run };
        } },
        definitions: { get: async () => { throw new Error('inline_definition_only'); } },
        resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
        normalizeAbsolutePath: directory => directory.startsWith('/') ? directory : null,
        randomBytes: () => { throw new Error('plain_account_does_not_need_keys'); },
        prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
        resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
        // The Account host's authenticated Session lookup is a system boundary; leaf admission itself stays real.
        resolveAgentStartContext: async context => context.defaultSessionId === 'session-origin' ? {
            caller: { kind: 'session', sessionId: 'session-origin', starterDepth: 0, turnDepth: 0 },
            baseline: { machineId: 'machine-1', directory: '/repo', configuration: { agentTarget, permissionMode: 'default' } },
            roles: {}, callerPermissionCeiling: 'default', ledSubtreeSessionIds: [], workDepthLimit: 4,
        } : null,
    };
    const owner = createWorkflowAccountRunActionOwner(workflowDeps);
    const services = createProductionPluginInvocationServiceOwners({
        invokeContributedAction: async () => { throw new Error('no_further_plugin_edge'); },
        actionExecutor: { execute: async (actionId, input, context) => {
            if (actionId !== 'workflow.run.start') throw new Error('unexpected_host_action');
            return { ok: true, result: await owner.execute({ actionId, input: WorkflowRunStartRequestV1Schema.parse(input),
                // The Account host's admitted permission witness is a transport authority boundary, independent of caller attribution.
                context: { ...context, callerPermissionMode: 'default',
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
                    externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } } }) };
        } },
    });
    const action = {
        provenance: 'external', source: { kind: 'path' }, pluginId,
        definition: { kindVersion: 1, id: 'start', title: 'Start', description: null, safety: 'safe', dangerLevel: 'safe',
            execution: { target: 'daemon' }, scopes: ['global'], placements: [], slash: null, bindings: null, examples: null,
            surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false, api: false, plugin: false },
            inputHints: null, inputSchema: { type: 'object' }, outputSchema: {}, contributionSurfaces: ['ui'], placementBindings: [] },
    } satisfies ResolvedActionContribution;
    const contributes = createResolvedContributionRegistry({ agents: [], actions: [action], occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        materializationIdsByPluginId: {}, uiViewsV2: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
            identity: { pluginId, localId: 'dashboard' }, manifestPath: '/plugins/acme.starter/.happier-plugin/plugin.json',
            definition: { id: 'dashboard', container: 'detailsTab', target: { kind: 'session' }, renderer: 'renderer',
                title: 'Dashboard', instancePolicy: 'singleton', headerActions: [] } }] });
    const targetActionInvocations = createTargetActionInvocationRegistry({
        actions: [{ pluginId, pluginVersion: '1.0.0', occurrenceId, sourceCustody, localId: 'start',
            definition: { id: 'start', dangerLevel: 'safe', scopes: ['global'], surfaces: ['ui', 'agent', 'mcp', 'cli'],
                inputSchema: { type: 'object' }, resultSchema: {} },
            handler: async (_input, context) => {
                expect(Object.prototype.hasOwnProperty.call(context, 'initiatingActionCaller')).toBe(false);
                expect(Object.prototype.hasOwnProperty.call(context, 'startedBy')).toBe(false);
                await context.services.actions.execute('workflow.run.start', { runId, source: { kind: 'inline', definition: {
                    version: 1, defaults: { agentTarget },
                    blocks: [{ kind: 'step', id: 'work', document: { text: 'Review', references: [], attachments: [] } }],
                } } });
                return null;
            } }],
        resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
            desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        createServices: services.createServices, resolveHostBinding: services.resolveHostBinding,
        readCurrentPluginOccurrenceId: id => id === pluginId ? occurrenceId : null,
    });
    // Filesystem-backed runtime loading/lease is the boundary; real catalogs, target admission and Actions services run beneath it.
    const registry = { contributes, targetActionInvocations, generation: 7,
        readPluginOccurrenceId: (id: string) => id === pluginId ? occurrenceId : null,
        readPluginSourceCustody: (id: string) => id === pluginId ? sourceCustody : null,
        isPluginOccurrenceCurrent: (id: string, candidate: string) => id === pluginId && candidate === occurrenceId,
    } as unknown as ResolvedExecutablePluginRuntimeRegistry;
    return { registry, pluginId, occurrenceId,
        opened: () => openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(acceptedEnvelope) }),
        dispose: async () => { targetActionInvocations.dispose(); await services.dispose(); },
    };
}

describe('host-admitted plugin Workflow starter ingresses', () => {
    it('freezes the present-user mounted RPC starter through real dispatch and Account admission', async () => {
        const runtime = starterRuntime();
        try {
            const handlers = new Map<string, RpcHandler>();
            const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
            registerDaemonContributionRegistryProjectionHandler(registrar, {
                resolveRuntimeRegistry: async () => runtime.registry, resolveGeneration: async () => 7,
                resolveInstalledPackages: async () => [],
                resolvePluginProjectionExecutionOriginContext: async () => ({ serverIdentityId: 'home-1', machineId: 'machine-1' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
            if (!handler) throw new Error('missing_plugin_action_handler');
            const result = await handler({ machineId: 'machine-1', expectedContributorOccurrenceId: runtime.occurrenceId,
                qualifiedActionId: 'acme.starter/start', input: {}, executionSurface: 'ui',
                invocation: { kind: 'mountedPluginSurface', mountedBinding: { pluginId: runtime.pluginId,
                    contributionLocalId: 'dashboard', occurrenceId: runtime.occurrenceId } } });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(runtime.opened()).toMatchObject({ kind: 'available', content: { startedBy: 'user',
                authorization: { principal: { kind: 'plugin', pluginId: runtime.pluginId, contributionLocalId: 'start' } } } });
        } finally { await runtime.dispose(); }
    });

    it('freezes the bound Session MCP starter through real scoped dispatch and Account admission', async () => {
        const runtime = starterRuntime();
        let mcp: ReturnType<typeof createHappierMcpServer>['mcp'] | undefined;
        try {
            const client = { sessionId: 'session-origin', getServerBinding: () => ({ serverId: 'home-1', serverUrl: 'https://home.example.test' }),
                rpcHandlerManager: { registerHandler: () => {}, invokeLocal: async () => { throw new Error('unexpected_session_transport'); } },
                updateMetadata: () => {},
            } satisfies HappyMcpSessionClient;
            const server = createHappierMcpServer(client, { pluginRuntimeRegistryLease: { registry: runtime.registry,
                source: 'ephemeral', durableRevision: -1, release: async () => {} },
                pluginToolCatalog: [{ toolId: 'acme.starter/start-tool', actionId: 'acme.starter/start', name: 'acme_starter_start',
                    title: 'Start', description: 'Start a Workflow', inputSchema: { type: 'object' }, surfaces: ['agent'] }],
            });
            mcp = server.mcp;
            const result = await server.executeTool({ toolName: 'acme_starter_start', args: {} });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(runtime.opened()).toMatchObject({ kind: 'available', content: { startedBy: 'agent',
                authorization: { principal: { kind: 'plugin', pluginId: runtime.pluginId, contributionLocalId: 'start' } } } });
        } finally {
            try { await mcp?.close(); } finally { await runtime.dispose(); }
        }
    });

    it('freezes the bound Session MCP starter through authenticated daemon transport without changing plugin authority', async () => {
        const runtime = starterRuntime();
        const app = fastify();
        const changes = createDaemonPluginChangeService({ prepare: async () => { throw new Error('no_package_change'); } });
        let mcp: ReturnType<typeof createHappierMcpServer>['mcp'] | undefined;
        let restoreStateRead: (() => void) | undefined;
        try {
            // Registry loading/lease custody is the system boundary; the real route and invocation owners run beneath it.
            const reloadController = { tryAcquireRuntimeRegistry: () => ({ registry: runtime.registry,
                source: 'active', durableRevision: 1, release: async () => {} }) } as unknown as PluginReloadController;
            registerDaemonPluginChangeRoutes(app, {
                service: changes, requireAuth: createDaemonControlAuthGuard('starter-control-token'),
                executeAction: request => executeAppliedDaemonPluginActionWithController(request, reloadController),
            });
            await app.listen({ port: 0, host: '127.0.0.1' });
            const address = app.server.address();
            if (!address || typeof address === 'string') throw new Error('missing_daemon_control_address');
            // Only the filesystem-owned daemon address is substituted; HTTP serialization, bearer auth and strict parsing stay real.
            const stateRead = vi.spyOn(persistence, 'readDaemonState').mockResolvedValue({
                pid: process.pid, httpPort: address.port, controlToken: 'starter-control-token',
                startedAt: 0, startedWithCliVersion: 'test',
            });
            restoreStateRead = () => { stateRead.mockRestore(); };
            const client = { sessionId: 'session-origin', getServerBinding: () => ({ serverId: 'home-1', serverUrl: 'https://home.example.test' }),
                rpcHandlerManager: { registerHandler: () => {}, invokeLocal: async () => { throw new Error('unexpected_session_transport'); } },
                updateMetadata: () => {},
            } satisfies HappyMcpSessionClient;
            const server = createHappierMcpServer(client, {
                pluginToolCatalog: [{ toolId: 'acme.starter/start-tool', actionId: 'acme.starter/start', name: 'acme_starter_start',
                    title: 'Start', description: 'Start a Workflow', inputSchema: { type: 'object' }, surfaces: ['agent'] }],
            });
            mcp = server.mcp;
            const result = await server.executeTool({ toolName: 'acme_starter_start', args: {} });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            expect(runtime.opened()).toMatchObject({ kind: 'available', content: { startedBy: 'agent',
                authorization: { principal: { kind: 'plugin', pluginId: runtime.pluginId, contributionLocalId: 'start' } } } });
            const invalid = await app.inject({ method: 'POST', url: PLUGIN_ACTION_EXECUTE_PATH,
                headers: { 'x-happier-daemon-token': 'starter-control-token' },
                payload: { actionId: 'acme.starter/start', input: {}, surface: 'agent', startedBy: 'robot' },
            });
            expect(invalid.statusCode).toBe(400);
            expect(invalid.json()).toMatchObject({ matched: true, result: { errorCode: 'invalid_plugin_action_request' } });
        } finally {
            restoreStateRead?.();
            try { await mcp?.close(); } finally {
                await app.close();
                await changes.shutdown();
                await runtime.dispose();
            }
        }
    });

});
