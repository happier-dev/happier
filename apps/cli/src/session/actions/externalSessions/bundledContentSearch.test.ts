// Initialize the real Workflow schema before the SDK during its ongoing Mini migration.
import '@happier-dev/protocol/workflows/workflowV1';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The publication fixture imports fs; load it before replacing that OS boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () => (
    import('@/plugins/projection/registry/builtIn/locators.testkit')
));
import { ExternalSessionCandidateMatchV1Schema, ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineExternalSessionsRpcHandlers } from '@/api/machine/rpcHandlers.externalSessions';

const fixture = vi.hoisted(() => ({ activeServerDir: '', slowPath: '', nowMs: 0,
    slowReads: [] as Array<{ startedAtMs: number; completedAtMs: number }>,
    duringOpen: null as ((path: unknown) => Promise<void>) | null,
    cancelDuringAnnotation: null as (() => void) | null, annotationSignalAborted: false }));
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: { ...actual.configuration, get activeServerDir() { return fixture.activeServerDir; } } };
});
// Real files and codecs are retained; native read latency is charged to a clock.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        await fixture.duringOpen?.(args[0]);
        if (args[0] === fixture.slowPath) {
            const read = handle.read.bind(handle);
            handle.read = (async (...readArgs: Parameters<typeof read>) => {
                const startedAtMs = fixture.nowMs;
                const result = await read(...readArgs);
                // Slow source throughput: small anchor windows do not cost a
                // whole transcript chunk. Descriptor reuse keeps this rate.
                fixture.nowMs += Math.ceil(3_000 * result.bytesRead / (64 * 1024));
                fixture.slowReads.push({ startedAtMs, completedAtMs: fixture.nowMs });
                return result;
            }) as typeof handle.read;
        }
        return handle;
    } };
});

// A synthetic plain Account has no linked sessions. Only credential storage
// and Account HTTP are replaced; ingestion, admission and codecs stay real.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async ({ signal }: { signal?: AbortSignal }) => {
        fixture.cancelDuringAnnotation?.();
        if (fixture.cancelDuringAnnotation) fixture.annotationSignalAborted = signal?.aborted === true;
        return { mode: 'plain' as const };
    },
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return createBundledPluginPublicationFsFixture(actual);
});

// Cold source admission is setup, not part of the first Agent's RPC workload.
await import('@/plugins/testkit/admittedRuntime');

