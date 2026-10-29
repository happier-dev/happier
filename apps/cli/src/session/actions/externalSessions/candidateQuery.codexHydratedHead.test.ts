import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionsSource } from '@happier-dev/protocol';

import type { ExternalSessionCandidatesPage } from '@/session/external/providerOps';
import { createBoundedAgentExternalSessionsContribution } from '@/session/external/agentExternalSessionsInvocation';
import { createAgentExternalSessionsExecutionSurface } from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { createCodexExternalSessionsContribution } from '../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution';
import { CODEX_RAW_PROXY_FIXTURE_SCRIPT, createCodexControlSocketFixture } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client.test-support';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { createCodexNativeAppServerClient } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { readCodexNativeTransportStartupFailure } from '../../../../../../packages/plugins/codex/src/agent/runtime/appServer/sharedServer';

import {
    executeExternalSessionCandidateQuery,
    hydrateExternalSessionCandidateThroughAgentSource,
} from './candidateQuery';

type CodexListing = (params: Record<string, unknown>) => Promise<ExternalSessionCandidatesPage>;

const roots: string[] = [];
const nativeServers: Awaited<ReturnType<typeof createCodexControlSocketFixture>>[] = [];

function jsonl(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function writeRollout(params: Readonly<{
    sessionsDir: string;
    remoteSessionId: string;
    stamp: string;
    cwd: string;
    userText: string;
}>): Promise<void> {
    await mkdir(params.sessionsDir, { recursive: true });
    await writeFile(
        join(params.sessionsDir, `rollout-${params.stamp}-${params.remoteSessionId}.jsonl`),
        [
            jsonl({
                type: 'session_meta',
                timestamp: '2026-08-01T08:00:00.000Z',
                payload: {
                    id: params.remoteSessionId,
                    timestamp: '2026-08-01T08:00:00.000Z',
                    cwd: params.cwd,
                },
            }),
            jsonl({
                type: 'response_item',
                timestamp: '2026-08-01T08:00:01.000Z',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: params.userText }],
                },
            }),
        ].join(''),
        'utf8',
    );
}

