import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, PluginInstallationManifestPublisherHeaderV1Schema, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, WorkflowActionFailureV1Schema, WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { callSocketRpc } from '@happier-dev/sync-client';
import { Server } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { updateSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { registerActionSpecRpcHandlers } from './registerActionSpecRpcHandlers';
import { createDeferred } from '@/testkit/async/deferred';
import { refreshActivePromptLibraryCatalog } from '@/settings/prompts/hydratePromptLibraryCatalog';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const machineRpc = vi.hoisted(() => vi.fn());
// Only HTTP and authenticated Machine RPC are substituted system boundaries.
vi.mock('axios', () => ({ default: { get: http.get, post: http.post,
    isAxiosError: (value: unknown) => Boolean(value && typeof value === 'object' && 'response' in value) } }));
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: machineRpc,
}));
// Prisma is the server's persistence boundary. Keep Machine availability and
// RPC forwarding policy real without connecting to or mutating any database.
vi.mock('../../../../server/sources/storage/db', () => ({ db: {
    machine: { findFirst: async () => ({ revokedAt: null, replacedByMachineId: null }) },
} }));
const forwardingModulePath = '../../../../server/sources/app/api/socket/rpc/forwardRpcCall';
const { forwardRpcCall }: { forwardRpcCall: (params: Readonly<{
    io: Server; targetUserId: string; method: string; callParams: unknown; callerAuthority: 'present_user';
}>) => Promise<unknown> } = await import(forwardingModulePath);
const temporaryDirectories: string[] = [];
afterEach(async () => {
    resetInMemoryAccountSettingsContextForTests();
    vi.restoreAllMocks();
    http.get.mockReset();
    http.post.mockReset();
    machineRpc.mockReset();
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const runId = '11111111-1111-4111-8111-111111111111';
const definitionId = '22222222-2222-4222-8222-222222222222';
const waitDefinition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'continue',
    document: { text: 'Continue when ready', references: [], attachments: [] } }] };
