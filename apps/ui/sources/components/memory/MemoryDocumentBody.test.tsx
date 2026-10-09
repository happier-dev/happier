import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';
import { MemoryDocBodyV1Schema, type MemoryDocBodyV1, type MemoryFactV1 } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { MemoryDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import {
    PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema,
    PromptLibraryRecordV1Schema, type PromptLibraryRecordV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import {
    ProjectAccountOrganizationV1Schema, ProjectAccountRowMutationRequestV1Schema, PROJECT_ACCOUNT_ROWS_ROUTE_V1,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import {
    createHomeGovernanceHarness, createPlainAccountEncryptionCurrentnessFixture, createPlainProjectAccountRowListFixture,
    createSessionFixture, flushHookEffects, installHomeGovernanceBoundaries, renderScreen, standardCleanup, waitForHomeGovernance,
} from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ItemAction } from '@/components/ui/lists/itemActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// HTTP, persistence, device credentials and the reachable cold Socket transport are the boundaries.
// The memory hook, Actions front door, codecs, admission and Artifact CAS owners stay real.
installDisconnectedServerSocketBoundary(socket => { socket.connected = true; });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { useMemoryDocument } = await import('./useMemoryDocument');
const { MemoryDocumentBody } = await import('./MemoryDocumentBody');
const { ContextMemorySection } = await import('@/components/settings/prompts/context/ContextMemorySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { Modal } = await import('@/modal');
const baseline = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
let caseSignal: AbortSignal;

beforeEach(async ({ signal }) => {
    caseSignal = signal;
    vi.mocked(Modal.alert).mockClear();
    webLocks = installWebLockManagerMock();
    await homes.reset();
    storage.setState(baseline, true);
    serverId = await homes.addHome({ name: 'Memory Home', serverUrl: 'https://memory-body.test', accountId: 'account-a' });
    // Match the admitted local Settings baseline: the Home harness otherwise answers null/version 0.
    homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 1 } });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://memory-body.test', accountId: 'account-a', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    const scope = { serverId, accountId: 'account-a' };
    storage.getState().applySettingsForScope(scope, baseline.settings, 1);
    storage.getState().activateProfileScope(scope);
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    navigation.push.mockClear();
    webLocks.restore();
    installHomeGovernanceBoundaries(homes);
});

const fact = (id: string, text: string): MemoryFactV1 => ({ id, text, createdAtMs: 1_000, sourceSessionRef: null });

async function seedDocument(body: MemoryDocBodyV1): Promise<PromptDocArtifactRefV1> {
    const artifactId = await sync.createArtifactWithHeader({ v: 1, kind: 'memory_doc.v1', title: 'Account memory' }, JSON.stringify(body));
    homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: artifactId }), { body: { publicShares: [] } });
    return { kind: 'doc', serverId, artifactId };
}
function storedBody(ref: PromptDocArtifactRefV1): MemoryDocBodyV1 {
    return MemoryDocBodyV1Schema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(ref.artifactId) ?? 'null'));
}

function Host(props: Readonly<{
    documentRef?: PromptDocArtifactRefV1; topic?: string; composing?: boolean; collapsed?: number;
    sessionTarget?: Parameters<typeof MemoryDocumentBody>[0]['sessionTarget'];
    scopeTarget?: MemoryScopeTargetV1;
    onCreatedMemory?: Parameters<typeof MemoryDocumentBody>[0]['onCreatedMemory'];
}>) {
    const [composing, setComposing] = React.useState(props.composing ?? false);
    const source = useMemoryDocument({ ref: props.documentRef ?? null, serverId, topic: props.topic });
    return <MemoryDocumentBody testID="memory" source={source} serverId={serverId}
        collapsedFactCount={props.collapsed} composing={composing} onComposingChange={setComposing}
        sessionTarget={props.sessionTarget} scopeTarget={props.scopeTarget} onCreatedMemory={props.onCreatedMemory} emptyText="empty" />;
}

