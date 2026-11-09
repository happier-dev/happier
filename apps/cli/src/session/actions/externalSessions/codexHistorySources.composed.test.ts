import '@happier-dev/protocol/workflows/workflowV1';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineExternalSessionsRpcHandlers } from '@/api/machine/rpcHandlers.externalSessions';
import { resolveExternalSessionSourceSurface } from './providerOpsResolution';
import { mergeConversationSearchHits } from '../../../../../ui/sources/sync/domains/search/mergeConversationSearchHits';
import type { ConversationSearchHit } from '../../../../../ui/sources/sync/domains/search/searchConversations';

const fixture = vi.hoisted(() => ({ activeServerDir: '', nativeUnavailable: false, statCostMs: 0, nowMs: 0 }));
// Model slow native discovery at the filesystem boundary, retaining real files,
// codecs, cursor production, registration, host admission and response schemas.
vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, stat: async (...args: Parameters<typeof actual.stat>) => {
        // The native JSON-RPC process fixture has a matching control socket;
        // discovery still runs through the real proxy-admission owner.
        if (String(args[0]).endsWith(join('app-server-control', 'app-server-control.sock')) && !fixture.nativeUnavailable) {
            return actual.stat(tmpdir());
        }
        const result = await actual.stat(...args);
        if (typeof args[0] === 'string' && args[0].endsWith('.jsonl')) fixture.nowMs += fixture.statCostMs;
        return result;
    } };
});
vi.mock('@/configuration', async (original) => {
    const actual = await original<typeof import('@/configuration')>();
    return { ...actual, configuration: { ...actual.configuration, get activeServerDir() { return fixture.activeServerDir; } } };
});
// Native app-server JSON-RPC is the third-party process boundary. Rollout
// discovery, codecs, plugin registration, host admission and RPC remain real.
vi.mock('../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client', async (original) => ({
    ...await original<typeof import('../../../../../../packages/plugins/codex/src/agent/runtime/appServer/client')>(),
    createCodexNativeAppServerClient: async () => {
        if (fixture.nativeUnavailable) throw new Error('Native app-server unavailable');
        return { request: async () => ({ data: [], nextCursor: null }), dispose: async () => {} };
    },
}));
vi.mock('@/persistence', async (original) => ({ ...await original<typeof import('@/persistence')>(),
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (original) => ({
    ...await original<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async () => ({ mode: 'plain' as const }),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (original) => ({
    ...await original<typeof import('@/session/transport/http/sessionsHttp')>(),
    lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
}));
vi.mock('node:fs', async (original) => {
    const actual = await original<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

afterEach(() => { vi.unstubAllEnvs(); fixture.nativeUnavailable = false; fixture.statCostMs = 0; vi.restoreAllMocks(); });

describe('Codex History source RPC', () => {
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
    beforeAll(async () => { runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController }); });
    afterAll(async () => { await runtime.dispose(); });
    it('continues a slow Codex discovery page through the real host when its native progress exceeds 2,000 characters', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-progress-'));
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | undefined;
        try {
            fixture.activeServerDir = join(root, 'server');
            vi.stubEnv('HOME', root);
            vi.stubEnv('CODEX_HOME', undefined);
            const dir = join(root, '.codex', 'sessions', '2026', '10', '15');
            await mkdir(dir, { recursive: true });
            const ids = Array.from({ length: 12 }, (_, index) => `019a1234-1234-7123-8123-${String(index).padStart(12, '0')}`);
            await Promise.all(ids.map(id => writeFile(join(dir, `rollout-2026-10-15T10-00-00-${id}.jsonl`), [
                { type: 'session_meta', timestamp: '2026-10-15T10:00:00.000Z', payload: { id, cwd: '/repo', source: 'cli' } },
                { type: 'response_item', timestamp: '2026-10-15T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'silver meadow continuation' }] } },
            ].map(row => JSON.stringify(row)).join('\n') + '\n')));
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            fixture.nowMs = Date.now();
            fixture.statCostMs = 3_000;
            vi.spyOn(Date, 'now').mockImplementation(() => fixture.nowMs);
            const read = async (cursor?: string) => ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                params: { machineId: 'fixture-machine', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
                    searchTarget: 'content', searchTerm: 'silver meadow', limit: 1, budgetMs: 15_000, ...(cursor ? { cursor } : {}) },
            }));
            let page = await read();
            expect(page).toMatchObject({ ok: true, contentCoverage: 'partial', nextCursor: expect.any(String) });
            if (!page.ok || !page.nextCursor) throw new Error('Expected resumable discovery');
            const prefix = 'happier_external_cursor_v1:';
            const envelope: unknown = JSON.parse(Buffer.from(page.nextCursor.slice(prefix.length), 'base64url').toString('utf8'));
            expect(envelope).toMatchObject({ m: 'listCandidates', c: expect.any(String) });
            if (!envelope || typeof envelope !== 'object' || !('c' in envelope) || typeof envelope.c !== 'string') throw new Error('Expected native cursor');
            expect(envelope.c.length).toBeGreaterThan(2_000);
            fixture.statCostMs = 0;
            const found = new Set(page.candidates.filter(candidate => candidate.match).map(candidate => candidate.remoteSessionId));
            for (let remaining = ids.length + 1; remaining > 0; remaining--) {
                page = await read(page.nextCursor ?? undefined);
                if (!page.ok) throw new Error(`Continuation failed: ${page.errorCode}`);
                for (const candidate of page.candidates) if (candidate.match) found.add(candidate.remoteSessionId);
                if (!page.nextCursor) break;
            }
            expect([...found].sort()).toEqual(ids.sort());
            expect(page).toMatchObject({ ok: true, nextCursor: null });
        } finally {
            fixture.statCostMs = 0;
            vi.restoreAllMocks();
            await registration?.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });
    it.each(['available', 'unavailable'] as const)('finds real rollout messages in user and connected homes with native listing %s', async native => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-history-'));
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | undefined;
        try {
            fixture.activeServerDir = join(root, 'server');
            fixture.nativeUnavailable = native === 'unavailable';
            // The daemon's observed environment has HOME, with no CODEX_HOME.
            vi.stubEnv('HOME', root);
            vi.stubEnv('CODEX_HOME', undefined);
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            const sources = [{ kind: 'codexHome', home: 'user' }, {
                kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work',
            }] as const;
            const hits: ConversationSearchHit[] = [];
            for (const source of sources) {
                const admitted = await resolveExternalSessionSourceSurface('codex', source, { activeServerDir: fixture.activeServerDir });
                if (!admitted.ok) throw new Error(`Source admission: ${admitted.code}`);
                const home = source.home === 'user' ? join(root, '.codex') : admitted.source.homePath;
                if (typeof home !== 'string') throw new Error('Expected admitted native home');
                const dir = join(home, 'sessions', '2026', '10', '15');
                await mkdir(dir, { recursive: true });
                const id = '019a1234-1234-7123-8123-123456789abc';
                // Codex 0.157+ producer shapes: session_meta and response_item.
                await writeFile(join(dir, `rollout-2026-10-15T10-00-00-${id}.jsonl`), [
                    { type: 'session_meta', timestamp: '2026-10-15T10:00:00.000Z', payload: { id, timestamp: '2026-10-15T10:00:00.000Z', cwd: '/repo', source: 'cli' } },
                    { type: 'response_item', timestamp: '2026-10-15T10:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'An ordinary title' }] } },
                    { type: 'response_item', timestamp: '2026-10-15T10:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found silver meadow in the body.' }] } },
                ].map(row => JSON.stringify(row)).join('\n') + '\n');
                let requestedSource: typeof source | (typeof admitted.source) = source;
                if (source.home === 'connectedService') {
                    // Shared connected homes link the native history root, as
                    // the real profile on the QA machine does.
                    await rename(join(home, 'sessions'), join(root, 'connected-sessions'));
                    await symlink(join(root, '.codex', 'sessions'), join(home, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
                    const homesRoot = join(fixture.activeServerDir, 'daemon', 'connected-services', 'homes');
                    await rename(homesRoot, join(root, 'physical-homes'));
                    await symlink(join(root, 'physical-homes'), homesRoot, process.platform === 'win32' ? 'junction' : 'dir');
                    const physicalHome = await realpath(home);
                    const relocated = await resolveExternalSessionSourceSurface('codex', source, { activeServerDir: fixture.activeServerDir });
                    expect(relocated).toMatchObject({ ok: true, source: { homePath: physicalHome } });
                    if (!relocated.ok) throw new Error('Expected relocated connected source');
                    requestedSource = relocated.source;
                }
                const page = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                    method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                    params: { machineId: 'fixture-machine', agentId: 'codex', source: requestedSource, searchTarget: 'content', searchTerm: 'silver meadow', limit: 5, budgetMs: 30_000 },
                }));
                expect(page).toMatchObject({ ok: true, candidates: [{ remoteSessionId: id,
                    match: { snippet: 'Found silver meadow in the body.', messageIndex: 1, sourceItemId: expect.any(String) } }],
                    contentCoverage: native === 'available' ? 'complete' : 'partial' });
                if (!page.ok) throw new Error('Expected native content page');
                hits.push(...page.candidates.map(candidate => ({ machineId: 'fixture-machine', mode: 'standard' as const,
                    agentId: 'codex', sourceKey: source.home, source: requestedSource, candidate })));
            }
            // Both pages really came through registered RPC/codec/admission over
            // one linked store. Source-specific link data is intentionally distinct.
            expect(hits).toHaveLength(2);
            expect(hits[0]).not.toEqual(hits[1]);
            const merged = mergeConversationSearchHits(hits);
            expect(merged).toHaveLength(1);
            expect(merged[0]).toBe(hits[0]);
        } finally {
            await registration?.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports a connected home that has never been materialized as unavailable, not an invalid plugin result', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-codex-absent-home-'));
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | undefined;
        try {
            fixture.activeServerDir = join(root, 'server');
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            const page = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                params: { machineId: 'fixture-machine', agentId: 'codex',
                    source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'not-launched' },
                    searchTarget: 'content', searchTerm: 'silver meadow', budgetMs: 30_000 },
            }));
            expect(page).toMatchObject({ ok: false, errorCode: 'agent_unavailable', retryable: true });
        } finally { await registration?.dispose(); await rm(root, { recursive: true, force: true }); }
    });
});
