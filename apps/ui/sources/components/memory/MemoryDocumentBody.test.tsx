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
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { readPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
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
const { MemoryDocumentScreen } = await import('./MemoryDocumentScreen');
const { ContextMemorySection } = await import('@/components/settings/prompts/context/ContextMemorySection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { SessionMemorySection, selectSessionMemory } = await import('@/components/sessions/work/memory/SessionMemorySection');
const { useSessionContextLayers } = await import('@/components/sessions/work/context/useSessionContextLayers');
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

it('reads document content through memory.read admission instead of bypassing a disabled UI Action', async () => {
    const settings = { ...baseline.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        actions: { 'memory.read': { disabledSurfaces: ['ui'] } } }) };
    homes.answer(serverId, 'GET /v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
    storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settings, 2);
    const ref = await seedDocument({ v: 1, index: [fact('one', 'One')], topics: [] });
    const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
    await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
    await hook.unmount();
});

/** Coding-row HTTP/CAS boundary: the actual catalog reader and attachment writer run above it. */
function serveAccountContext(conflict = false, entries: Extract<PromptLibraryRecordV1, { key: 'coding' }>['value']['entries'] = []) {
    let record: Extract<PromptLibraryRecordV1, { key: 'coding' }> = {
        key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries },
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
function serveProjectContext(conflict = false, withWorkspace = false) {
    const key = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
    let value = ProjectAccountOrganizationV1Schema.parse({ pinned: true, hidden: true, promptStack: [] });
    let revision = 4;
    homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', { select: () => ({ body:
        createPlainProjectAccountRowListFixture({ organizations: [{ key, value, revision }],
            ...(withWorkspace ? { workspaceRefs: [{ id: 'workspace', serverId, projectKey: 'project', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }] } : {}),
        }) }) });
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
    it('keeps foreign Context navigation on its admitted Home while its write target is withdrawn', async () => {
        const original = await seedDocument({ v: 1, index: Array.from({ length: 5 }, (_, i) => fact('f' + i, 'Foreign fact ' + i)),
            topics: [{ title: 'releases', summary: 'Release details', facts: [] }] });
        const foreignHome = await homes.addHome({ name: 'Foreign memory', serverUrl: 'https://foreign-memory.test', accountId: 'foreign-a', active: false });
        homes.answer(foreignHome, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const stored = homes.artifacts(serverId).read(original.artifactId)!;
        const created = await homes.artifacts(foreignHome).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: stored.id, header: stored.header, body: stored.body, dataEncryptionKey: stored.dataEncryptionKey,
        }) });
        expect(created?.ok).toBe(true);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(homes.request);
        const ref = { ...original, serverId: foreignHome };
        if (!connection) throw new Error('Missing admitted Account fixture');
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><ItemList><ContextMemorySection testID="context.memory" title="Memory" description="Memory"
            serverId={serverId} entry={{ id: 'account.memory', ref, enabled: true, placement: 'system_append' }}
            footer="Memory" emptyText="empty" /></ItemList></InjectedAuthProvider>);
        await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).not.toBe('loading'));
        expect(screen.findByType(MemoryDocumentBody).props.source.status, boundaryDiagnostic()).toBe('ready');
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        homes.answer(foreignHome, '/v1/artifacts/' + ref.artifactId, { status: 503, body: { error: 'offline' }, respondAfter: held });
        let pending!: Promise<void>;
        await React.act(async () => { pending = screen.findByType(MemoryDocumentBody).props.source.refresh(); });
        try {
            for (const status of ['refreshing', 'unavailable']) {
                expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe(status);
                expect(screen.findByType(MemoryDocumentBody).props.source.target).toBeNull();
                const href = '/settings/prompts/memory/' + ref.artifactId + '?serverId=' + encodeURIComponent(foreignHome);
                await screen.pressByTestIdAsync('context.memory.showAll');
                expect(navigation.push).toHaveBeenLastCalledWith(href);
                await screen.pressByTestIdAsync('context.memory.topic.releases');
                expect(navigation.push).toHaveBeenLastCalledWith(href + '&topic=releases');
                await React.act(async () => { release(); await pending; });
            }
        } finally {
            await React.act(async () => { release(); await pending; });
        }
    });

    it.each([
        { remoteAccess: 'view' as const, localAccess: null, readOnly: true, shared: true },
        { remoteAccess: 'edit' as const, localAccess: 'view' as const, readOnly: false, shared: true },
        { remoteAccess: 'owner' as const, localAccess: 'view' as const, readOnly: false, shared: false },
    ])('Work uses qualified memory access $remoteAccess instead of ambient $localAccess', async ({ remoteAccess, localAccess, readOnly, shared }) => {
        const original = await seedDocument({ v: 1, index: [fact('foreign-fact', 'Qualified fact')], topics: [] });
        const foreignHome = await homes.addHome({ name: 'Foreign memory', serverUrl: 'https://foreign-memory.test', accountId: 'foreign-a', active: false });
        homes.answer(foreignHome, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const stored = homes.artifacts(serverId).read(original.artifactId)!;
        await homes.artifacts(foreignHome).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: stored.id, header: stored.header, body: stored.body, dataEncryptionKey: stored.dataEncryptionKey,
        }) });
        const foreignArtifact = {
            ...homes.artifacts(foreignHome).read(original.artifactId), access: remoteAccess,
            ownerAccountId: remoteAccess === 'owner' ? 'foreign-a' : 'another-owner',
        };
        homes.answer(foreignHome, '/v1/artifacts/' + original.artifactId, { body: foreignArtifact });
        // The Home serves the same caller access on the qualified detail and header inventory.
        const { body: _body, ...foreignHeader } = foreignArtifact;
        homes.answer(foreignHome, '/v1/artifacts?limit=500', { body: [foreignHeader] });
        const ref = { ...original, serverId: foreignHome };
        serveAccountContext(false, [{ id: 'account.memory', ref, enabled: true, placement: 'system_append' }]);
        if (localAccess) storage.getState().applyArtifacts([{ ...storage.getState().artifacts[original.artifactId]!, access: localAccess }]);
        else storage.getState().deleteArtifact(original.artifactId);
        const base = createSessionFixture();
        if (!base.metadata || !connection) throw new Error('Missing admitted Session/Account fixture');
        const session = createSessionFixture({ id: 's1', serverId, metadataVersion: 9,
            metadata: { ...base.metadata, work: { memoryEnabled: true } } });
        storage.getState().applySessions([session]);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(homes.request);
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <SessionMemorySection session={session} serverId={serverId} />
        </InjectedAuthProvider>);
        await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
        expect(screen.findByType(MemoryDocumentBody).props.readOnly).toBe(readOnly);
        expect(Boolean(screen.findByTestId('session-work-memory.remember'))).toBe(!readOnly);
        expect(screen.findByType(MemoryDocumentBody).props.footer).toContain(shared
            ? 'memoryContext.memory.writesAskFirst' : 'memoryContext.memory.writesWithoutAsking');
        const page = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <MemoryDocumentScreen artifactId={ref.artifactId} serverId={foreignHome} />
        </InjectedAuthProvider>);
        await settled(() => expect(page.findByType(MemoryDocumentBody).props.source.status).toBe('ready'));
        expect(page.findByType(MemoryDocumentBody).props.readOnly).toBe(readOnly);
        expect(Boolean(page.findByTestId('memory-document.remember'))).toBe(!readOnly);
    });

    it('never retains equal-id facts or a reviewed target when a mounted read switches Homes', async () => {
        const ref = await seedDocument({ v: 1, index: [fact('home-a-fact', 'Only Home A knows this.')], topics: [] });
        const homeB = await homes.addHome({ name: 'Other memory Home', serverUrl: 'https://other-memory.test', accountId: 'account-b', active: false });
        homes.answer(homeB, '/v1/artifacts/' + ref.artifactId, { status: 503, body: { error: 'offline' } });
        const seen: ReturnType<typeof useMemoryDocument>[] = [];
        const hook = await renderHook((documentRef: PromptDocArtifactRefV1) => {
            const value = useMemoryDocument({ ref: documentRef, serverId });
            seen.push(value);
            return value;
        }, { initialProps: ref });
        await settled(() => expect(hook.getCurrent().status).toBe('ready'));
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        homes.answer(serverId, '/v1/artifacts/' + ref.artifactId, { body: homes.artifacts(serverId).read(ref.artifactId), respondAfter: held });
        let pending!: Promise<void>;
        await React.act(async () => { pending = hook.getCurrent().refresh(); });
        await settled(() => expect(hook.getCurrent().status).toBe('refreshing'));
        seen.length = 0;
        await hook.rerender({ ...ref, serverId: homeB });
        await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
        await React.act(async () => { release(); await pending; });
        expect(seen.every(value => value.view === null && value.target === null)).toBe(true);
        expect(hook.getCurrent()).toMatchObject({ status: 'unavailable', view: null, target: null, stale: false });
    });

    it('retires a mounted memory view and reviewed revision when the same Home replaces its Account', async () => {
        const ref = await seedDocument({ v: 1, index: [fact('account-a-fact', 'Private to Account A.')], topics: [] });
        const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
        await settled(() => expect(hook.getCurrent().status).toBe('ready'));
        await connection?.dispose();
        connection = null;
        await homes.switchAccount(serverId, 'account-b');
        homes.answer(serverId, '/v1/artifacts/' + ref.artifactId, { status: 503, body: { error: 'offline' } });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://memory-body.test', accountId: 'account-b', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        await React.act(async () => {
            const scope = { serverId, accountId: 'account-b' };
            storage.getState().applySettingsForScope(scope, baseline.settings, 1);
            storage.getState().activateProfileScope(scope);
        });
        await hook.rerender();
        expect(hook.getCurrent().view).toBeNull();
        expect(hook.getCurrent().target).toBeNull();
        await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
    });

    it('retires a foreign Home memory view when its credentials change without changing the focused Account', async () => {
        const original = await seedDocument({ v: 1, index: [fact('foreign-private', 'Only the foreign Account knows this.')], topics: [] });
        const foreignHome = await homes.addHome({ name: 'Foreign memory', serverUrl: 'https://foreign-memory.test', accountId: 'foreign-a', active: false });
        homes.answer(foreignHome, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const stored = homes.artifacts(serverId).read(original.artifactId)!;
        const created = await homes.artifacts(foreignHome).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: stored.id, header: stored.header, body: stored.body, dataEncryptionKey: stored.dataEncryptionKey,
        }) });
        expect(created?.ok).toBe(true);
        installHomeGovernanceBoundaries(homes);
        // Connection restoration's default HTTP boundary admits only its focused Home.
        // This case deliberately reads a second Home through the same real transport.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(homes.request);
        const ref = { ...original, serverId: foreignHome };
        const hook = await renderHook(() => useMemoryDocument({ ref, serverId }));
        await settled(() => expect(hook.getCurrent().status).not.toBe('loading'));
        expect(hook.getCurrent().status, boundaryDiagnostic()).toBe('ready');
        expect(hook.getCurrent().view?.facts[0]?.id).toBe('foreign-private');
        homes.answer(foreignHome, '/v1/artifacts/' + ref.artifactId, { status: 503, body: { error: 'offline' } });
        await React.act(async () => { await homes.switchAccount(foreignHome, 'foreign-b'); });
        expect(storage.getState().profileScope).toEqual({ serverId, accountId: 'account-a' });
        expect(hook.getCurrent().view).toBeNull();
        expect(hook.getCurrent().target).toBeNull();
        await settled(() => expect(hook.getCurrent().status).toBe('unavailable'));
    });

    it('keeps an unavailable Project unresolved instead of selecting Account memory, then accepts verified empty', async () => {
        const ref = await seedDocument({ v: 1, index: [], topics: [] });
        serveAccountContext(false, [{ id: 'account.memory', ref, enabled: true, placement: 'system_append' }]);
        homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', { status: 503, body: { error: 'offline' } });
        const metadata = { machineId: 'machine', workspaceId: 'workspace', projectId: 'project', path: '/repo', work: { memoryEnabled: true } };
        const hook = await renderHook(() => useSessionContextLayers({ sessionId: 's1', serverId, ownerMetadata: metadata, metadataVersion: 9 }));
        await settled(() => {
            expect(hook.getCurrent().project.status).toBe('unavailable');
            expect(hook.getCurrent().account).toHaveLength(1);
        });
        expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({ resolving: true, ref: null, scope: 'project' });
        const base = createSessionFixture();
        if (!base.metadata || !connection) throw new Error('Missing admitted Session/Account fixture');
        const session = createSessionFixture({ id: 's1', serverId, metadataVersion: 9,
            metadata: { ...base.metadata, ...metadata } });
        storage.getState().applySessions([session]);
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <SessionMemorySection session={session} serverId={serverId} />
        </InjectedAuthProvider>);
        await settled(() => expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('loading'));
        expect(screen.findByType(MemoryDocumentBody).props.footer).toBeUndefined();
        expect(Boolean(screen.findByTestId('session-work-memory.remember'))).toBe(false);
        homes.answer(serverId, 'POST ' + PROJECT_ACCOUNT_ROWS_ROUTE_V1 + '/list', { body: createPlainProjectAccountRowListFixture({
            workspaceRefs: [{ id: 'workspace', serverId, projectKey: 'project', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 }],
        }) });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        await React.act(async () => { publishHomeAccountChange(serverId); });
        await settled(() => {
            expect(hook.getCurrent().project.status).toBe('ready');
            expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({ resolving: false, ref, scope: 'account' });
        });
        // A completed attachment-list read is not a completed kind/header read.
        expect(selectSessionMemory({ ...hook.getCurrent(), project: { ...hook.getCurrent().project, rows: [{
            layer: 'project', entry: { id: 'project.document', ref, enabled: true, placement: 'system_append' },
            title: null, kind: 'unknown', on: false, off: null,
            currentPresentation: () => ({ kind: 'unknown', title: null, headerKind: null, access: null }),
        }] } }, serverId)).toMatchObject({ resolving: true, ref: null, scope: 'project' });
    });

    it('Work keeps the first saved memory reachable after attachment conflict and reuses it for the next fact', async () => {
        serveAccountContext(true);
        if (!connection) throw new Error('Missing admitted Account');
        const base = createSessionFixture();
        if (!base.metadata) throw new Error('Missing Session metadata fixture');
        const session = createSessionFixture({ id: 's1', serverId, metadataVersion: 9,
            metadata: { ...base.metadata, work: { memoryEnabled: true } } });
        storage.getState().applySessions([session]);
        // Exact Session read at the genuine network boundary; ordinary Session writes target Account here.
        const row = SessionCurrentProjectionRecordV1Schema.parse({ ...V2SessionRecordSchema.parse({
            id: 's1', seq: 0, active: false, activeAt: 0, createdAt: 1, updatedAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 0, share: null,
            metadata: JSON.stringify(session.metadata), metadataVersion: 9,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        }), effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null });
        homes.answer(serverId, 'GET /v2/sessions/s1?accessProjectionVersion=1', { body: { session: row } });
        homes.answer(serverId, 'GET /v2/sessions/s1', { body: { session: row } });
        homes.answer(serverId, 'GET /v1/sessions/s1/turns', { body: SessionTurnsProjectionV1Schema.parse({
            v: 1, sessionId: session.id, updatedAt: session.updatedAt, turns: [],
        }) });
        const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
            <SessionMemorySection session={session} serverId={serverId} />
        </InjectedAuthProvider>);
        await flushHookEffects();
        expect(screen.findByTestId('session-work-memory.remember')?.props.disabled, boundaryDiagnostic()).toBe(false);
        await screen.pressByTestIdAsync('session-work-memory.remember');
        await React.act(async () => { screen.changeTextByTestId('session-work-memory.doc.draft', 'Keep this first fact.'); });
        await screen.pressByTestIdAsync('session-work-memory.doc.draft.save');
        await settled(() => expect(!screen.findByTestId('session-work-memory.doc.draft') || vi.mocked(Modal.alert).mock.calls.length > 0).toBe(true));
        expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
        expect(screen.findByTestId('session-work-memory.doc.conflict'), boundaryDiagnostic()).toBeTruthy();
        await flushHookEffects();
        expect(screen.findByType(MemoryDocumentBody).props.source.status).toBe('ready');
        const rows = homes.artifacts(serverId).list();
        expect(rows).toHaveLength(1);
        const ref = { kind: 'doc' as const, artifactId: rows[0]!.id, serverId };
        expect(screen.findByType(MemoryDocumentBody).props.source.target.ref).toEqual(ref);
        homes.answer(serverId, '/v1/public-shares?' + new URLSearchParams({ subjectKind: 'artifact', subjectId: ref.artifactId }), { body: { publicShares: [] } });
        await screen.pressByTestIdAsync('session-work-memory.remember');
        await React.act(async () => { screen.changeTextByTestId('session-work-memory.doc.draft', 'Add to the same saved document.'); });
        await screen.pressByTestIdAsync('session-work-memory.doc.draft.save');
        await settled(() => expect(!screen.findByTestId('session-work-memory.doc.draft') || vi.mocked(Modal.alert).mock.calls.length > 0).toBe(true));
        expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
        expect(storedBody(ref).index, boundaryDiagnostic()).toHaveLength(2);
        expect(homes.artifacts(serverId).list()).toHaveLength(1);

        const mountedBody = screen.findByType(MemoryDocumentBody);
        const firstFact = storedBody(ref).index[0]!;
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
            screen.update(<InjectedAuthProvider credentials={nextConnection.credentials}>
                <SessionMemorySection session={session} serverId={serverId} />
            </InjectedAuthProvider>);
        });
        await flushHookEffects();
        expect(screen.findByType(MemoryDocumentBody).props.source.status, boundaryDiagnostic()).toBe('none');
        expect(Boolean(screen.findByTestId('session-work-memory.doc.fact.' + firstFact.id))).toBe(false);
        expect(screen.findByType(MemoryDocumentBody) === mountedBody).toBe(true);
    });

    it('a mounted Work layer follows a real Project edit without changing association or Settings version', async () => {
        const project = serveProjectContext(false, true);
        serveAccountContext();
        const ref = await seedDocument({ v: 1, index: [], topics: [] });
        const metadata = { machineId: 'machine', workspaceId: 'workspace', projectId: 'project', path: '/repo', work: { memoryEnabled: true } };
        const hook = await renderHook(() => useSessionContextLayers({ sessionId: 's1', serverId, ownerMetadata: metadata, metadataVersion: 9 }));
        await settled(() => expect(hook.getCurrent().project.status).toBe('ready'));
        expect(hook.getCurrent().project.rows).toEqual([]);
        const result = await createDefaultActionExecutor().execute('projects.context.update', {
            target: { serverId, projectKey: 'project' }, expectedRevision: 4,
            intent: { kind: 'attach', entry: { id: 'project.memory', ref, enabled: true, placement: 'system_append' } },
        }, { surface: 'ui', serverId });
        expect(result).toMatchObject({ ok: true, result: { ok: true } });
        expect(project.read().promptStack).toHaveLength(1);
        await settled(() => expect(hook.getCurrent().project.rows).toMatchObject([{ entry: { id: 'project.memory' }, kind: 'memory' }]));
        expect(storage.getState().settingsVersion).toBe(1);
    });

    it('keeps unavailable Account and Profile catalogs explicit rather than reporting inherited empty', async () => {
        serveAccountContext();
        const hook = await renderHook(() => useSessionContextLayers({ sessionId: 's1', serverId,
            ownerMetadata: { profileId: 'selected-profile', work: { memoryEnabled: true } }, metadataVersion: 9 }));
        const { getPromptLibraryCatalogValue } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        await settled(() => expect(getPromptLibraryCatalogValue({ serverId, accountId: 'account-a' }, 'coding').status).toBe('ready'));
        const { applyPromptLibraryCatalogSnapshot } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
        const { applyProfileCatalogSnapshot } = await import('@/sync/store/settings/profileCatalogSnapshot');
        await React.act(async () => {
            const scope = { serverId, accountId: 'account-a' };
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'forbidden' }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
            applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'forbidden' }, true);
        });
        expect(hook.getCurrent()).toMatchObject({ accountStatus: 'unavailable', profile: { status: 'unavailable' } });
        expect(selectSessionMemory(hook.getCurrent(), serverId)).toMatchObject({ resolving: true, ref: null });
    });
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
            await sync.updateArtifactWithHeader(ref.artifactId, { v: 1, kind: 'memory_doc.v1', title: 'Account memory' },
                JSON.stringify({ v: 1, index: [fact('f1', 'Concurrent fact')], topics: [] }));
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
            // Undo is offered on the app's one notice owner, not on a card of this section's own.
            expect(readPresentationNotice()?.undo).toBeTruthy();
            const source = screen.findByType(MemoryDocumentBody).props.source;
            expect(source.status).toBe('ready');
            expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(before.bodyVersion);
        });
        expect(storedBody(ref).topics.find(section => section.title === 'archive')?.facts).toEqual([original]);
        const afterForget = screen.findByType(MemoryDocumentBody).props.source.target.expectedRevision;
        await React.act(async () => { readPresentationNotice()!.undo!.run(); });
        expect(readPresentationNotice()).toBeNull();
        await settled(() => {
            const source = screen.findByType(MemoryDocumentBody).props.source;
            const restored = source.status === 'ready' && source.target?.expectedRevision.bodyVersion > afterForget.bodyVersion;
            const refused = screen.findByTestId('memory.conflict') || screen.findByTestId('memory.refused')
                || vi.mocked(Modal.alert).mock.calls.length > 0;
            expect(Boolean(restored || refused)).toBe(true);
        });
        expect(screen.findByTestId('memory.conflict'), boundaryDiagnostic()).toBeNull();
        expect(screen.findByTestId('memory.refused'), boundaryDiagnostic()).toBeNull();
        expect(vi.mocked(Modal.alert).mock.calls, boundaryDiagnostic()).toEqual([]);
        const source = screen.findByType(MemoryDocumentBody).props.source;
        expect(source.status).toBe('ready');
        expect(source.target.expectedRevision.bodyVersion).toBeGreaterThan(afterForget.bodyVersion);
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