const semanticInput = {
    runId,
    source: {
        kind: 'inline' as const,
        definition: {
            version: 1 as const,
            defaults: {
                agentTarget: {
                    kind: 'agent' as const,
                    identity: { pluginId: 'happier.agent.test', localId: 'test' },
                },
            },
            blocks: ['work'],
        },
    },
};
const run = { sourceArtifactId: null, ownerAccountId: 'account-1', visibleTeamId: null,
    id: runId,
    origin: { kind: 'direct' as const },
    state: 'queued' as const,
    revision: 0,
    machineId: 'machine-1',
    workflowCustodyState: 'pending' as const,
    originDeliveryAckRevision: null,
    availability: {
        pause: true,
        resumeBoundary: false,



        restoreWorkspace: false,
        cancel: true,
        inspectExecution: false,
        disabledReasons: [],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

async function createBoundaryHarness(holdRetainedSource?: () => Promise<void>, savedDefinition: WorkflowDefinitionV1 = waitDefinition) {
    resetInMemoryAccountSettingsContextForTests();
    const directory = await mkdtemp(join(tmpdir(), 'workflow-rpc-project-'));
    temporaryDirectories.push(directory);
    const project = { machineId: 'machine-1', directory };
    const serverUrl = 'https://workflow-rpc-home.test';
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({
        runId, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
        ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    });
    // CLI's canonical test setup gives persistence its own per-process home.
    // Generate the real installation publisher key there instead of faking crypto.
    await updateSettings((settings) => ({
        ...settings,
        machineIdByServerId: {
            ...settings.machineIdByServerId,
            [configuration.activeServerId]: project.machineId,
        },
    }));
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const rpcHandlerManager = new RpcHandlerManager({
        scopePrefix: project.machineId, encryptionMode: 'plain', logger: () => {},
    });
    let acceptedEnvelope: string | undefined;
    const storageOperations: Readonly<Record<string, unknown>>[] = [];
    const boundaryObservations: string[] = [];
    const boundaryTimings: Array<Readonly<{ phase: string; durationMs: number }>> = [];
    let promptRowsObserved = false;
    const readHttp = async (url: string, config?: Readonly<{ headers?: Readonly<Record<string, string>> }>) => {
        const target = new URL(url);
        const path = target.pathname;
        boundaryObservations.push(`GET ${path}`);
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-1' } };
        if (path === '/v2/account/settings') {
            if (promptRowsObserved) await holdRetainedSource?.();
            return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        }
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        } };
        if (path === '/v1/account/entity-rows/prompt-library') { promptRowsObserved = true; return { status: 200, data: {
            status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map((key) => ({ key, revision: 1,
                content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })),
        } }; }
        if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        if (path === '/v1/artifacts') {
            // The real role-source owner inventories saved roles even when the
            // Workflow selects an Agent directly. This Account has no saved
            // Artifact documents; the actual HTTP list shape is an array.
            const authorization = Object.entries(config?.headers ?? {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1];
            boundaryObservations.push(`Artifact list originMatches=${target.origin === serverUrl} limit=${target.searchParams.get('limit')} authorizationMatches=${authorization === `Bearer ${token}`}`);
            expect(target.origin).toBe(serverUrl);
            expect(target.searchParams.get('limit')).toBe('500');
            expect(authorization).toBe(`Bearer ${token}`);
            boundaryObservations.push('Artifact list returning empty array');
            return { status: 200, data: [] };
        }
        if (path === `/v1/artifacts/${definitionId}`) return { status: 200, data: {
            id: definitionId, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId,
                revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved Wait' } }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition: savedDefinition }) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1,
        } };
        if (path === '/v2/sessions/cli-global') return { status: 404, data: { error: 'session_not_found' } };
        throw new Error(`unexpected_get:${path}`);
    };
    http.get.mockImplementation(async (...args: Parameters<typeof readHttp>) => {
        const startedAt = performance.now();
        try { return await readHttp(...args); }
        finally { boundaryTimings.push({ phase: `GET ${new URL(args[0]).pathname}`, durationMs: performance.now() - startedAt }); }
    });
    const writeHttp = async (url: string, operation: Readonly<Record<string, unknown>>, config: Readonly<{ headers: Record<string, string> }>) => {
        expect(new URL(url).pathname).toBe('/v3/automations/runs/workflow-storage');
        storageOperations.push(operation);
        boundaryObservations.push(`POST ${new URL(url).pathname} ${String(operation.operation)}`);
        if (operation.operation === 'get' && acceptedEnvelope === undefined) {
            throw Object.assign(new Error('not found'), { response: { status: 404 } });
        }
        if (operation.operation === 'admit') {
            expect(operation.publisherMachineId).toBe(project.machineId);
            const publisher = PluginInstallationManifestPublisherHeaderV1Schema.parse(JSON.parse(Buffer.from(
                config.headers[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]!, 'base64url',
            ).toString('utf8')));
            expect(publisher.proof).toMatchObject({ machineId: project.machineId, method: 'POST', path: '/v3/automations/runs/workflow-storage' });
            if (typeof operation.acceptedEnvelope !== 'string') throw new Error('invalid_accepted_envelope');
            acceptedEnvelope = operation.acceptedEnvelope;
            return { data: { kind: 'created', run } };
        }
        if (operation.operation === 'get') {
            return { data: { run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus } };
        }
        throw new Error(`unexpected:${String(operation.operation)}`);
    };
    http.post.mockImplementation(async (...args: Parameters<typeof writeHttp>) => {
        const startedAt = performance.now();
        try { return await writeHttp(...args); }
        finally { boundaryTimings.push({ phase: `storage ${String(args[1].operation)}`, durationMs: performance.now() - startedAt }); }
    });
    machineRpc.mockImplementation(async ({ machineId, method }) => {
        boundaryObservations.push(`Machine ${String(method)}`);
        expect(machineId).toBe(project.machineId);
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
            protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { test: {
                id: 'test', identity: semanticInput.source.definition.defaults.agentTarget.identity,
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            }, claude: { id: 'claude', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            } } },
        };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'cli.test': { ok: true, data: { installed: true, version: '1', latestVersion: null,
                update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
                platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
            'cli.claude': { ok: true, data: { installed: true, version: '1', latestVersion: null,
                update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
                platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
            'tool.executionRuns': { ok: true, data: { available: true, features: { detachedScope: true }, backends: { test: { available: true } } } },
        } };
        throw new Error(`unexpected_machine_method:${method}`);
    });
    const features = () => fetchServerFeaturesSnapshot({ serverUrl, token,
        fetchImpl: async () => new Response(JSON.stringify({ features: { workflows: { enabled: true }, automations: { enabled: true } }, capabilities: {} }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    await runWithServerHttpBaseUrl(serverUrl, () => bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' }));
    // Mirror the credentialed Account CLI host's plain Session codec context;
    // Account currentness above independently owns Workflow encryption mode.
    const canonicalExecutor = createCliActionExecutor({ token, credentials, sessionId: 'cli-global',
        mode: 'plain', ctx: null,
        serverId: 'server-1', serverHttpBaseUrl: serverUrl, resolveServerFeaturesSnapshot: features,
    });
    const received: Array<Readonly<{ input: unknown; context: unknown }>> = [];
    const executor: typeof canonicalExecutor = {
        ...canonicalExecutor,
        execute: (actionId, input, context) => {
            received.push({ input, context });
            return runWithServerHttpBaseUrl(serverUrl, () => canonicalExecutor.execute(actionId, input, context));
        },
    };
    registerActionSpecRpcHandlers({
        rpcHandlerManager: {
            registerHandler(method, handler) {
                rpcHandlerManager.registerHandler(method, handler);
                // The authenticated RPC transport supplies authority separately
                // from the decrypted public payload, as in the real ingress.
                handlers.set(method, async (input) => await rpcHandlerManager.handleRequest({
                    method: `${project.machineId}:${method}`, params: input, callerAuthority: 'present_user',
                }));
            },
        },
        actionExecutor: executor,
        actionIds: ['workflow.run.start'],
        targetMachineId: 'machine-1',
    });
    return { handlers, rpcHandlerManager, received, storageOperations, project, credentials, serverUrl, boundaryObservations, boundaryTimings, readCommittedEnvelope: () => acceptedEnvelope };
}

describe('UI Workflow targeted Action RPC boundary', () => {
    let runtimeRegistryLease: PluginRuntimeRegistryLease | null = null;

    beforeAll(async () => {
        // This fixture uses the real Git runtime. Scope its source catalog and
        // admitted custody together so workspace resolution cannot request
        // unrelated SCM hosting providers from an unscoped catalog.
        const pluginId = 'happier.scm.backend.git';
        const builtIn = resolveBuiltInContributions();
        const contributes = createResolvedContributionRegistry({
            scmBackends: builtIn.scmBackends?.filter((entry) => entry.pluginId === pluginId),
            managedDependencies: builtIn.managedDependencies?.filter((entry) => entry.pluginId === pluginId),
            activationTargets: builtIn.activationTargets?.filter((entry) => entry.pluginId === pluginId),
        });
        runtimeRegistryLease = await pluginReloadController.acquireRuntimeRegistry({
            resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes, pluginIds: [pluginId] }),
        });
    });

    afterAll(async () => {
        await runtimeRegistryLease?.release();
        runtimeRegistryLease = null;
        await pluginReloadController.shutdown();
    });

    it('delivers a late saved-Workflow refusal through UI, server and daemon instead of abandoning a missing Run', async () => {
        const boundary = await createBoundaryHarness();
        const readHttp = http.get.getMockImplementation()!;
        let releaseDefinition!: () => void;
        const definitionRead = new Promise<void>((resolve) => { releaseDefinition = resolve; });
        let notifyDefinitionRead!: () => void;
        const reachedDefinition = new Promise<void>((resolve) => { notifyDefinitionRead = resolve; });
        http.get.mockImplementation(async (...args: Parameters<typeof readHttp>) => {
            if (new URL(String(args[0])).pathname === `/v1/artifacts/${definitionId}`) {
                notifyDefinitionRead();
                await definitionRead;
                // The Artifact store deliberately accepts HTTP statuses and
                // classifies absence itself, just as real Axios does here.
                return { status: 404, data: { error: 'Artifact not found' } };
            }
            return await readHttp(...args);
        });
        const { createUiWorkflowActionTransport } = await import('../../../../ui/sources/sync/ops/actions/workflowActionTransport');
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import(
            '../../../../ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes'
        );
        // Attach the Engine.IO owner so Socket.IO has a real lifecycle to close;
        // no listening port or external server is needed for adapter delivery.
        const sockets = new Server(createServer());
        vi.useFakeTimers();
        try {
            // Only Socket.IO's adapter delivery is substituted. Its actual
            // acknowledgement deadline, server relay, RPC codec and daemon
            // Action/materialization owners all execute their production logic.
            vi.spyOn(sockets.of('/').adapter, 'broadcastWithAck').mockImplementation(
                (packet, _options, clientCount, acknowledgement) => {
                    clientCount(1);
                    if (packet.data?.[0] !== SOCKET_RPC_EVENTS.REQUEST) throw new Error('unexpected_socket_event');
                    // Socket.IO's packet is untyped; it carries the real relay's RpcRequest.
                    void boundary.rpcHandlerManager.handleRequest(packet.data[1] as RpcRequest).then(acknowledgement);
                },
            );
            const target = {
                id: 'daemon-socket',
                data: { clientType: 'machine-scoped', machineId: boundary.project.machineId },
                timeout: (ms: number) => ({ emitWithAck: async (event: string, request: unknown) => {
                    const responses = await sockets.to('daemon-socket').timeout(ms).emitWithAck(event, request);
                    return responses[0];
                } }),
            };
            const fetchSockets = async () => [target];
            // Socket discovery is the other adapter boundary; the selected
            // target still emits through Socket.IO's real acknowledgement owner.
            vi.spyOn(sockets, 'in').mockReturnValue({
                timeout: () => ({ fetchSockets }), fetchSockets,
            } as unknown as ReturnType<Server['in']>);
            const action = createUiWorkflowActionTransport({
                account: { serverId: 'server-1', accountId: 'account-1', assertCurrent: () => {} },
                resolveFallbackMachineId: () => null,
                transport: async (request) => await callSocketRpc({
                    socket: { connected: true, emit: () => {}, emitWithAck: async (_event, payload) => {
                        // This network fixture receives callSocketRpc's actual wire payload.
                        const call = payload as SocketRpcRequestPayload;
                        return await forwardRpcCall({ io: sockets, targetUserId: 'account-1',
                            method: call.method, callParams: call.params,
                            callerAuthority: 'present_user' });
                    } },
                    target: { kind: 'machine', id: request.machineId }, method: request.method,
                    params: request.payload, content: { mode: 'plain' }, signal: request.signal,
                    timeoutMs: request.operationTimeoutMs === null ? null : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
                }),
            });
            let outcome: unknown;
            let settled = false;
            const attempt = action({ actionId: 'workflow.run.start', input: {
                runId, source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } },
            }, context: { surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
                externalActionTarget: { kind: 'machine', machineId: boundary.project.machineId, project: boundary.project } } })
                .then((result) => { outcome = result; }, (error: unknown) => { outcome = error; })
                .finally(() => { settled = true; });
            const reached = await Promise.race([reachedDefinition.then(() => true), attempt.then(() => false)]);
            expect(reached, JSON.stringify({ outcome, observations: boundary.boundaryObservations })).toBe(true);
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 5_000);
            const settledBeforeRefusal = settled;
            releaseDefinition();
            await attempt;
            expect(outcome).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
            expect(settledBeforeRefusal).toBe(false);
            // The canonical owner checks for a racing immutable admission again
            // before surfacing the mutable saved-source refusal.
            expect(boundary.storageOperations.map((operation) => operation.operation)).toEqual(['get', 'get']);
            expect(boundary.readCommittedEnvelope()).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            releaseDefinition();
            await boundary.rpcHandlerManager.waitForIdle();
            vi.useRealTimers();
            await sockets.close();
        }
    });

    it('admits a direct saved fieldless Wait on the selected Machine without an invented origin Session or Agent', async () => {
        const boundary = await createBoundaryHarness();
        const startedAt = performance.now();
        const response = await boundary.handlers.get('workflow.run.start')!({
            v: 1, kind: 'targeted_action_rpc',
            input: { runId, source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } }, inputs: {} },
            target: { kind: 'machine', machineId: boundary.project.machineId, project: boundary.project },
        });
        if (process.env.FF_ADMIT_MEASURE_ADMISSION === '1') console.info('FF-ADMIT2 admission timing', JSON.stringify({
            totalMs: performance.now() - startedAt, phases: boundary.boundaryTimings,
        }));
        expect(response, JSON.stringify(boundary.boundaryObservations)).toEqual({ run, admission: 'created' });
        const envelope = parseWorkflowStoredContentEnvelopeV1(boundary.readCommittedEnvelope()!);
        expect(envelope).not.toBeNull();
        const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', envelope: envelope!,
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
        expect(accepted.kind).toBe('available');
        if (accepted.kind !== 'available') throw new Error('accepted_snapshot_unavailable');
        expect(accepted.content).toMatchObject({ source: { kind: 'saved', definitionId }, origin: { kind: 'direct' },
            machineId: boundary.project.machineId, workspaceTarget: { project: { ...boundary.project, checkoutRootPath: boundary.project.directory } },
            materializedLeaves: [{ kind: 'wait', selection: {} }] });
        expect(accepted.content).not.toHaveProperty('origin.originSessionId');
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('admits the R20b Agent model and connected profile through UI transport and the real daemon handler', async () => {
        const selection = { acpSessionModeId: 'default', connectedServices: { v: 2 as const, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': { source: 'connected' as const, selection: 'profile' as const,
                profileId: '00ae5eea-6286-48bc-b82a-30a5f8492864' },
            'happier.agent.claude/anthropic': { source: 'native' as const },
        } }, engine: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: { v: 1 as const, ref: { agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: null, modelId: 'claude-haiku-4-5' }, updatedAt: 1791577000000 }, effort: 'low' } };
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget: selection.engine.agentTarget },
            blocks: [{ kind: 'step', id: 'reply', name: 'QA-FIN20 Reply', document: {
                text: 'Reply exactly QA_FIN20_AGENT_READY. Do not use tools, edit files, or run commands.', references: [], attachments: [] },
                execution: selection, input: [], result: { kind: 'text' } }] };
        const boundary = await createBoundaryHarness(undefined, definition);
        const { createUiWorkflowActionTransport } = await import('../../../../ui/sources/sync/ops/actions/workflowActionTransport');
        const action = createUiWorkflowActionTransport({ account: { serverId: 'server-1', accountId: 'account-1', assertCurrent: () => {} },
            resolveFallbackMachineId: () => null,
            transport: async ({ payload }) => boundary.handlers.get('workflow.run.start')!(payload),
        });
        const startedAt = performance.now();
        const response = await action({ actionId: 'workflow.run.start', input: {
            runId, source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } }, inputs: {} },
            context: { surface: 'ui', authority: 'present_user', serverId: 'server-1', runtimeAccountId: 'account-1',
                externalActionTarget: { kind: 'machine', machineId: boundary.project.machineId, project: boundary.project } } });
        if (process.env.FF_ADMIT_MEASURE_ADMISSION === '1') console.info('FF-AGENTADMIT source admission', JSON.stringify({ totalMs: performance.now() - startedAt,
            outcome: WorkflowActionFailureV1Schema.safeParse(response).success ? response : 'created', phases: boundary.boundaryTimings }));
        expect(response, JSON.stringify(boundary.boundaryObservations)).toEqual({ run, admission: 'created' });
        const accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            envelope: parseWorkflowStoredContentEnvelopeV1(boundary.readCommittedEnvelope()!)!,
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account-1', runId } });
        expect(accepted).toMatchObject({ kind: 'available', content: { materializedLeaves: [{ kind: 'step', selection: {
            agentTarget: selection.engine.agentTarget, modelSelection: selection.engine.modelSelection,
            connectedServices: selection.connectedServices,
            sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: 'low' } } },
        } }] } });
    });

    it('admits through the real handler while observed Prompt rows await retained-source maintenance', async () => {
        const sourceIssued = createDeferred<void>();
        const source = createDeferred<void>();
        let sourceReleased = false;
        const boundary = await createBoundaryHarness(async () => { sourceIssued.resolve(); await source.promise; });
        const startedAt = performance.now();
        const attempt = boundary.handlers.get('workflow.run.start')!({
            v: 1, kind: 'targeted_action_rpc',
            input: { runId, source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } }, inputs: {} },
            target: { kind: 'machine', machineId: boundary.project.machineId, project: boundary.project },
        });
        try {
            await sourceIssued.promise;
            expect(await attempt, JSON.stringify(boundary.boundaryObservations)).toEqual({ run, admission: 'created' });
            expect(sourceReleased).toBe(false);
            if (process.env.FF_ADMIT_MEASURE_ADMISSION === '1') console.info('FF-LATENCY admission timing', JSON.stringify({
                totalMs: performance.now() - startedAt, retainedSourcePending: !sourceReleased, phases: boundary.boundaryTimings,
            }));
        } finally {
            sourceReleased = true;
            source.resolve();
            await attempt;
            await runWithServerHttpBaseUrl(boundary.serverUrl, () => refreshActivePromptLibraryCatalog({ credentials: boundary.credentials }));
        }
    });

    it('refuses admission if its Account lifetime retires while reading the role Artifact inventory', async () => {
        const boundary = await createBoundaryHarness();
        const readHttp = http.get.getMockImplementation()!;
        http.get.mockImplementation(async (...args: Parameters<typeof readHttp>) => {
            const response = await readHttp(...args);
            if (new URL(String(args[0])).pathname === '/v1/artifacts') clearActiveAccountSettingsSnapshot();
            return response;
        });
        const response = await boundary.handlers.get('workflow.run.start')!({
            v: 1, kind: 'targeted_action_rpc',
            input: { runId, source: { kind: 'saved', definitionId, revision: { headerVersion: 1, bodyVersion: 1 } } },
            target: { kind: 'machine', machineId: boundary.project.machineId, project: boundary.project },
        });
        expect(response).toMatchObject({ ok: false });
        expect(boundary.readCommittedEnvelope()).toBeUndefined();
    });

    it('admits and response-loss rejoins with the selected project kept out of semantic input', async () => {
        const boundary = await createBoundaryHarness();
        const project = boundary.project;
        const handler = boundary.handlers.get('workflow.run.start')!;
        let loseFirstResponse = true;
        let firstResponse: unknown;
        const { createUiWorkflowActionTransport } = await import(
            '../../../../ui/sources/sync/ops/actions/workflowActionTransport'
        );
        const action = createUiWorkflowActionTransport({
            account: {
                serverId: 'server-1',
                accountId: 'account-1',
                assertCurrent: () => undefined,
            },
            resolveFallbackMachineId: () => null,
            transport: async ({ payload }) => {
                const response = await handler(payload);
                if (loseFirstResponse) firstResponse = response;
                // Preserve the exact canonical refusal in the outer assertion;
                // a nested assertion would hide its typed error and details.
                if (WorkflowActionFailureV1Schema.safeParse(response).success) return response;
                if (loseFirstResponse) {
                    // Lose a successful admission response, never conceal a
                    // canonical failure behind the simulated transport error.
                    expect(response).toEqual({ run, admission: 'created' });
                    loseFirstResponse = false;
                    throw new Error('simulated_response_loss');
                }
                return response;
            },
        });
        const request = {
            actionId: 'workflow.run.start' as const,
            input: semanticInput,
            context: {
                serverId: 'server-1',
                runtimeAccountId: 'account-1',
                externalActionTarget: {
                    kind: 'machine' as const,
                    machineId: 'machine-1',
                    project,
                },
            },
        };

        const firstAttempt = action(request);
        // Observe safe boundary paths/operation names without dumping tokens,
        // signed publisher headers, or the accepted private payload.
        await firstAttempt.catch(() => undefined);
        expect(firstResponse, JSON.stringify(boundary.boundaryObservations)).toEqual({ run, admission: 'created' });
        await expect(firstAttempt).rejects.toThrow('simulated_response_loss');
        expect(boundary.storageOperations.map((operation) => operation.operation)).toEqual(['get', 'admit']);
        expect(boundary.readCommittedEnvelope()).toEqual(expect.any(String));
        expect(boundary.readCommittedEnvelope()).toBe(boundary.storageOperations[1]?.acceptedEnvelope);
        await expect(action(request)).resolves.toEqual({ run, admission: 'existing' });
        expect(boundary.received).toHaveLength(2);
        expect(boundary.received[0]?.input).toEqual(semanticInput);
        expect(boundary.received[0]?.input).not.toHaveProperty('target');
        expect(boundary.received[0]?.context).toMatchObject({
            externalActionTarget: {
                kind: 'machine',
                machineId: 'machine-1',
                project,
            },
        });
        expect(boundary.storageOperations.map((operation) => operation.operation))
            .toEqual(['get', 'admit', 'get']);
    });

    it('rejects a project for another Machine before canonical Action execution', async () => {
        const boundary = await createBoundaryHarness();
        const handler = boundary.handlers.get('workflow.run.start');
        const invalidProjectTarget = {
            v: 1,
            kind: 'targeted_action_rpc',
            input: semanticInput,
            target: {
                kind: 'machine',
                machineId: 'machine-1',
                project: { machineId: 'machine-2', directory: '/repo' },
            },
        };
        const wrongDaemonTarget = {
            v: 1,
            kind: 'targeted_action_rpc',
            input: semanticInput,
            target: {
                kind: 'machine',
                machineId: 'machine-2',
                project: { machineId: 'machine-2', directory: '/repo' },
            },
        };
        const rejection = {
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
        };

        await expect(handler?.(invalidProjectTarget)).resolves.toEqual(rejection);
        await expect(handler?.(wrongDaemonTarget)).resolves.toEqual(rejection);
        expect(boundary.received).toEqual([]);
        expect(boundary.storageOperations).toEqual([]);
    });
});
