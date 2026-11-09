import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { MemoryStatusV1Schema } from '@happier-dev/protocol/memory/memoryStatus';
import { MemorySearchResultV1Schema } from '@happier-dev/protocol/memory/memorySearch';
import { ComposerSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { DaemonWorkspaceFileSearchRequestSchema, DaemonWorkspaceFileSearchResponseSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { DaemonLspQueryRequestSchema, DaemonLspQueryResponseSchema, DaemonLspSyncRequestSchema,
    DaemonLspWatchRequestSchema, DaemonLspRestartRequestSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { ExternalSessionCandidateMatchV1Schema, ExternalSessionsCandidatesListRequestSchema,
    ExternalSessionsCandidatesListResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createDeferred, PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, standardCleanup } from '@/dev/testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Reuse the Action-family's HTTP/Socket boundary kit. Admission, scoped RPC,
// native transcript decoding, schemas and the app executor remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected daemon request'); };
const requests = installSessionActionRpcBoundary(request => answerRpc(request));
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
const { searchConversations } = await import('@/sync/domains/search/searchConversations');
const { storage } = await import('@/sync/domains/state/storage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { recordMachineRequestFailed, isMachineReachable, clearMachineRequestReachabilityForTest } =
    await import('@/sync/domains/machines/reachability/machineReachability');
const { listClaudeExternalSessionCandidates } = await import('../../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/candidates');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
let corpusRoot: string | undefined;

beforeEach(async () => {
    clearMachineRequestReachabilityForTest();
    await homes.reset();
    requests.length = 0;
    serverId = await homes.addHome({ name: 'FSP Action Home', serverUrl: 'https://fsp-actions.test', accountId: 'fsp-account' });
    const machine = createPlainMachineRowFixture({ id: 'fsp-machine', accountId: 'fsp-account' });
    homes.answer(serverId, '/v1/machines/fsp-machine', { body: { machine } });
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fsp-actions.test', accountId: 'fsp-account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    if (corpusRoot) await rm(corpusRoot, { recursive: true, force: true });
    corpusRoot = undefined;
});

describe('FSP search production composition', () => {
    it('returns native failures beside successful hits through the registered Action and strict Agent/MCP contract', async () => {
        const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            agentsById: Object.fromEntries(['failed', 'healthy'].map(id => [`acme.${id}`, {
                id: `acme.${id}`, title: id, identity: { pluginId: 'acme.review', localId: id },
                externalSessions: { agent: { pluginId: 'acme.review', localId: id }, generation: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.generation,
                    operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                    sources: [{ sourceKind: id, contentSearch: true, schema: { fields: [{ name: 'kind', kind: 'literal', value: id }] },
                        key: { segments: [{ kind: 'literal', value: id }] }, instances: [{ kind: 'default', constants: {} }] }],
                },
            }])) });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            experiments: true, featureToggles: { 'memory.search': true },
        } }, version: 1 } });
        answerRpc = request => {
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)) return { protocolVersion: 1, projection };
            if (request.method.endsWith(`:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`)) return DEFAULT_MEMORY_SETTINGS;
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`);
            const input = ExternalSessionsCandidatesListRequestSchema.parse(request.params);
            return ExternalSessionsCandidatesListResponseSchema.parse(input.source.kind === 'failed'
                ? { ok: false, errorCode: 'agent_error', retryable: true, error: 'private native path' }
                : { ok: true, candidates: [{ remoteSessionId: 'healthy-hit', updatedAtMs: 1,
                    match: { snippet: 'needle', sourceItemId: 'message', messageIndex: 0 } }], contentCoverage: 'complete' });
        };
        const action = await createDefaultActionExecutor().execute('search.conversations', {
            machineIds: ['fsp-machine'], mode: 'standard', retryUnreachableMachines: true,
            query: { v: 1, query: 'needle', mode: 'auto', scope: { type: 'global' }, corpora: ['external_transcripts'] },
        }, { surface: 'ui', serverId, expectedAccountId: 'fsp-account' });
        expect(action).toMatchObject({ ok: true, result: { hits: [{ agentId: 'acme.healthy' }], failures: [{ machineId: 'fsp-machine',
            agentId: 'acme.failed', sourceKey: 'failed', errorCode: 'agent_error', retryable: true }] } });
        if (!action.ok || !action.result || typeof action.result !== 'object') throw new Error('Search Action unavailable');
        const spec = getActionSpec('search.conversations');
        expect(spec.outputSchema!.parse(action.result)).toEqual(action.result);
        expect(spec.outputSchema!.safeParse({ ...action.result, failures: [{ machineId: 'fsp-machine', agentId: 'acme.failed',
            sourceKey: 'failed', errorCode: 'agent_error', retryable: 'true' }] }).success).toBe(false);
        expect(spec).toMatchObject({ surfaces: { agent: true, mcp: true }, bindings: { mcpToolName: 'search_conversations' } });
    });
    it('keeps picker MCP admission scoped to the mounted composer and retires it on unmount', async () => {
        const executor = createDefaultActionExecutor();
        const context = {
            surface: 'mcp', serverId, expectedAccountId: 'fsp-account',
        } as const;
        const result = await executor.execute('ui.prompts.picker.open', {}, context);
        expect(result).toEqual({ ok: true, result: { status: 'noEligibleComposer' } });
        if (!result.ok) throw new Error('Picker Action unavailable');
        expect(getActionSpec('ui.prompts.picker.open').outputSchema!.parse(result.result))
            .toEqual({ status: 'noEligibleComposer' });
        const snapshot = ComposerSnapshotV1Schema.parse({ revision: 1,
            ref: { kind: 'session', sessionId: 'mounted-session' }, text: 'Private draft',
            references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: false, attachments: false, submit: true },
            state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
        });
        let pickerOpen = false;
        const unregister = registerSessionComposerPresentationTarget({ serverId, sessionId: 'mounted-session' }, {
            readRevision: () => snapshot.revision,
            replace: () => { throw new Error('Opening the picker must not edit the draft'); },
            readSnapshot: () => snapshot,
            readScope: () => ({ serverId, accountId: 'fsp-account' }),
            // The mounted input is the UI boundary; registry, admission and executor stay real.
            openPromptPicker: () => { pickerOpen = true; return true; },
        });
        try {
            const opened = await executor.execute('ui.prompts.picker.open', { composerRef: snapshot.ref }, context);
            expect(opened).toEqual({ ok: true, result: { status: 'opened', composerRef: snapshot.ref } });
            expect(pickerOpen).toBe(true);
            if (!opened.ok) throw new Error('Mounted picker Action unavailable');
            expect(getActionSpec('ui.prompts.picker.open').outputSchema!.parse(opened.result)).toEqual(opened.result);
        } finally { unregister(); }
        expect(await executor.execute('ui.prompts.picker.open', { composerRef: snapshot.ref }, context))
            .toEqual({ ok: true, result: { status: 'noEligibleComposer' } });
    });
    it('recovers an unreachable Machine only on explicit retry through the registered search Action', async () => {
        const machine = { ...createPlainMachineRowFixture({ id: 'fsp-machine', accountId: 'fsp-account' }),
            active: false, activeAt: 1 };
        homes.answer(serverId, '/v1/machines', { body: [machine] });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            featureToggles: { 'memory.search': true },
        } }, version: 1 } });
        installSessionActionFixture({ homes, storage, serverId,
            session: { id: 'recovered-session', encryptionMode: 'plain', seq: 7 } });
        answerRpc = request => {
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_MEMORY_STATUS}`) return MemoryStatusV1Schema.parse({
                v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true, deepIndexReady: true,
                activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
                embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
                embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
                tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null,
            });
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_MEMORY_SEARCH}`);
            return MemorySearchResultV1Schema.parse({ v: 1, ok: true, hits: [{ sessionId: 'recovered-session',
                seqFrom: 7, seqTo: 7, createdAtFromMs: 1, createdAtToMs: 1, summary: 'needle', score: 1 }] });
        };
        const executor = createDefaultActionExecutor();
        const input = { machineIds: ['fsp-machine'], mode: 'indexed', query: {
            v: 1, query: 'needle', scope: { type: 'global' }, mode: 'auto', corpora: ['sessions'],
        } };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'fsp-account' };
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        // A previous target-unavailable reply remains authoritative until an explicit probe succeeds.
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        expect(isMachineReachable(scope, machine)).toBe(false);
        // An unreachable Machine is not asked for its settings, so its standard-search state stays unknown.
        expect(await executor.execute('search.conversations', input, context)).toEqual({ ok: true,
            result: expect.objectContaining({ machines: [{ machineId: 'fsp-machine', status: 'offline' }] }) });
        const retried = await executor.execute('search.conversations', { ...input, retryUnreachableMachines: true }, context);
        expect(retried).toMatchObject({ ok: true,
            result: { machines: [{ machineId: 'fsp-machine', status: 'ok', standardSearchEnabled: true }],
                hits: [{ machineId: 'fsp-machine', hit: { sessionId: 'recovered-session', summary: 'needle' } }] } });
        if (!retried.ok) throw new Error('Explicit search retry unavailable');
        expect(getActionSpec('search.conversations').outputSchema!.parse(retried.result)).toEqual(retried.result);
    });
    it('executes text-in-files through the registered app Action and strict daemon transport', async () => {
        const page = DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, hasMore: true, coverage: 'partial',
            files: [{ path: 'src/emoji.ts', matches: [{ line: 7, column16: 3, length16: 6,
                text: '😀 needle', before: ['before'], after: ['after'] }] }] });
        if (!page.ok) throw new Error('Expected a workspace search page');
        let misbound = false;
        answerRpc = request => {
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`);
            expect(DaemonWorkspaceFileSearchRequestSchema.parse(request.params))
                .toMatchObject({ rootPath: '/repo', query: 'needle' });
            return misbound ? { ...page, matches: page.files } : page;
        };
        const executor = createDefaultActionExecutor();
        const input = { machineId: 'fsp-machine', rootPath: '/repo', query: 'needle' };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'fsp-account' };
        const result = await executor.execute('workspace.files.search', input, context);
        expect(result).toEqual({ ok: true, result: page });
        if (!result.ok) throw new Error('Workspace search Action unavailable');
        expect(getActionSpec('workspace.files.search').outputSchema!.parse(result.result)).toEqual(page);
        // Bind the same transport to an invalid producer shape once: strict consumer rejects it.
        misbound = true;
        await expect(executor.execute('workspace.files.search', input, context))
            .resolves.toMatchObject({ ok: false, errorCode: 'workspace_file_search_unavailable' });
    });

    it('shares code name search between the app Action and UI operation and preserves transport failures', async () => {
        const page = DaemonWorkspaceFileSearchResponseSchema.parse({ ok: true, hasMore: false, coverage: 'complete',
            files: [{ path: 'src/a.ts', matches: [{ line: 7, column16: 1, length16: 6,
                text: 'needle()', before: [], after: [] }] }] });
        answerRpc = request => {
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_LSP_QUERY}`) return { status: 'unavailable', reason: 'no_capable_server' };
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH}`);
            const input = DaemonWorkspaceFileSearchRequestSchema.parse(request.params);
            expect(input).toMatchObject({ rootPath: '/repo', regex: true, matchCase: true });
            expect(new RegExp(input.query, 'u').test('needle()')).toBe(true);
            return page;
        };
        const context = { surface: 'ui' as const, serverId, expectedAccountId: 'fsp-account' };
        const query = { rootPath: '/repo', path: 'src/a.ts', line: 7, symbol: 'needle', kind: 'references' as const };
        const executor = createDefaultActionExecutor();
        const { kind: _kind, ...actionInput } = query;
        const result = await executor.execute('code.references.list', { machineId: 'fsp-machine', ...actionInput }, context);
        expect(result).toMatchObject({ ok: true, result: { status: 'ok', source: 'text_matches', locations: [{ path: 'src/a.ts' }] } });
        const { machineCodeIntelligenceFallback } = await import('../machineLanguageIntelligence');
        const uiResult = await machineCodeIntelligenceFallback('fsp-machine', query, { serverId, accountId: 'fsp-account' });
        if (!result.ok) throw new Error('Code Action unavailable');
        expect(uiResult).toEqual(result.result);
        expect(getActionSpec('code.references.list').outputSchema!.parse(result.result)).toEqual(result.result);
        answerRpc = () => { throw Object.assign(new Error('missing'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }); };
        expect(await machineCodeIntelligenceFallback('fsp-machine', query, { serverId, accountId: 'fsp-account' }))
            .toEqual({ status: 'unavailable', reason: 'update_required' });
    });

    it('uses disk authority for semantic Actions and preserves typed cold, unsaved and older-host results', async () => {
        const diskHash = 'a'.repeat(64);
        const answer = DaemonLspQueryResponseSchema.parse({ status: 'ok', kind: 'hover', fileHash: diskHash,
            sections: [{ serverId: 'typescript', label: 'TypeScript', markdown: 'function needle(): void' }] });
        let response: unknown = answer;
        answerRpc = request => {
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_LSP_QUERY}`);
            expect(DaemonLspQueryRequestSchema.parse(request.params)).toEqual({ rootPath: '/repo', path: 'src/a.ts',
                kind: 'hover', text: 'disk', position: { line: 2, symbol: 'needle', occurrence: 2 } });
            return response;
        };
        const execute = () => createDefaultActionExecutor().execute('code.hover.get', { machineId: 'fsp-machine',
            rootPath: '/repo', path: 'src/a.ts', line: 3, symbol: 'needle', occurrence: 2 },
        { surface: 'ui', serverId, expectedAccountId: 'fsp-account' });
        expect(await execute()).toEqual({ ok: true, result: answer });
        response = { status: 'loading' };
        expect(await execute()).toEqual({ ok: true, result: response });
        response = { status: 'error', errorCode: 'unsaved_editor_changes', diskHash };
        expect(await execute()).toEqual({ ok: true, result: response });
        response = { ...answer, fileHash: undefined };
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'invalid_response' });
        answerRpc = () => { throw Object.assign(new Error('missing'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }); };
        expect(await execute()).toEqual({ ok: true, result: { status: 'unavailable', reason: 'update_required' } });
    });

    it('keeps document operations scoped and routes present-user restart through its Action', async () => {
        const ops = await import('../machineLanguageIntelligence');
        const options = { serverId, accountId: 'fsp-account' };
        answerRpc = request => {
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_LSP_SYNC}`) {
                expect(DaemonLspSyncRequestSchema.parse(request.params)).toMatchObject({ rootPath: '/repo',
                    op: { op: 'open', path: 'src/a.ts', text: 'needle()', unsaved: false, version: 1 } });
                return { status: 'ok', generation: 'g1', version: 1, servers: [] };
            }
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_LSP_WATCH}`) {
                expect(DaemonLspWatchRequestSchema.parse(request.params)).toEqual({ rootPath: '/repo', sinceRevision: 0 });
                return { status: 'ok', revision: 1, servers: [], diagnostics: {} };
            }
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_LSP_RESTART}`);
            expect(DaemonLspRestartRequestSchema.parse(request.params)).toEqual({ rootPath: '/repo', serverId: 'typescript' });
            return { status: 'ok' };
        };
        expect(await ops.machineLanguageIntelligenceSync('fsp-machine', { rootPath: '/repo', op: { op: 'open',
            path: 'src/a.ts', languageId: 'typescript', version: 1, text: 'needle()', unsaved: false } }, options))
            .toMatchObject({ status: 'ok', generation: 'g1', version: 1 });
        expect(await ops.machineLanguageIntelligenceWatch('fsp-machine', { rootPath: '/repo', sinceRevision: 0 }, options))
            .toEqual({ status: 'ok', revision: 1, servers: [], diagnostics: {} });
        expect(await ops.machineLanguageIntelligenceRestartAction('fsp-machine', { rootPath: '/repo', serverId: 'typescript' }, options))
            .toEqual({ status: 'ok' });
    });

    it('finds body-only native text through real sources and keeps a published page stable while another source waits', async () => {
        corpusRoot = await mkdtemp(join(tmpdir(), 'fsp-native-search-'));
        const makeSource = async (name: string, count: number) => {
            const configDir = join(corpusRoot!, name);
            const directory = join(configDir, 'projects', 'project');
            await mkdir(directory, { recursive: true });
            for (let index = 0; index < count; index++) {
                const rows = [
                    { type: 'user', uuid: 'title', parentUuid: null, message: { role: 'user', content: 'An unrelated title' } },
                    { type: 'assistant', uuid: 'body', parentUuid: 'title', message: { role: 'assistant',
                        content: [{ type: 'text', text: 'Body-only café\nwith "quotes"' }] } },
                ];
                await writeFile(join(directory, `${name}-${index}.jsonl`), rows.map(row => JSON.stringify(row).replace(/é/g, '\\u00e9')).join('\n') + '\n');
            }
            return { agentId: 'claude', sourceKey: name, source: { kind: 'claudeConfig' as const, configDir, projectId: 'project' }, contentSearch: true };
        };
        const sources = [await makeSource('fast', 2), await makeSource('slow', 1)];
        const slow = createDeferred<void>();
        const controller = new AbortController();
        const pages: Awaited<ReturnType<typeof searchConversations>>[] = [];
        let firstSourceMatch: ReturnType<typeof ExternalSessionCandidateMatchV1Schema.parse> | undefined;
        answerRpc = async request => {
            if (request.method === `fsp-machine:${RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET}`) return { ...DEFAULT_MEMORY_SETTINGS, enabled: false };
            expect(request.method).toBe(`fsp-machine:${RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST}`);
            const query = ExternalSessionsCandidatesListRequestSchema.parse(request.params);
            if (query.source.kind !== 'claudeConfig') throw new Error('Wrong native source binding');
            const selectedSource = sources.find(source => source.source.configDir === query.source.configDir);
            if (!selectedSource) throw new Error('Unknown native source binding');
            if (query.source.configDir === sources[1].source.configDir) await slow.promise;
            const native = await listClaudeExternalSessionCandidates({ source: selectedSource.source, env: { NODE_ENV: 'test' },
                limit: 1, searchTerm: query.searchTerm, searchTarget: query.searchTarget, cursor: query.cursor,
                // The OS process is external; every native file read and codec is real.
                ripgrep: { run: async ({ paths }) => ({ exitCode: 0, stdout: paths.join('\0') + '\0', stderr: '' }) } });
            for (const candidate of native.candidates) {
                const match = ExternalSessionCandidateMatchV1Schema.parse(candidate.match);
                expect(match).toMatchObject({ sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 1,
                    snippet: expect.stringContaining('café\nwith "quotes"') });
                expect(candidate.title).not.toContain('café');
                if (query.source.configDir === sources[0].source.configDir) firstSourceMatch = match;
                expect(ExternalSessionCandidateMatchV1Schema.safeParse({ ...match, seq: 99 }).success).toBe(false);
            }
            return ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, ...native });
        };
        const pending = searchConversations({ serverId, accountId: 'fsp-account',
            machines: [{ id: 'fsp-machine', online: true }], mode: 'standard', signal: controller.signal,
            query: { v: 1, query: 'café\nwith "quotes"', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
            readSources: async () => sources, onProgress: page => pages.push(page) });
        try {
            await vi.waitFor(() => expect(pages.some(page => page.hits.length === 1)).toBe(true));
            const first = pages.find(page => page.hits.length === 1)!;
            expect(firstSourceMatch).toBeDefined();
            expect(first.hits[0]).toMatchObject({ mode: 'standard', sourceKey: 'fast', candidate: { match: firstSourceMatch } });
            expect(first.continuations).toEqual([{ machineId: 'fsp-machine', sourceKey: 'fast', cursor: expect.any(String) }]);
            expect(first.machines[0]).toMatchObject({ status: 'partial' });
            slow.resolve();
            expect((await pending).hits).toHaveLength(2);
            expect(first.hits).toHaveLength(1);
            expect(first.continuations).toHaveLength(1);
            // A source whose content capability is mis-bound must not produce native body hits.
            const unsupported = await searchConversations({ serverId, accountId: 'fsp-account',
                machines: [{ id: 'fsp-machine', online: true }], mode: 'standard',
                query: { v: 1, query: 'café', scope: { type: 'global' }, mode: 'auto', corpora: ['external_transcripts'] },
                readSources: async () => sources.map(source => ({ ...source, contentSearch: false })) });
            expect(unsupported.hits).toEqual([]);
            expect(unsupported.machines[0]).toMatchObject({ status: 'partial' });
        } finally { slow.resolve(); controller.abort(); await pending.catch(() => undefined); }
    });
});