function boundaryDiagnostic() {
    return 'Memory HTTP boundary: ' + JSON.stringify({
        scope: storage.getState().profileScope,
        paths: homes.requests.map(({ path, input }) => ({ path, mutation: input !== null })),
        artifacts: homes.artifacts(serverId).list().map(row => ({
            id: row.id, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion,
            body: homes.artifacts(serverId).readPlainBody(row.id),
        })),
        refusals: vi.mocked(Modal.alert).mock.calls.map(([, message]) => message),
    });
}
async function settled(check: () => void) {
    const signal = caseSignal;
    try {
        // Inherit the case's runner deadline through the incumbent Home harness.
        await waitForHomeGovernance(async () => {
            // Flush before asserting: a rejecting act callback skips React's queue flush.
            // A timed-out case must not enter act or inspect the next case's shared boundary.
            signal.throwIfAborted();
            await flushHookEffects();
            signal.throwIfAborted();
            check();
        });
    } catch (error) {
        if (error instanceof Error && !signal.aborted) {
            error.message += '\n' + boundaryDiagnostic();
        }
        throw error;
    }
}
async function savedDraft(screen: Awaited<ReturnType<typeof renderScreen>>) {
    // Refusal is terminal too: assert success outside the retry loop, instead of hiding it until the runner expires.
    await settled(() => expect(!screen.findByTestId('memory.draft') || vi.mocked(Modal.alert).mock.calls.length > 0).toBe(true));
    expect(Boolean(screen.findByTestId('memory.draft')), boundaryDiagnostic()).toBe(false);
    expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
}
async function renderDocument(ref: PromptDocArtifactRefV1, props: Omit<React.ComponentProps<typeof Host>, 'documentRef'> = {}) {
    const screen = await renderScreen(<Host documentRef={ref} {...props} />);
    await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
    return screen;
}
async function readMemory(ref: PromptDocArtifactRefV1, topic?: string) {
    const result = await createDefaultActionExecutor().execute('memory.read', { ref, ...(topic ? { topic } : {}) }, { serverId, surface: 'ui' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    return MemoryDocReadResultV1Schema.parse(result.result);
}

/** Coding-row HTTP/CAS boundary: the actual catalog reader and attachment writer run above it. */
function serveAccountContext(conflict = false) {
    let record: Extract<PromptLibraryRecordV1, { key: 'coding' }> = {
        key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [] },
    };
    let revision = 4;
    homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: () => ({ body: { status: 'listed', rows: [
        { key: 'coding', revision, content: { t: 'plain', v: record } },
        ...PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== 'coding').map(key => ({ key, revision: 1, content: null })),
    ] } }) });
    homes.answer(serverId, 'POST ' + PROMPT_LIBRARY_ROWS_ROUTE_V1 + '/coding', { select: input => {
        const mutation = PromptLibraryRowMutationV1Schema.parse(input);
        if (conflict || mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', revision: revision + 1 } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain coding row');
        const next = PromptLibraryRecordV1Schema.parse(mutation.content.v);
        if (next.key !== 'coding') throw new Error('Expected coding row');
        record = next;
        revision += 1;
        return { body: { status: 'updated', revision, cursor: revision } };
    } });
    return { read: () => record.value.entries };
}

/** Personal Project row HTTP/CAS boundary, retaining its neighboring organization fields. */
function serveProjectContext(conflict = false) {
    const key = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    let value = ProjectAccountOrganizationV1Schema.parse({ pinned: true, hidden: true, promptStack: [] });
    let revision = 4;
    homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', { select: () => ({ body:
        createPlainProjectAccountRowListFixture({ organizations: [{ key, value, revision }] }) }) });
    homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/mutate', { select: input => {
        const mutation = ProjectAccountRowMutationRequestV1Schema.parse(input).mutations[0]!;
        if (conflict || mutation.expectedRevision !== revision) return { status: 409, body: { status: 'conflict', key, revision: revision + 1 } };
        if (mutation.content?.t !== 'plain' || !mutation.content.v || typeof mutation.content.v !== 'object' || !('value' in mutation.content.v)) {
            throw new Error('Expected plain Project organization');
        }
        value = ProjectAccountOrganizationV1Schema.parse(mutation.content.v.value);
        revision += 1;
        return { body: { status: 'updated', rows: [{ key, content: mutation.content, revision }], cursor: revision } };
    } });
    return { read: () => value };
}