describe('Codex candidate index head', () => {
    it.skipIf(process.platform === 'win32')('preserves real native initialization write failures for readiness retry', async () => {
        const root = await mkdtemp(join('/tmp', 'hce-'));
        roots.push(root);
        const socketPath = join(root, 'native.sock');
        const server = createServer(socket => socket.destroy());
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
        const exec = createStablePluginExecService({
            allowedExecutables: [], signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolvePath: async () => root,
            resolveExecutable: async () => { throw new Error('Socket connection must not launch a process'); },
            systemTools: { async resolve(request) {
                return { grantId: 'native-write-fixture', toolId: request.toolId, displayName: 'Native fixture', source: 'system',
                    executablePath: process.execPath, launch: { kind: 'binary', executablePath: process.execPath, args: [] } };
            } },
        });
        try {
            const error = await createCodexNativeAppServerClient({ exec, processEnv: {},
                transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: false },
                initializeRequestOptions: { timeoutMs: 500 },
            }).then(() => { throw new Error('Expected a real rejected socket upgrade'); }, error => error);
            expect(error).toMatchObject({ code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR', cause: { code: 'EPIPE', syscall: 'write' } });
            expect(readCodexNativeTransportStartupFailure(error)).toEqual({ phase: 'native_system_error', reason: 'system_error',
                errnoCode: 'EPIPE', syscall: 'write', transport: 'unixWebSocket', socketPathLengthClass: 'within_limit' });
        } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    });

    it.skipIf(process.platform === 'win32').each([
        ['daemonProxy', 'cancelled'], ['daemonProxy', 'deadline'],
        ['unixWebSocket', 'cancelled'], ['unixWebSocket', 'deadline'],
    ] as const)('releases the managed %s proxy when native initialization is %s', async (transport, outcome) => {
        const root = await mkdtemp(join('/tmp', 'hci-'));
        roots.push(root);
        const socketPath = join(root, 'native.sock');
        const pidPath = join(root, 'proxy.pid');
        let entered!: () => void;
        const initializeSeen = new Promise<void>(resolve => { entered = resolve; });
        const server = await createCodexControlSocketFixture(socketPath, request => {
            if (request.method === 'initialize') entered();
            return undefined;
        });
        nativeServers.push(server);
        const controller = new AbortController();
        const script = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));\n${CODEX_RAW_PROXY_FIXTURE_SCRIPT}`;
        const exec = createStablePluginExecService({
            allowedExecutables: [], signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolvePath: async () => root,
            resolveExecutable: async () => { throw new Error('Expected retained native CLI grant'); },
            systemTools: { async resolve(request) {
                return { grantId: 'native-init-fixture', toolId: request.toolId, displayName: 'Native fixture', source: 'system',
                    executablePath: process.execPath, launch: { kind: 'binary', executablePath: process.execPath,
                        args: ['-e', script, socketPath] } };
            } },
        });
        const opening = createCodexNativeAppServerClient({ exec, processEnv: {}, transport: transport === 'daemonProxy'
            ? { kind: transport } : { kind: transport, socketPath, realtimeConversationAdvertised: false },
            signal: controller.signal, initializeRequestOptions: { signal: controller.signal, timeoutMs: outcome === 'deadline' ? 500 : null } });
        const rejected = expect(opening).rejects.toMatchObject({ code: outcome === 'deadline'
            ? 'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT' : 'PLUGIN_EXEC_CLIENT_ABORTED' });
        try {
            await initializeSeen;
            if (outcome === 'cancelled') controller.abort();
            await rejected;
            await vi.waitFor(() => expect(server.activeConnections).toBe(0));
            if (transport === 'daemonProxy') {
                const pid = Number(await readFile(pidPath, 'utf8'));
                expect(Number.isSafeInteger(pid)).toBe(true);
                await expect(waitForProcessExit(pid)).resolves.toBe(true);
            }
            expect(server.connectionCount).toBe(1);
        } finally {
            controller.abort();
            await opening.catch(() => undefined);
        }
    });

    it.skipIf(process.platform === 'win32')('recovers an oversized explicit-socket response on the same managed native client', async () => {
        const root = await mkdtemp(join('/tmp', 'hce-'));
        roots.push(root);
        const socketPath = join(root, 'exact-native.sock');
        const maxFrameBytes = 1024;
        const server = await createCodexControlSocketFixture(socketPath, request => {
            if (request.method === 'initialize') return {};
            if (request.method === 'thread/resume') return { thread: { id: 'native-thread', oversized: 'λ😀'.repeat(maxFrameBytes) } };
            if (request.method === 'thread/read') return { thread: { id: 'native-thread', name: 'λ😀 Native title' } };
            return undefined;
        });
        nativeServers.push(server);
        const exec = createStablePluginExecService({
            allowedExecutables: [], allowedEnvKeys: ['CODEX_HOME'], environment: { CODEX_HOME: root },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true, resolvePath: async () => root,
            resolveExecutable: async () => { throw new Error('Expected retained native CLI grant'); },
            systemTools: { async resolve(request) {
                return { grantId: 'explicit-socket-fixture', toolId: request.toolId, displayName: 'Native fixture', source: 'system',
                    executablePath: process.execPath, launch: { kind: 'binary', executablePath: process.execPath,
                        args: [] } };
            } },
        });
        const client = await createCodexNativeAppServerClient({ exec,
            processEnv: { CODEX_HOME: root, HAPPIER_CODEX_APP_SERVER_MAX_JSON_LINE_CHARS: String(maxFrameBytes) },
            transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: true } });
        try {
            await expect(client.request('thread/resume', { threadId: 'native-thread' })).rejects.toMatchObject({
                code: 'PLUGIN_EXEC_CLIENT_PROTOCOL_ERROR',
                message: expect.stringContaining('JSON-RPC frame exceeded the configured size limit'),
            });
            await expect(client.request('thread/read', { threadId: 'native-thread', includeTurns: false }))
                .resolves.toEqual({ thread: { id: 'native-thread', name: 'λ😀 Native title' } });
            expect(client.launchFeatures.realtimeConversationAdvertised).toBe(true);
            expect(server.connectionCount).toBe(1);
            expect(server.requests.map(request => request.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/read']);
        } finally { await client.dispose(); }
        await vi.waitFor(() => expect(server.activeConnections).toBe(0));
        const again = await createCodexNativeAppServerClient({ exec, processEnv: { CODEX_HOME: root },
            transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: true } });
        try { await expect(again.request('thread/read')).resolves.toMatchObject({ thread: { id: 'native-thread' } }); }
        finally { await again.dispose(); }
        expect(server.connectionCount).toBe(2);
    });

    it.skipIf(process.platform === 'win32')('refreshes native names through the admitted page operation while retaining the rollout index', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hcn-'));
        roots.push(root);
        const codexHome = join(root, 'codex');
        const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
        const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
        for (const [index, id] of ids.entries()) await writeRollout({ sessionsDir: join(codexHome, 'sessions'),
            remoteSessionId: id, stamp: `2026-08-01T0${index + 1}-00-00`, cwd: '/repo/fallback', userText: `Rollout ${id}` });
        const socketPath = join(codexHome, 'app-server-control', 'app-server-control.sock');
        let prefix = 'Native';
        let nativeFailure = false;
        const server = await createCodexControlSocketFixture(socketPath, message => {
            if (message.method === 'initialize') return {};
            if (message.method === 'thread/read') {
                if (nativeFailure) throw new Error('native unavailable');
                const input = message.params as { threadId: string; includeTurns?: boolean };
                expect(input.includeTurns).toBe(false);
                return { thread: { id: input.threadId, name: `${prefix} ${input.threadId}` } };
            }
            if (message.method === 'initialized') return undefined;
            throw new Error('Unexpected native metadata operation');
        });
        nativeServers.push(server);
        // Only the vendor executable is substituted: host process admission,
        // private WebSocket framing, native client and page projection stay real.
        let resolutions = 0;
        const proxyArgs = ['-e', CODEX_RAW_PROXY_FIXTURE_SCRIPT, socketPath];
        const exec = createStablePluginExecService({
            allowedExecutables: [], allowedEnvKeys: ['CODEX_HOME'], environment: { CODEX_HOME: codexHome },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            resolvePath: async () => root,
            resolveExecutable: async () => { throw new Error('Expected retained native CLI grant'); },
            systemTools: { async resolve(request) {
                resolutions += 1;
                return { grantId: 'native-page-fixture', toolId: request.toolId, displayName: 'Native fixture', source: 'system',
                    executablePath: process.execPath, launch: { kind: 'binary', executablePath: process.execPath, args: proxyArgs } };
            } },
        });
        const custody = { kind: 'development' as const, registeredRootId: 'native-page-fixture' };
        const bounded = createBoundedAgentExternalSessionsContribution({
            contribution: createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } }),
            identity: { pluginId: 'codex', agentId: 'codex', occurrenceId: 'native-page-fixture',
                contributionQualifiedId: 'codex/agents/codex', sourceCustody: custody },
            isCurrent: () => true, retirementSignal: new AbortController().signal,
            createInvocationExec: async () => exec,
        });
        const surface = createAgentExternalSessionsExecutionSurface(bounded);
        const query = () => executeExternalSessionCandidateQuery({ activeServerDir: join(root, 'server'),
            agentIdentity: { pluginId: 'codex', localId: 'codex' }, agentSourceCustody: custody, source, limit: 2,
            listCandidates: async request => surface.listCandidates({ source, ...request }),
            hydrateCandidates: async candidates => surface.hydrateCandidates!({ source, candidates }),
        });
        let page = await query();
        for (let attempt = 0; attempt < 40 && page.preparation; attempt += 1) page = await query();
        expect(page.preparation).toBeUndefined();
        expect(page.candidates.map(candidate => candidate.title).sort()).toEqual(ids.map(id => `Native ${id}`).sort());
        const before = resolutions;
        const requestsBefore = server.requests.length;
        const connectionsBefore = server.connectionCount;
        prefix = 'Renamed';
        page = await query();
        expect(resolutions - before).toBe(1);
        expect(server.connectionCount - connectionsBefore).toBe(1);
        expect(server.requests.slice(requestsBefore).filter(message => message.method === 'thread/read')
            .map(message => (message.params as { threadId: string }).threadId).sort()).toEqual([...ids].sort());
        expect(page.candidates.map(candidate => candidate.title).sort()).toEqual(ids.map(id => `Renamed ${id}`).sort());
        nativeFailure = true;
        page = await query();
        expect(page.candidates.map(candidate => candidate.title).sort()).toEqual(ids.map(id => `Rollout ${id}`).sort());
        expect(server.requests.some(message => message.method === 'thread/list')).toBe(false);
        expect(server.activeConnections).toBe(0);
    });

    afterEach(async () => {
        await Promise.all(nativeServers.splice(0).map(server => server.close()));
        await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
    });

    it('serves a hydrated head carrying titles for an unsearched Codex browse', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-index-head-'));
        roots.push(root);
        const codexHome = join(root, 'codex-home');
        const activeServerDir = join(root, 'active-server');
        const sessionsDir = join(codexHome, 'sessions', '2026', '08', '01');
        const remoteSessionIds = [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333333',
        ] as const;
        const titles = [
            'Audit the transcript corridor',
            'Fix the candidate index head',
            'Measure rollout scan latency',
        ] as const;
        for (const [index, remoteSessionId] of remoteSessionIds.entries()) {
            await writeRollout({
                sessionsDir,
                remoteSessionId,
                stamp: `2026-08-01T0${index + 1}-00-00`,
                cwd: `/repo/codex-${index}`,
                userText: titles[index]!,
            });
        }

        const codexExternalDir = '../../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external';
        const { listCodexSessionCandidates } = await import(
            `${codexExternalDir}/candidateSource.js`
        ) as { listCodexSessionCandidates: CodexListing };
        const { resolveCodexExternalSessionLinkIdentity } = await import(
            `${codexExternalDir}/identity.js`
        ) as {
            resolveCodexExternalSessionLinkIdentity: (
                params: Record<string, unknown>,
            ) => Readonly<{ remoteSessionId: string }>;
        };

        const codexSource = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
        const source = codexSource as unknown as ExternalSessionsSource;
        const env = { ...process.env, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
        const listCandidates = async (request: Readonly<{
            cursor?: string;
            limit: number;
            searchTerm?: string;
            searchMode?: 'fast' | 'full';
        }>): Promise<ExternalSessionCandidatesPage> => await listCodexSessionCandidates({
            source: codexSource,
            activeServerDir,
            env,
            ...request,
            signal: new AbortController().signal,
            deadlineAtMs: Date.now() + 60_000,
        });
        const providerOps = {
            listCandidates: async (params: Readonly<{
                cursor?: string;
                limit: number;
                searchTerm?: string;
                searchMode?: 'fast' | 'full';
            }>) => await listCandidates(params),
            resolveLinkIdentity: async (params: Readonly<{ remoteSessionId: string }>) => {
                const identity = resolveCodexExternalSessionLinkIdentity({
                    source: codexSource,
                    remoteSessionId: params.remoteSessionId,
                });
                return { remoteSessionId: identity.remoteSessionId, source };
            },
        };

        let page: ExternalSessionCandidatesPage | null = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
            page = await executeExternalSessionCandidateQuery({
                activeServerDir,
                agentSourceCustody: { kind: 'development', registeredRootId: 'fixture-source-root' },
                agentIdentity: {
                    pluginId: 'codex',
                    contributionId: 'codex',
                    pluginOccurrenceId: 'codex-index-head-1',
                } as never,
                source,
                limit: 50,
                listCandidates,
                hydrateCandidate: async (candidate) => (
                    await hydrateExternalSessionCandidateThroughAgentSource({
                        source,
                        candidate,
                        providerOps: providerOps as never,
                    })
                ),
            });
            if (!page.preparation) break;
        }

        expect(page?.preparation).toBeUndefined();
        expect(page?.candidates.map((candidate) => candidate.remoteSessionId).sort())
            .toEqual([...remoteSessionIds].sort());
        expect(page?.candidates.map((candidate) => candidate.title).sort())
            .toEqual([...titles].sort());
    }, 120_000);
});