describe('bundled conversation content search', () => {
    it.each(['auggie', 'devin'] as const)('admits %s body hits through the registered candidate RPC and strict consumer schema', async agentId => {
        const { createEnvKeyScope } = await import('@/testkit/env/envScope');
        const env = createEnvKeyScope(['HOME', 'USERPROFILE', 'XDG_DATA_HOME']);
        const root = await mkdtemp(join(tmpdir(), 'auggie-content-rpc-'));
        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
        let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | undefined;
        let nativeDevin: ReturnType<typeof import('../../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support').createDevinNativeFixture> | undefined;
        const pluginId = 'happier.agent.' + agentId;
        const source = { kind: agentId === 'devin' ? 'devinHome' : 'auggieHome' };
        try {
            env.patch({ HOME: root, USERPROFILE: root, XDG_DATA_HOME: join(root, 'data') });
            fixture.activeServerDir = join(root, 'server');
            if (agentId === 'devin') {
                const { createDevinNativeFixture } = await import('../../../../../../packages/plugins/devin/src/agent/externalSessions/__fixtures__/nativeSession.test-support');
                nativeDevin = createDevinNativeFixture(join(root, 'data', 'devin', 'cli'), ['quartz RPC-only phrase 東京 café']);
            } else {
                const { buildAuggieNativeSession } = await import('../../../../../../packages/plugins/auggie/src/agent/surfaces/sessions/external/__fixtures__/nativeSession.test-support');
                const directory = join(root, '.augment', 'sessions');
                await mkdir(directory, { recursive: true });
                await writeFile(join(directory, 'native-session.json'), JSON.stringify(buildAuggieNativeSession(['quartz RPC-only phrase 東京 café'])));
            }
            // Integration H publishes the whole reader batch once. Consume the
            // actual authored declaration through its canonical projector here.
            const { PLUGIN_MANIFEST } = agentId === 'devin' ? await import('@happier-dev/plugins-devin/manifest')
                : await import('@happier-dev/plugins-auggie/manifest');
            const { loadBundledPluginLocatorResult } = await import('@/plugins/projection/registry/builtIn/locators');
            const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
            const { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } = await import('@/plugins/projection/registry/sources/generatedBundledPlugins');
            const { projectLoadedPluginContributes } = await import('@/plugins/projection/registry/fullProjection');
            const { projectBuiltInAgents } = await import('@/plugins/projection/registry/builtIn/agents');
            const projected = projectLoadedPluginContributes({ provenance: 'first_party', loadResult: {
                loadedPlugins: loadBundledPluginLocatorResult(BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.map(locator =>
                    locator.pluginId === pluginId ? { ...locator, manifest: PLUGIN_MANIFEST } : locator)).loadedPlugins,
                diagnosticsByPluginId: {},
            } });
            const contributes = createResolvedContributionRegistry({ ...resolveBuiltInContributions(), ...projected,
                agents: projectBuiltInAgents({ manifestAgents: projected.agents ?? [], registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS }),
                providers: projected.providers ?? [] });
            expect(resolveExternalSessionSourceFromAgentProjection(contributes, agentId, source))
                .toMatchObject({ ok: true, declaration: { contentSearch: true } });
            runtime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: join(root, 'happier'),
                controller: pluginReloadController, runtimeOptions: { contributes, pluginIds: [pluginId] } });
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            const result = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                params: { machineId: 'fixture-machine', agentId, source,
                    searchTarget: 'content', searchTerm: 'quartz RPC-only phrase 東京 café', limit: 50 },
            }));
            expect(result).toMatchObject({ ok: true, contentCoverage: 'complete', candidates: [{ remoteSessionId: 'native-session',
                match: { snippet: expect.stringContaining('quartz RPC-only phrase 東京 café'), sourceItemId: expect.any(String), messageIndex: 0 } }] });
        } finally {
            await registration?.dispose();
            await runtime?.dispose();
            nativeDevin?.close();
            env.restore();
            await rm(root, { recursive: true, force: true });
        }
    });
    it('publishes both source capabilities and admits a real bundled Claude content Action', async () => {
        const contributes = createResolvedContributionRegistry(resolveBuiltInContributions());
        for (const [agentId, source] of [
            ['claude', { kind: 'claudeConfig' }],
            ['codex', { kind: 'codexHome', home: 'user' }],
        ] as const) {
            const projected = resolveExternalSessionSourceFromAgentProjection(contributes, agentId, source);
            expect(projected).toMatchObject({ ok: true, declaration: { contentSearch: true } });
        }

        const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
        const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
        const { executeExternalSessionCandidatesListAction } = await import('./discoveryLinkActions');

        const root = await mkdtemp(join(tmpdir(), 'bundled-content-action-'));
        const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
        let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | null = null;
        try {
            fixture.activeServerDir = join(root, 'server');
            const configDir = join(root, 'claude');
            for (const projectId of ['a-miss', 'b-miss']) {
                await mkdir(join(configDir, 'projects', projectId), { recursive: true });
                await writeFile(join(configDir, 'projects', projectId, 'unrelated.jsonl'), JSON.stringify({
                    type: 'user', uuid: 'unrelated', parentUuid: null,
                    message: { role: 'user', content: 'An unrelated conversation\nwith C:\\work\\example and \\u001b' },
                }) + '\n');
                await utimes(join(configDir, 'projects', projectId, 'unrelated.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
            }
            await mkdir(join(configDir, 'projects', 'zz-recent'), { recursive: true });
            await writeFile(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), [
                { type: 'user', uuid: 'title', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
                { type: 'assistant', uuid: 'body', parentUuid: 'title', message: { role: 'assistant', content: [{ type: 'text', text: 'bundled body-only needle' }] } },
            ].map((row) => JSON.stringify(row)).join('\n') + '\n');
            await utimes(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), new Date('2026-10-01'), new Date('2026-10-01'));
            process.env.CLAUDE_CONFIG_DIR = configDir;
            runtime = await createAdmittedPluginRuntimeFixture({
                happyHomeDir: join(root, 'happier'), controller: pluginReloadController,
                runtimeOptions: { contributes, pluginIds: ['happier.agent.claude'] },
            });
            const result = await executeExternalSessionCandidatesListAction({
                // The production source resolver must honor the invocation's
                // configured native home even when the request omits configDir.
                machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                searchTarget: 'content', searchTerm: 'bundled body-only needle', limit: 50,
            });
            expect(ExternalSessionsCandidatesListResponseSchema.safeParse(result).success).toBe(true);
            expect(result).toMatchObject({ ok: true, contentCoverage: 'complete', candidates: [
                { remoteSessionId: 'session', match: { snippet: 'bundled body-only needle', messageIndex: 1 } },
            ] });

            // A damaged native row must not turn later readable text into a
            // successful zero-hit page at the shared directory prefilter.
            const nulPath = join(configDir, 'projects', 'zz-recent', 'nul.jsonl');
            await writeFile(nulPath, '\0\n' + JSON.stringify({ type: 'assistant', uuid: 'nul-body', parentUuid: null,
                message: { role: 'assistant', content: [{ type: 'text', text: 'test-r101 traced all 23' }] } }) + '\n');
            const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
            registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
            const nulResult = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                params: { machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                    searchTarget: 'content', searchTerm: 'test-r101 traced all 23', limit: 50 },
            }));
            expect(nulResult).toMatchObject({ ok: true, contentCoverage: 'partial', candidates: [{ remoteSessionId: 'nul',
                // The canonical projection retains the unsupported damaged row.
                match: { snippet: 'test-r101 traced all 23', messageIndex: 1 } }], nextCursor: null });

            // Native layout: a completed hit precedes a large escaped JSONL file.
            // The receiving RPC budget must reach Claude through real registration;
            // cancellation alone loses that hit and its Search-more continuation.
            await mkdir(join(configDir, 'projects', 'a-slow'), { recursive: true });
            fixture.slowPath = join(configDir, 'projects', 'a-slow', 'large.jsonl');
            fixture.nowMs = Date.now();
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => fixture.nowMs);
            // A dropped receiving deadline must fail on native read admission
            // even if another native budget still yields a partial page.
            const receivingBudgetMs = 10_000;
            const input = {
                machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                searchTarget: 'content', searchTerm: 'bundled body-only needle',
                budgetMs: receivingBudgetMs,
            };
            await writeFile(fixture.slowPath, Array.from({ length: 1500 }, (_, index) => JSON.stringify({
                type: 'user', uuid: `large-${index}`, parentUuid: index ? `large-${index - 1}` : null,
                message: { role: 'user', content: index === 1499 ? 'bundled body-only needle' : 'ordinary \\text '.repeat(40) },
            })).join('\n') + '\n');
            await utimes(fixture.slowPath, new Date('2026-01-01'), new Date('2026-01-01'));
            const olderPath = join(configDir, 'projects', 'a-slow', 'older.jsonl');
            await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
                message: { role: 'user', content: 'bundled body-only needle' } }) + '\n');
            await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
            const firstDeadlineAtMs = fixture.nowMs + receivingBudgetMs;
            fixture.slowReads = [];
            const first = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            expect(first).toMatchObject({ ok: true, contentCoverage: 'partial', candidates: [
                { remoteSessionId: 'session', match: { messageIndex: 1 } },
            ], nextCursor: expect.any(String) });
            // NI27 removed duration prediction: a native read admitted before
            // the cooperative deadline can finish after it. The receiving budget
            // must still prevent any subsequent read, preserving hits and cursor.
            expect(fixture.slowReads.length).toBeGreaterThan(0);
            expect(fixture.slowReads.every(read => read.startedAtMs < firstDeadlineAtMs)).toBe(true);
            expect(fixture.slowReads.at(-1)!.completedAtMs).toBeGreaterThanOrEqual(firstDeadlineAtMs);
            if (!first.ok) throw new Error('Expected a partial search page');
            // Visited/unrelated appends cannot reset the main frontier. An
            // unvisited file crossing it is reached once in the final T1 pass.
            await writeFile(join(configDir, 'projects', 'a-slow', 'newer.jsonl'), '{}\n');
            await utimes(join(configDir, 'projects', 'a-slow', 'newer.jsonl'), new Date('2026-11-01'), new Date('2026-11-01'));
            await appendFile(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), JSON.stringify({
                type: 'user', uuid: 'follow-up', parentUuid: 'body', message: { role: 'user', content: 'bundled body-only needle' },
            }) + '\n');
            await appendFile(join(configDir, 'projects', 'a-miss', 'unrelated.jsonl'), JSON.stringify({
                type: 'user', uuid: 'unrelated-next', parentUuid: 'unrelated', message: { role: 'user', content: 'ordinary follow-up' },
            }) + '\n');
            fixture.nowMs += 1000;
            await utimes(olderPath, new Date(fixture.nowMs), new Date(fixture.nowMs));
            await utimes(join(configDir, 'projects', 'zz-recent', 'session.jsonl'), new Date(fixture.nowMs), new Date(fixture.nowMs));
            let cursor = first.nextCursor;
            const hits = [...first.candidates];
            for (let page = 0; cursor && page < 30; page += 1) {
                const next = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                    method: 'fixture-machine:daemon.externalSessions.candidates.list',
                    params: { ...input, cursor }, timeoutMs: null,
                }));
                if (!next.ok) throw new Error(`Candidate page failed: ${next.code}`);
                if (page === 0) expect(next.candidates.some(candidate => candidate.remoteSessionId === 'session')).toBe(false);
                hits.push(...next.candidates);
                if (next.nextCursor) {
                    expect(next.contentCoverage).toBe('partial');
                    expect(next.nextCursor).not.toBe(cursor);
                } else expect(next.contentCoverage).toBe('complete');
                cursor = next.nextCursor;
            }
            expect(cursor).toBeNull();
            expect(hits).toMatchObject([
                { remoteSessionId: 'session', match: { messageIndex: 1 } },
                { remoteSessionId: 'large', match: { messageIndex: 1499 } },
                { remoteSessionId: 'older', match: { messageIndex: 0 } },
                { remoteSessionId: 'session', match: { messageIndex: 1 } },
            ]);
            // Annotation is optional enrichment of an already decoded native
            // page. A transport cancellation here must not replace found hits.
            await utimes(fixture.slowPath, new Date('2026-01-01'), new Date('2026-01-01'));
            await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
            const beforeAnnotationCancellation = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            if (!beforeAnnotationCancellation.ok) throw new Error('Expected a found partial native page');
            expect(beforeAnnotationCancellation).toMatchObject({ contentCoverage: 'partial',
                candidates: [{ remoteSessionId: 'session' }], nextCursor: expect.any(String) });
            fixture.cancelDuringAnnotation = () => rpc.onSocketDisconnect();
            const annotationCancelled = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.candidates.list', params: input, timeoutMs: null,
            }));
            expect(fixture.annotationSignalAborted).toBe(true);
            expect(annotationCancelled).toMatchObject({ ok: true,
                candidates: beforeAnnotationCancellation.candidates,
                nextCursor: expect.any(String),
                contentCoverage: 'partial', annotationsIncomplete: true });
            fixture.cancelDuringAnnotation = null;
            clock.mockRestore();
            fixture.slowPath = '';
            // Census-equivalent inventory only: no private text or 3.32 GB of
            // native bodies is needed to reproduce the cursor admission defect.
            const scaleConfigDir = join(root, 'scale');
            const projects = Array.from({ length: 84 }, (_, index) => `synthetic-project-${index}-${'p'.repeat(32)}`);
            await Promise.all(projects.map(project => mkdir(join(scaleConfigDir, 'projects', project), { recursive: true })));
            await Promise.all(Array.from({ length: 661 }, (_, index) => writeFile(
                join(scaleConfigDir, 'projects', projects[index % projects.length]!, `native-session-${index}-${'s'.repeat(24)}.jsonl`),
                JSON.stringify({ type: 'user', uuid: 'scale-user', parentUuid: null,
                    message: { role: 'user', content: 'synthetic scale needle' } }) + '\n',
            )));
            process.env.CLAUDE_CONFIG_DIR = scaleConfigDir;
            const opened = new Map<string, number>();
            // Shape-equivalent 84-project/661-file live corpus. Every selected
            // file appends bookkeeping between its snapshot anchor and decoder
            // read, including fresh and between-file continuation requests.
            fixture.duringOpen = async path => {
                if (typeof path !== 'string' || !path.startsWith(`${scaleConfigDir}/`)) return;
                const count = (opened.get(path) ?? 0) + 1;
                opened.set(path, count);
                if (count === 2) await appendFile(path, JSON.stringify({ type: 'cost-state', totalCostUSD: 0 }) + '\n');
            };
            const scaleHits = new Set<string>();
            let scaleCursor: string | null = null;
            for (let page = 0; page < 3; page += 1) {
                const result = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
                    method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
                    params: { machineId: 'fixture-machine', agentId: 'claude', source: { kind: 'claudeConfig' },
                        searchTarget: 'content', searchTerm: 'synthetic scale needle', limit: 1,
                        ...(scaleCursor ? { cursor: scaleCursor } : {}) },
                }));
                if (!result.ok) throw new Error(`Scale page failed: ${result.code}`);
                for (const candidate of result.candidates) {
                    expect(candidate.match?.snippet).toContain('synthetic scale needle');
                    expect(scaleHits.has(candidate.remoteSessionId)).toBe(false);
                    scaleHits.add(candidate.remoteSessionId);
                }
                expect(result.candidates).toHaveLength(1);
                expect(result.nextCursor).toEqual(expect.any(String));
                expect(result.nextCursor!.length).toBeLessThanOrEqual(4096);
                expect(result.nextCursor).not.toBe(scaleCursor);
                // Candidate metadata is additive-open; its match envelope is strict.
                expect(ExternalSessionCandidateMatchV1Schema.safeParse({ ...result.candidates[0]!.match, unexpected: true }).success).toBe(false);
                expect(ExternalSessionsCandidatesListResponseSchema.safeParse({ ...result, nextCursor: {} }).success).toBe(false);
                scaleCursor = result.nextCursor ?? null;
            }
            expect(scaleHits.size).toBe(3);
            expect([...opened.values()].filter(count => count >= 2).length).toBeGreaterThanOrEqual(3);
        } finally {
            fixture.duringOpen = null;
            fixture.slowPath = '';
            fixture.cancelDuringAnnotation = null;
            fixture.annotationSignalAborted = false;
            vi.restoreAllMocks();
            await registration?.dispose();
            await runtime?.dispose();
            if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
            else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
            await rm(root, { recursive: true, force: true });
        }
    });
});