describe('MemoryDocumentBody', () => {
    it('shows the index first — key facts, then topics — and a topic opens its own page', async () => {
        const ref = await seedDocument({ v: 1,
            index: [fact('f1', 'Releases ship from release/0.3.'), fact('f2', 'Changelog order: Features, Fixes.')],
            topics: [{ title: 'releases', summary: 'How releases are cut.', facts: [] }, { title: 'archive', summary: 'x', facts: [] }],
        });
        const screen = await renderDocument(ref, { collapsed: 1 });
        expect(Boolean(screen.findByTestId('memory.fact.f1'))).toBe(true);
        expect(Boolean(screen.findByTestId('memory.fact.f2'))).toBe(false);
        const href = '/settings/prompts/memory/' + ref.artifactId + '?serverId=' + encodeURIComponent(serverId);
        await screen.pressByTestIdAsync('memory.showAll');
        expect(navigation.push).toHaveBeenLastCalledWith(href);
        await screen.pressByTestIdAsync('memory.topic.releases');
        expect(navigation.push).toHaveBeenLastCalledWith(href + '&topic=releases');
        expect(Boolean(screen.findByTestId('memory.topic.archive'))).toBe(true);
    });

    it('remembers into an optional topic and re-reads the persisted fact', async () => {
        const ref = await seedDocument({ v: 1, index: [], topics: [] });
        const screen = await renderDocument(ref, { composing: true });
        await React.act(async () => { screen.changeTextByTestId('memory.draft', '  Ana reviews sync changes.  '); });
        await React.act(async () => { screen.changeTextByTestId('memory.draftTopic', 'reviews'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled(() => expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false));
        expect(await readMemory(ref, 'reviews')).toMatchObject({ topic: {
            title: 'reviews', facts: [{ id: expect.any(String), text: 'Ana reviews sync changes.', sourceSessionRef: null }],
        } });
        expect(storedBody(ref)).toMatchObject({ index: [], topics: [{ title: 'reviews', facts: [{ text: 'Ana reviews sync changes.' }] }] });
        expect(Boolean(screen.findByTestId('memory.topic.reviews'))).toBe(true);
    });

    it('with no document yet, the first fact reaches the Session target and its Account attachment', async () => {
        const account = serveAccountContext();
        const template = createSessionFixture();
        if (!template.metadata) throw new Error('Missing Session metadata fixture');
        // Retained non-Bot Sessions default memory off; this is an enabled Session's remember surface.
        const session = createSessionFixture({ id: 's1', serverId, metadataVersion: 7,
            metadata: { ...template.metadata, work: { memoryEnabled: true } },
        });
        storage.getState().applySessions([session]);
        const row = SessionCurrentProjectionRecordV1Schema.parse({ ...V2SessionRecordSchema.parse({
            id: session.id, createdAt: 1, updatedAt: 1, seq: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
            metadata: JSON.stringify(session.metadata), metadataVersion: 7, agentState: null, agentStateVersion: 1, share: null,
        }), effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null });
        // The default Home features negotiate current Session access; answer that exact HTTP projection.
        homes.answer(serverId, 'GET /v2/sessions/s1?accessProjectionVersion=1', { body: { session: row } });
        homes.answer(serverId, 'GET /v2/sessions/s1', { body: { session: row } });
        homes.answer(serverId, 'GET /v1/sessions/s1/turns', { body: SessionTurnsProjectionV1Schema.parse({
            v: 1, sessionId: session.id, updatedAt: session.updatedAt, turns: [],
        }) });
        const screen = await renderScreen(<Host composing sessionTarget={{ sessionId: 's1', serverId, expectedMetadataRevision: 7 }} />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'Prefers short commits.'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await savedDraft(screen);
        const attached = account.read().find(entry => entry.id === 'account.memory');
        expect(attached).toBeTruthy();
        if (!attached || attached.ref.kind !== 'doc') throw new Error('Missing Account memory attachment');
        expect(storedBody(attached.ref)).toMatchObject({ index: [{ text: 'Prefers short commits.' }] });
    });

    it('a real Artifact CAS conflict refreshes the current version and keeps what was typed', async () => {
        const ref = await seedDocument({ v: 1, index: [fact('f1', 'Old fact')], topics: [] });
        const screen = await renderDocument(ref, { composing: true });
        homes.artifacts(serverId).beforeNextUpdate(async () => {
            // This competing client keeps the strict memory header valid; null title would corrupt the fixture.
            await sync.updateArtifact(ref.artifactId, 'Account memory', JSON.stringify({ v: 1, index: [fact('f1', 'Concurrent fact')], topics: [] }));
        });
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'A newer fact'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled(() => expect(Boolean(screen.findByTestId('memory.conflict'))).toBe(true));
        expect(screen.findByTestId('memory.draft')?.props.value).toBe('A newer fact');
        await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.view.facts[0]?.text).toBe('Concurrent fact'));
        expect(storedBody(ref).index).toEqual([fact('f1', 'Concurrent fact')]);
    });

    it('archived facts are read-only', async () => {
        const ref = await seedDocument({ v: 1, index: [], topics: [{ title: 'archive', summary: 's', facts: [fact('old', 'Changelog order: Features, Fixes.')] }] });
        const screen = await renderDocument(ref, { topic: 'archive' });
        expect(Boolean(screen.findByTestId('memory.fact.old'))).toBe(true);
        expect(Boolean(screen.findByTestId('memory.fact.old.more'))).toBe(false);
    });

    it.each([undefined, 'Build'])('Undo restores original identity, expiry and provenance to its original section (%s)', async (topic) => {
        const original: MemoryFactV1 = {
            id: 'original', text: 'Use the build script.', createdAtMs: 1_000, expiresAtMs: Date.now() + 600_000,
            sourceSessionRef: { serverId: 'source-home', sessionId: 'source-session' },
        };
        const ref = await seedDocument({ v: 1, index: topic ? [] : [original],
            topics: topic ? [{ title: topic, summary: 'Build details', facts: [original] }] : [],
        });
        const screen = await renderDocument(ref, { topic });
        const before = screen.findByType(MemoryDocumentBody).props.source.view.revision;
        const actions: readonly ItemAction[] = screen.findByType(ItemRowActions).props.actions;
        await React.act(async () => { actions.find(action => action.id === 'forget')!.onPress(); });
        await settled(() => {
            expect(Boolean(screen.findByTestId('memory.fact.original'))).toBe(false);
            expect(Boolean(screen.findByType(SurfaceStateCard).props.action)).toBe(true);
            const source = screen.findByType(MemoryDocumentBody).props.source;
            expect(source.status).toBe('ready');
            expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(before.bodyVersion);
        });
        expect(storedBody(ref).topics.find(section => section.title === 'archive')?.facts).toEqual([original]);
        const afterForget = screen.findByType(MemoryDocumentBody).props.source.target.expectedRevision;
        await React.act(async () => { screen.findByType(SurfaceStateCard).props.action.onPress(); });
        await settled(() => {
            const source = screen.findByType(MemoryDocumentBody).props.source;
            expect(source.status).toBe('ready');
            expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(afterForget.bodyVersion);
        });
        expect(Boolean(screen.findByTestId('memory.fact.original'))).toBe(true);
        const restored = await readMemory(ref, topic);
        expect('topic' in restored ? restored.topic.facts : restored.body.index).toEqual([original]);
        expect(await readMemory(ref, 'archive')).toMatchObject({ topic: { facts: [] } });
        const persisted = storedBody(ref);
        expect(topic ? persisted.topics.find(section => section.title === topic)?.facts : persisted.index).toEqual([original]);
        expect([...persisted.index, ...persisted.topics.flatMap(section => section.facts)]).toEqual([original]);
    });

    it.each(['account', 'project'] as const)('remembers the first %s scope fact and attaches the actual persisted document', async (scope) => {
        const account = scope === 'account' ? serveAccountContext() : null;
        const project = scope === 'project' ? serveProjectContext() : null;
        const target: MemoryScopeTargetV1 = scope === 'account' ? { scope } : { scope, projectRef: { serverId, projectKey: 'project' } };
        const created = vi.fn<NonNullable<React.ComponentProps<typeof Host>['onCreatedMemory']>>();
        const screen = await renderScreen(<Host composing scopeTarget={target} onCreatedMemory={created} />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'Use the shared build script.'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await savedDraft(screen);
        const attached = (account?.read() ?? project?.read().promptStack ?? []).find(entry => entry.id === scope + '.memory');
        expect(attached).toBeTruthy();
        if (!attached || attached.ref.kind !== 'doc') throw new Error('Missing scope memory attachment');
        expect(created).toHaveBeenCalledWith({ ref: attached.ref, attachment: 'attached' });
        expect(await readMemory(attached.ref)).toMatchObject({ body: { index: [{ text: 'Use the shared build script.', sourceSessionRef: null }] } });
        expect(storedBody(attached.ref).index).toMatchObject([{ text: 'Use the shared build script.' }]);
        if (project) expect(project.read()).toMatchObject({ pinned: true, hidden: true });
    });

    it.each(['account', 'project'] as const)('preserves the durable fact and exact receipt after a %s scope attachment conflict', async (scope) => {
        const account = scope === 'account' ? serveAccountContext(true) : null;
        const project = scope === 'project' ? serveProjectContext(true) : null;
        const target: MemoryScopeTargetV1 = scope === 'account' ? { scope } : { scope, projectRef: { serverId, projectKey: 'project' } };
        const created = vi.fn<NonNullable<React.ComponentProps<typeof Host>['onCreatedMemory']>>();
        const screen = await renderScreen(<Host composing scopeTarget={target} onCreatedMemory={created} />);
        await React.act(async () => { screen.changeTextByTestId('memory.draft', 'A durable unattached fact.'); });
        await screen.pressByTestIdAsync('memory.draft.save');
        await settled(() => {
            expect(Boolean(screen.findByTestId('memory.conflict'))).toBe(true);
            expect(Boolean(screen.findByTestId('memory.draft'))).toBe(false);
        });
        expect(account?.read() ?? project?.read().promptStack).toEqual([]);
        const rows = homes.artifacts(serverId).list();
        expect(rows).toHaveLength(1);
        const ref = { kind: 'doc' as const, serverId, artifactId: rows[0]!.id };
        expect(created).toHaveBeenCalledWith({ ref, attachment: 'conflict' });
        expect(await readMemory(ref)).toMatchObject({ body: { index: [{ text: 'A durable unattached fact.' }] } });
        expect(storedBody(ref).index).toMatchObject([{ text: 'A durable unattached fact.' }]);
    });

    it('Context displays the exact saved document after attachment conflict and retires it when its Home Account changes', async () => {
        const account = serveAccountContext(true);
        if (!connection) throw new Error('Missing admitted test Account');
        const detach = vi.fn();
        const budget = vi.fn();
        const scopeTarget = { scope: 'account' } as const;
        const section = <ItemList><ContextMemorySection testID="context.memory" title="Memory" description="Account memory"
            serverId={serverId} entry={null} scopeTarget={scopeTarget} footer="Account" emptyText="empty"
            onDetach={detach} onBudgetChange={budget} /></ItemList>;
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>{section}</InjectedAuthProvider>);
        await screen.pressByTestIdAsync('context.memory.remember');
        await React.act(async () => { screen.changeTextByTestId('context.memory.draft', 'Preserve the exact saved document.'); });
        await screen.pressByTestIdAsync('context.memory.draft.save');
        await settled(() => {
            expect(Boolean(screen.findByTestId('context.memory.conflict'))).toBe(true);
            expect(Boolean(screen.findByTestId('context.memory.draft'))).toBe(false);
            expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready');
        });
        const rows = homes.artifacts(serverId).list();
        expect(rows).toHaveLength(1);
        const ref = { kind: 'doc' as const, serverId, artifactId: rows[0]!.id };
        const original = storedBody(ref).index[0]!;
        expect(original.text).toBe('Preserve the exact saved document.');
        expect(Boolean(screen.findByTestId('context.memory.fact.' + original.id))).toBe(true);
        expect(screen.findByType(MemoryDocumentBody).props.source.target.ref).toEqual(ref);
        expect(account.read()).toEqual([]);
        expect(Boolean(screen.findByTestId('context.memory.detach'))).toBe(false);
        expect(Boolean(screen.findByTestId('context.memory.load'))).toBe(false);
        expect(detach).not.toHaveBeenCalled();
        expect(budget).not.toHaveBeenCalled();

        const mountedBody = screen.findByType(MemoryDocumentBody);
        await connection.dispose();
        connection = null;
        await homes.switchAccount(serverId, 'account-b');
        const nextConnection = await restoreServerAccountForTest({ serverUrl: 'https://memory-body.test', accountId: 'account-b', request: homes.request });
        connection = nextConnection;
        installHomeGovernanceBoundaries(homes);
        await React.act(async () => {
            const scope = { serverId, accountId: 'account-b' };
            storage.getState().applySettingsForScope(scope, baseline.settings, 1);
            storage.getState().activateProfileScope(scope);
            screen.update(<InjectedAuthProvider credentials={nextConnection.credentials}>{section}</InjectedAuthProvider>);
        });
        await settled(() => {
            expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-b' });
        });
        expect(Boolean(screen.findByTestId('context.memory.fact.' + original.id))).toBe(false);
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('none');
        // The Account boundary clears the receipt in the same mounted surface; a remount would hide that bug.
        expect(screen.findByType(MemoryDocumentBody) === mountedBody).toBe(true);
    });
});
