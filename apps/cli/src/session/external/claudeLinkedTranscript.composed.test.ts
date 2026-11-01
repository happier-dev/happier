import '@happier-dev/protocol/workflows/workflowV1';
import '../../../../ui/sources/dev/vitestSetup';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExternalSessionLinkEnsureResponseSchema, ExternalSessionsCandidatesListResponseSchema, ExternalSessionTranscriptPageResponseSchema, ExternalSessionTranscriptReadAfterResponseSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol/sessions/external/sourceCatalog';
import { readInitialTranscriptSourceWindow } from '@happier-dev/agents';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { parseStableSessionMessageRouteId } from '@happier-dev/session-core/messages';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineExternalSessionsRpcHandlers } from '@/api/machine/rpcHandlers.externalSessions';
import { logger } from '@/ui/logger';

const boundary = vi.hoisted(() => ({ activeServerDir: '', linkedMetadata: null as Record<string, unknown> | null,
    page: null as null | ((request: unknown) => Promise<unknown>) }));
// Machine RPC is the genuine process boundary. Sync, state, normalization,
// the read-only history source and Find remain the actual UI owners.
vi.mock('../../../../ui/sources/sync/ops/machineExternalSessions', async importOriginal => ({
    ...await importOriginal<typeof import('../../../../ui/sources/sync/ops/machineExternalSessions')>(),
    machineExternalSessionTranscriptPage: async (request: unknown) => {
        if (!boundary.page) throw new Error('Missing registered transcript transport');
        return await boundary.page(request);
    },
}));
vi.mock('@/configuration', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/configuration')>();
    return { ...actual, configuration: { ...actual.configuration, get activeServerDir() { return boundary.activeServerDir; } } };
});
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readSettings: async () => ({ memory: { v: 1, enabledAtMs: 1 } }),
    readStoredCredentials: async () => ({ token: 'fixture-token', encryption: null }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: async () => ({ mode: 'plain' as const }),
}));
// Account HTTP is the genuine boundary. Native discovery, link identity,
// metadata construction, plugin admission and transcript parsing remain real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    return { ...actual,
        fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
        lookupSessionsByTags: async ({ tags }: { tags: readonly string[] }) => ({ state: 'available' as const, tags, sessions: [] }),
        getOrCreateSessionByTag: async ({ metadata }: Parameters<typeof actual.getOrCreateSessionByTag>[0]) => {
            boundary.linkedMetadata = metadata;
            return { session: createSessionRecordFixture({ id: 'linked-session', encryptionMode: 'plain', currentStorageState: 'machine_only' }), created: true };
        },
    };
});
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
    return createBundledPluginPublicationFsFixture(actual);
});

// Resolve the cross-package graph at collection, outside the test operation.
const syncPath = '../../../../ui/sources/sync/syncEngine';
const statePath = '../../../../ui/sources/sync/domains/state/storage';
const fixturesPath = '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
const serverPath = '../../../../ui/sources/sync/domains/server/serverRuntime';
const linkPath = '../../../../ui/sources/sync/domains/session/external/readExternalSessionLink';
const sourcePath = '../../../../ui/sources/components/sessions/transcript/source/readOnlySessionTranscriptSource';
const findPath = '../../../../ui/sources/components/sessions/transcript/find/useTranscriptFind';
const { sync } = await import(syncPath) as typeof import('../../../../ui/sources/sync/syncEngine');
const { storage } = await import(statePath) as typeof import('../../../../ui/sources/sync/domains/state/storage');
const { createSessionFixture } = await import(fixturesPath) as typeof import('../../../../ui/sources/dev/testkit/fixtures/sessionFixtures');
const { getActiveServerSnapshot } = await import(serverPath) as typeof import('../../../../ui/sources/sync/domains/server/serverRuntime');
const { readExternalSessionLink } = await import(linkPath) as typeof import('../../../../ui/sources/sync/domains/session/external/readExternalSessionLink');
const { createReadOnlySessionTranscriptSource } = await import(sourcePath) as typeof import('../../../../ui/sources/components/sessions/transcript/source/readOnlySessionTranscriptSource');
const { createTranscriptFindModel } = await import(findPath) as typeof import('../../../../ui/sources/components/sessions/transcript/find/useTranscriptFind');

