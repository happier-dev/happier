import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildQualifiedPluginContributionKey, type PluginAgentContributionV2 } from '@happier-dev/protocol';

import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { resolveBackendEngineAdapterResolution } from '@/agent/runtime/registry/engineRegistry';
import {
    composeNativeAgentSessionRuntimeContext,
    createNativeAgentSessionHostServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocketConnection } from '@/api/session/sockets';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';

import { DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY } from './context/daemonDatabaseLimitsPolicy';
import { loadRetainedAgentRuntimeLeaf } from './runner/loadRetainedAgentRuntimeLeaf';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
// Only the remote HTTP and Socket.IO transports are replaced. Required Session
// services, admission, retained-source checks and ACP composition stay real.
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('axios');

async function seedDeclarativeAgent(input: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    pluginId: string;
    definition: PluginAgentContributionV2;
    devWatch?: boolean;
}>) {
    await mkdir(join(input.pluginRoot, '.happier-plugin'), { recursive: true });
    await writeFile(join(input.pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify(
        createPluginManifestV2Fixture({
            id: input.pluginId,
            entrypoints: undefined,
            contributes: { agents: [input.definition] },
        }),
    ), 'utf8');
    await seedCurrentLocalPathPluginFixture({
        happyHomeDir: input.happyHomeDir,
        pluginRoot: input.pluginRoot,
        pluginId: input.pluginId,
        manifestVersion: '1.0.0',
        ...(input.devWatch === undefined ? {} : { devWatch: input.devWatch }),
    });
}

describe('resolveExecutablePluginRuntimeRegistry declarative ACP admission', () => {
    beforeEach(() => {
        socketIo.mockReset().mockImplementation(() => createApiSessionSocketStub());
        vi.mocked(axios.get).mockReset().mockResolvedValue({ status: 404, data: {} });
    });

    it.each([
        { label: 'installed localPath', devWatch: false },
        { label: 'installed localPath with development watching selected', devWatch: true },
    ])('opens an entrypoint-free Agent through retained ACP custody for $label and rejects substitutions before TCP egress', async ({ devWatch }) => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declarative-runner-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-declarative-runner-plugin-'));
        const pluginId = 'acme.declarative-acp-installed';
        const localAgentId = 'declarative-agent';
        const agentId = buildQualifiedPluginContributionKey({ pluginId, localId: localAgentId });
        const requests: Readonly<{ id?: string | number; method?: string; params?: unknown }>[] = [];
        const sockets = new Set<Socket>();
        let connections = 0;
        const server = createServer((socket) => {
            connections += 1;
            sockets.add(socket);
            socket.once('close', () => { sockets.delete(socket); });
            let buffer = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const request = JSON.parse(line) as (typeof requests)[number];
                    requests.push(request);
                    if (request.id === undefined) continue;
                    const result = request.method === 'initialize'
                        ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
                        : request.method === 'session/new'
                            ? { sessionId: 'declarative-provider-session' }
                            : {};
                    socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
                }
            });
        });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        let session: AgentSessionRuntime | null = null;
        let hostSession: ApiSessionClient | null = null;
        let owners: ReturnType<typeof createNativeAgentSessionHostServiceOwners> | null = null;
        let publications: ReturnType<typeof createNativeAgentSessionPublications> | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
            await seedDeclarativeAgent({
                happyHomeDir, pluginRoot, pluginId, devWatch,
                definition: {
                    id: localAgentId,
                    title: 'Declarative Agent',
                    runtime: {
                        kind: 'acp',
                        transport: { kind: 'tcp', host: '127.0.0.1', port: address.port },
                        definition: { mcp: { policy: 'pass_through' } },
                    },
                    primary: 'sessions',
                    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                },
            });
            fixture = await createAdmittedPluginRuntimeFixture({
                happyHomeDir,
                runtimeOptions: { pluginIds: [pluginId] },
            });
            const registry = fixture.registry;
            const lease = registry.agentRuntimesByAgentId.get(agentId);
            const binding = lease?.sessionRunnerFactoryBinding;
            if (!lease || !binding || !('kind' in binding)) throw new Error('Expected retained host ACP binding');
            expect(binding).toMatchObject({
                kind: 'host_declarative_acp_v1', pluginId, pluginVersion: '1.0.0', agentId,
                qualifiedAgentId: pluginId + '/agents/' + localAgentId, localAgentId,
                sourceCustody: { kind: 'managed', installSource: 'localPath' },
            });
            const paths = resolvePluginStorePaths({ happyHomeDir });
            const leaf = await loadRetainedAgentRuntimeLeaf({ paths, binding });
            const signal = new AbortController().signal;
            const runtime = await leaf.factory({
                plugin: { id: pluginId, version: lease.pluginVersion }, agent: { id: agentId }, signal,
            });
            if (!runtime.sessions) throw new Error('Expected declarative Session runtime');
            const services = await registry.createAgentInvocationServices({
                pluginId, pluginVersion: lease.pluginVersion, agentId, occurrenceId: lease.occurrenceId,
                correlationId: 'declarative-acp-open', cwd: pluginRoot, signal,
                isOccurrenceCurrent: lease.isCurrent,
            });
            const sessionId = 'host-declarative-acp';
            const token = 'declarative-acp-session-token';
            const serverUrl = 'https://declarative-acp.example.test';
            hostSession = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId }), {
                metadataAuthority: { kind: 'shared_editor' },
                durableMutationDeliveryInitiallyActive: false,
                transport: {
                    serverId: 'declarative-acp-home', serverUrl,
                    createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({
                        token, sessionId, machineId, serverUrl,
                    }),
                },
            });
            const resolution = await resolveBackendEngineAdapterResolution(agentId, { runtimeRegistry: registry });
            if (!resolution) throw new Error('Expected admitted declarative engine resolution');
            const identity = {
                pluginId, pluginVersion: lease.pluginVersion, agentId, occurrenceId: lease.occurrenceId,
                isCurrent: lease.isCurrent,
            };
            owners = createNativeAgentSessionHostServiceOwners({
                runtimeRegistry: registry, identity, backend: resolution.backend, agent: resolution.agent,
                hostSession: {
                    session: hostSession, machineId: 'declarative-acp-machine', accountSettingsAuthority: 'session',
                    permissionHandler: new ProviderEnforcedPermissionHandler(hostSession, { logPrefix: 'Declarative ACP fixture' }),
                },
                sessionId, directory: pluginRoot, signal, happyHomeDir,
            });
            publications = createNativeAgentSessionPublications({
                agentId, session: hostSession, signal, isCurrent: lease.isCurrent, supportsInFlightSteer: false,
            });
            const sessionServices = createNativeAgentSessionHostServices({
                owners, agentId, sessionId, directory: pluginRoot, signal, isCurrent: lease.isCurrent,
                session: hostSession, publications: publications.services,
                readToolExecutionCapability: () => runtime.toolExecution?.capability ?? null,
            });
            const context = composeNativeAgentSessionRuntimeContext({
                identity, contributionId: localAgentId, sessionId, invokedAtMs: Date.now(), signal, services,
                ui: createPluginInvocationPresentation({ currentSession: null, signal, isOccurrenceCurrent: lease.isCurrent }),
                protocols: createPublicAcpRuntimeProtocols({
                    pluginId, agentId, signal, isCurrent: lease.isCurrent, services, models: sessionServices.models,
                }),
                sessionServices,
                workState: createNativeAgentSessionWorkStateService({
                    session: hostSession, pluginId, contributionId: localAgentId, agentId,
                    occurrenceId: lease.occurrenceId,
                        declarations: readAgentSessionCapabilities(resolution.agent.richDefinition?.definition)?.workStateSources ?? [],
                    isCurrent: lease.isCurrent,
                }),
            });
            session = await runtime.sessions.open({ kind: 'create', sessionId, cwd: pluginRoot }, context);
            expect(requests).toEqual(expect.arrayContaining([
                expect.objectContaining({ method: 'initialize' }),
                expect.objectContaining({ method: 'session/new', params: expect.objectContaining({ cwd: pluginRoot }) }),
            ]));
            const requestsAfterOpen = [...requests];
            const connectionsAfterOpen = connections;
            const mutations: readonly unknown[] = [
                { ...binding, pluginId: 'acme.substituted' },
                { ...binding, pluginVersion: '9.9.9' },
                { ...binding, agentId: 'substituted-agent' },
                { ...binding, qualifiedAgentId: 'acme.substituted/agents/declarative-agent' },
                { ...binding, localAgentId: 'substituted-agent' },
                { ...binding, sourceCustody: { ...binding.sourceCustody, immutableGenerationId: 'substituted-generation' } },
                { ...binding, kind: 'host_declarative_acp_v2' },
            ];
            for (const mutation of mutations) {
                await expect(loadRetainedAgentRuntimeLeaf({ paths, binding: mutation })).rejects.toThrow();
            }
            expect(requests).toEqual(requestsAfterOpen);
            expect(connections).toBe(connectionsAfterOpen);
        } finally {
            try {
                try {
                    await session?.dispose();
                } finally {
                    publications?.dispose();
                    try {
                        await owners?.dispose();
                    } finally {
                        try {
                            await hostSession?.close();
                        } finally {
                            await fixture?.dispose();
                        }
                    }
                }
            } finally {
                for (const socket of sockets) socket.destroy();
                await new Promise<void>((resolve) => server.close(() => resolve()));
                await rm(happyHomeDir, { recursive: true, force: true });
                await rm(pluginRoot, { recursive: true, force: true });
            }
        }
    });

    it('admits invocation services for an entrypoint-free Agent from the committed normalized catalog', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-declarative-agent-services-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-declarative-agent-services-plugin-'));
        const pluginId = 'acme.declarative-acp-proof';
        const localAgentId = 'novel-declarative-acp-agent';
        const agentId = buildQualifiedPluginContributionKey({ pluginId, localId: localAgentId });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        try {
            await seedDeclarativeAgent({
                happyHomeDir, pluginRoot, pluginId,
                definition: {
                    id: localAgentId, title: 'Novel Declarative ACP Agent',
                    runtime: { kind: 'acp', transport: { kind: 'tcp', host: '127.0.0.1', port: 4242 } },
                    primary: 'sessions',
                    capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                },
            });
            fixture = await createAdmittedPluginRuntimeFixture({
                happyHomeDir,
                runtimeOptions: { pluginIds: [pluginId], daemonDatabaseLimits: DEFAULT_PLUGIN_DAEMON_DATABASE_LIMITS_POLICY },
            });
            const registry = fixture.registry;
            const lease = registry.agentRuntimesByAgentId.get(agentId);
            if (!lease) throw new Error('Expected admitted declarative Agent lease');
            const services = await registry.createAgentInvocationServices({
                pluginId, pluginVersion: lease.pluginVersion, agentId, occurrenceId: lease.occurrenceId,
                correlationId: 'declarative-agent-services', cwd: pluginRoot, signal: new AbortController().signal,
                isOccurrenceCurrent: lease.isCurrent,
            });
            await expect(services.storage.daemon.set('proof', 'catalog-owned')).resolves.toBeUndefined();
            await expect(services.storage.daemon.get('proof')).resolves.toBe('catalog-owned');
        } finally {
            await fixture?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(pluginRoot, { recursive: true, force: true });
        }
    });
});