it('keeps a linked native Claude transcript readable, pageable and searchable across an unknown record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-linked-transcript-'));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let registration: ReturnType<typeof registerMachineExternalSessionsRpcHandlers> | undefined;
    try {
        boundary.activeServerDir = join(root, 'server');
        boundary.linkedMetadata = null;
        const projectDir = join(root, 'projects', 'native-project');
        await mkdir(projectDir, { recursive: true });
        // Synthetic equivalent of the failing native session: no private text,
        // but the same parent-linked user, thinking, final answer and bookkeeping.
        const rows = [
            ...Array.from({ length: 405 }, (_, index) => ({ type: 'user', uuid: `history-${index}`,
                parentUuid: index === 0 ? null : index === 13 ? 'image-result' : `history-${index - 1}`,
                message: { role: 'user', content: index === 12 ? 'older fixture needle' : `fixture history ${index}` } }))
                .flatMap<unknown>((row, index) => index !== 12 ? [row] : [row, {
                    type: 'assistant', uuid: 'image-read', parentUuid: row.uuid,
                    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read-image', name: 'Read', input: { file_path: '/fixture/image.png' } }] },
                }, {
                    // C22 native shape: image tool-result plus its duplicated
                    // native metadata; all bytes and text here are synthetic.
                    type: 'user', uuid: 'image-result', parentUuid: 'image-read',
                    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-image', content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(628_392) } },
                    ] }] },
                    toolUseResult: { type: 'image', file: { base64: 'A'.repeat(628_392), type: 'image/png' } },
                }]),
            { type: 'queue-operation', operation: 'enqueue', sessionId: 'native', content: 'fixture prompt' },
            { type: 'user', uuid: 'prompt', parentUuid: 'history-404', isSidechain: false, timestamp: '2026-10-14T03:56:07.827Z', message: { role: 'user', content: 'fixture prompt' } },
            { type: 'attachment', uuid: 'attachment', parentUuid: 'prompt', attachment: { type: 'context', content: 'fixture context' } },
            { type: 'assistant', uuid: 'thinking', parentUuid: 'attachment', timestamp: '2026-10-14T03:56:12.721Z', message: { role: 'assistant', type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'fixture-signature' }] } },
            { type: 'future-transcript-message', uuid: 'future', parentUuid: 'thinking', privateContent: 'unknown private payload' },
            { type: 'assistant', uuid: 'answer', parentUuid: 'future', timestamp: '2026-10-14T03:56:13.366Z', message: { role: 'assistant', type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'fixture answer needle' }] } },
            { type: 'system', subtype: 'stop_hook_summary', uuid: 'stop', parentUuid: 'answer' },
            { type: 'cost-state', sessionId: 'native', totalCostUSD: 0, modelUsage: {}, hasUnknownModelCost: false },
            { type: 'atis-latch', sessionId: 'native', atis: 'fixture bookkeeping' },
        ];
        await writeFile(join(projectDir, 'native.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        process.env.CLAUDE_CONFIG_DIR = root;
        runtime = await createAdmittedPluginRuntimeFixture({
            happyHomeDir: join(root, 'happier'), controller: pluginReloadController,
            runtimeOptions: { contributes: createResolvedContributionRegistry(resolveBuiltInContributions()), pluginIds: ['happier.agent.claude'] },
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'fixture-machine', encryptionMode: 'plain' });
        registration = registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpc });
        const source = { kind: 'claudeConfig' };
        const target = { machineId: 'fixture-machine', agentId: 'claude', source };
        const candidates = ExternalSessionsCandidatesListResponseSchema.parse(await rpc.handleRequest({
            method: 'fixture-machine:daemon.externalSessions.candidates.list', timeoutMs: null,
            params: { ...target, searchTarget: 'content', searchTerm: 'fixture answer needle' },
        }));
        if (!candidates.ok) throw new Error(JSON.stringify(candidates));
        expect(candidates.candidates).toHaveLength(1);
        const candidate = candidates.candidates[0]!;
        expect(candidate.match).toMatchObject({ snippet: 'fixture answer needle', sourceItemId: expect.any(String) });
        const linked = ExternalSessionLinkEnsureResponseSchema.parse(await rpc.handleRequest({
            method: 'fixture-machine:daemon.externalSessions.link.ensure', timeoutMs: null,
            params: { ...target, remoteSessionId: candidate.remoteSessionId, linkData: candidate.linkData },
        }));
        if (!linked.ok) throw new Error(JSON.stringify(linked));
        expect(linked.sessionId).toBe('linked-session');
        const linkedMetadata: unknown = Reflect.get(boundary, 'linkedMetadata');
        expect(linkedMetadata).toMatchObject({ externalSessionV1: { remoteSessionId: 'native', source: { kind: 'claudeConfig', projectId: 'native-project' } } });
        if (!linkedMetadata || typeof linkedMetadata !== 'object' || !('externalSessionV1' in linkedMetadata)) throw new Error('Expected persisted link metadata');
        const linkedRecord = linkedMetadata.externalSessionV1;
        if (!linkedRecord || typeof linkedRecord !== 'object' || !('source' in linkedRecord)) throw new Error('Expected persisted link source');
        const linkedSource = ExternalSessionsSourceSchema.parse(linkedRecord.source);
        const readPage = async (cursor?: string) => {
            const response = ExternalSessionTranscriptPageResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.transcript.page', timeoutMs: null,
                params: { ...target, source: linkedSource, remoteSessionId: candidate.remoteSessionId, direction: 'older', maxItems: 200,
                    ...(cursor ? { cursor } : {}) },
            }));
            if (!response.ok) throw new Error(JSON.stringify({ response,
                diagnostics: sourceLog.mock.calls.filter(call => call[0] === '[externalSessions][agent_failure]') }));
            return { ...response, nextCursor: response.nextCursor ?? null, tailCursor: response.tailCursor ?? null,
                truncated: response.truncated === true };
        };
        const sourceLog = vi.spyOn(logger, 'debug');
        const page = await readPage();
        const sourceLogCalls = [...sourceLog.mock.calls];
        expect(sourceLogCalls).toContainEqual(['[externalSessions][agent_failure]', expect.objectContaining({
            code: 'unsupported_record', reason: 'transcript_unsupported_record',
        })]);
        expect(page.hasMore).toBe(true);
        expect(page.truncated).toBe(false);
        const published: typeof page.items = [];
        // This is the same initial-window owner the real Session Sync reader
        // calls, including its discontinuity admission before publication.
        const window = await readInitialTranscriptSourceWindow({
            pageOlder: () => readPage(),
            readAfter: async () => { throw new Error('The producer must provide an anchored tail'); },
            onPageItems: value => { published.push(...value.items); },
        });
        expect(window.truncated).toBe(false);
        expect(window.hasMoreOlder).toBe(true);
        expect(window.olderCursor).toEqual(expect.any(String));
        expect(JSON.stringify(published)).toContain('fixture answer needle');
        const link = readExternalSessionLink(boundary.linkedMetadata);
        if (!link) throw new Error('Expected the real persisted link');
        let machinePages = 0;
        let failNextPage = false;
        boundary.page = async request => {
            machinePages += 1;
            if (failNextPage) { failNextPage = false; throw new Error('Synthetic machine transport unavailable'); }
            return ExternalSessionTranscriptPageResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.transcript.page', timeoutMs: null, params: request,
            }));
        };
        const server = getActiveServerSnapshot();
        Reflect.set(sync, 'appliedServerTarget', server);
        storage.getState().activateProfileScope({ serverId: server.serverId, accountId: 'fixture-account' });
        storage.getState().applySessions([createSessionFixture({ id: linked.sessionId, serverId: server.serverId,
            currentStorageState: 'machine_only',
            metadata: { path: '/fixture', host: 'fixture', externalSessionV1: link } })]);
        // Enter at Sync's actual initial native-window owner; subsequent reads
        // use the public loadOlderMessages consumed by Session history.
        const hydrate = Reflect.get(sync, 'fetchExternalSessionMessages') as (sessionId: string, nativeLink: typeof link) => Promise<boolean>;
        expect(await hydrate.call(sync, linked.sessionId, link)).toBe(true);
        expect(machinePages).toBe(1);
        const readMessages = () => {
            const state = storage.getState().sessionMessages[linked.sessionId];
            return (state?.messageIdsOldestFirst ?? []).flatMap(id => state?.messagesById[id] ? [state.messagesById[id]!] : []);
        };
        let corpus = { messages: readMessages(), history: { isLoaded: true, hasOlder: true, isLoadingOlder: false } };
        const history = createReadOnlySessionTranscriptSource({ sessionId: linked.sessionId,
            messages: corpus.messages, reducerState: null, metadata: null, agentState: null, historyState: corpus.history,
            loadOlder: async () => {
                const result = await sync.loadOlderMessages(linked.sessionId);
                corpus = { messages: readMessages(), history: { ...corpus.history, hasOlder: result.hasMore } };
                history.update({ messages: corpus.messages, reducerState: null, metadata: null, agentState: null, historyState: corpus.history });
                return result;
            },
        });
        const find = createTranscriptFindModel({ readCorpus: () => corpus, loadPage: () => history.history.loadOlder!(),
            jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
        try {
            find.setQuery('older fixture needle');
            failNextPage = true;
            find.searchOlder();
            await find.settled();
            expect(find.status).toMatchObject({ total: 0, coverage: 'partialErrors' });
            expect(corpus.history.hasOlder).toBe(true);
            find.searchOlder();
            await find.settled();
            expect(find.status).toMatchObject({ total: 1, coverage: 'complete' });
            expect(machinePages).toBeGreaterThanOrEqual(4);
            expect(corpus.history.hasOlder).toBe(false);
        } finally { find.dispose(); boundary.page = null; }
        let olderCursor = window.olderCursor;
        let pageCount = 1;
        while (olderCursor) {
            const older = await readPage(olderCursor);
            pageCount += 1;
            expect(older.truncated).toBe(false);
            expect(older.nextCursor).not.toBe(olderCursor);
            published.unshift(...older.items);
            olderCursor = older.nextCursor;
        }
        expect(pageCount).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(published)).toContain('older fixture needle');
        const normalizationPath = '../../../../ui/sources/sync/runtime/external/normalizeExternalSessionTranscriptMessages';
        const findSeedPath = '../../../../ui/sources/components/appShell/panes/fileFindSeedHandoff';
        // Runtime imports retain each package's compiler ownership while this
        // composed check exercises the actual receiving UI owners.
        const { normalizeExternalSessionTranscriptMessages } = await import(normalizationPath) as {
            normalizeExternalSessionTranscriptMessages(items: typeof page.items, identity: { agentId: string; remoteSessionId: string }): NormalizedMessage[];
        };
        const { resolveChatFindSeed } = await import(findSeedPath) as {
            resolveChatFindSeed(seed: { query: string; target: { kind: 'native-message'; agentId: string; remoteSessionId: string; sourceItemId: string } }): { query: string; options: { matchCase: boolean; regex: boolean }; target: { kind: string; routeMessageId?: string } };
        };
        const seed = resolveChatFindSeed({ query: 'fixture answer needle', target: { kind: 'native-message', agentId: 'claude', remoteSessionId: candidate.remoteSessionId, sourceItemId: candidate.match!.sourceItemId } });
        expect(seed).toMatchObject({ query: 'fixture answer needle', options: { matchCase: false, regex: false } });
        expect(seed.target.kind).toBe('route-message-id');
        if (seed.target.kind !== 'route-message-id') throw new Error('Expected a native message Find target');
        const targetRef = parseStableSessionMessageRouteId(seed.target.routeMessageId);
        expect(targetRef?.kind).toBe('server');
        if (targetRef?.kind !== 'server') throw new Error('Expected a stable imported message reference');
        const normalized = normalizeExternalSessionTranscriptMessages(published, { agentId: 'claude', remoteSessionId: candidate.remoteSessionId });
        expect(normalized).toHaveLength(411);
        expect(JSON.stringify(normalized).includes('A'.repeat(628_392))).toBe(false);
        expect(JSON.stringify(normalized)).not.toContain('unknown private payload');
        expect(normalized.filter(item => JSON.stringify(item).includes('Agent emitted an unsupported content block.'))).toHaveLength(1);
        expect(JSON.stringify(normalized.find(item => item.id === targetRef.value))).toContain('fixture answer needle');
        const matcherPath = '../../../../../packages/plugin-ui/src/presentation/find/matchFindText';
        const { matchFindText } = await import(matcherPath) as {
            matchFindText(text: string, query: string, options: { matchCase: boolean; regex: boolean }): { ranges: [number, number][] } | { invalidPattern: true };
        };
        const findText = (item: NormalizedMessage) => item.role === 'user' ? item.content.text
            : item.role === 'agent' ? item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : '';
        const targetMessage = normalized.find(item => item.id === targetRef.value);
        expect(targetMessage).toBeDefined();
        expect(matchFindText(findText(targetMessage!), seed.query, seed.options)).toMatchObject({ ranges: [[0, seed.query.length]] });
        expect(normalized.some(item => {
            const result = matchFindText(findText(item), 'older fixture needle', seed.options);
            return 'ranges' in result && result.ranges.length > 0;
        })).toBe(true);
        sourceLog.mockRestore();
        const log = vi.spyOn(logger, 'debug');
        try {
            await writeFile(join(projectDir, 'native.jsonl'), JSON.stringify({ type: 'user', uuid: 'replacement',
                message: { role: 'user', content: 'replacement source' } }) + '\n');
            const replaced = await readPage(window.olderCursor!);
            expect(replaced).toMatchObject({ items: [], truncated: true, hasMore: false });
            expect(log).toHaveBeenCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
                code: 'source_discontinuity', reason: 'source_identity_changed',
            }));
            log.mockClear();
            const tail = ExternalSessionTranscriptReadAfterResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.transcript.readAfter', timeoutMs: null,
                params: { ...target, source: linkedSource, remoteSessionId: candidate.remoteSessionId, cursor: window.tailCursor },
            }));
            expect(tail).toMatchObject({ ok: true, items: [], truncated: true });
            expect(log).toHaveBeenCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
                code: 'source_discontinuity', reason: 'source_identity_changed',
            }));
            await writeFile(join(projectDir, 'native.jsonl'), JSON.stringify({ type: 'user', uuid: 'large-text',
                message: { role: 'user', content: 'x'.repeat(20_000) } }) + '\n');
            log.mockClear();
            const overflow = ExternalSessionTranscriptPageResponseSchema.parse(await rpc.handleRequest({
                method: 'fixture-machine:daemon.externalSessions.transcript.page', timeoutMs: null,
                params: { ...target, source: linkedSource, remoteSessionId: candidate.remoteSessionId,
                    direction: 'older', maxBytes: 4_096 },
            }));
            expect(overflow).toMatchObject({ ok: false, errorCode: 'agent_error', retryable: false });
            expect(log).toHaveBeenCalledWith('[externalSessions][agent_failure]', expect.objectContaining({
                reason: 'transcript_item_byte_budget', failureClass: 'result_admission',
            }));
        } finally { log.mockRestore(); }
    } finally {
        await registration?.dispose();
        await runtime?.dispose();
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
        await rm(root, { recursive: true, force: true });
    }
});
