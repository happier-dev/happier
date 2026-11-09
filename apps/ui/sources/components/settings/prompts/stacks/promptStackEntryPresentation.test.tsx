import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, seedAdmittedArtifactRows } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { promptStacksRouterPushSpy } = vi.hoisted(() => ({ promptStacksRouterPushSpy: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: promptStacksRouterPushSpy } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');
const { PromptStackDocumentMenu } = await import('./PromptStackDocumentMenu');
const { useSessionContextLayers } = await import('@/components/sessions/work/context/useSessionContextLayers');
const { SessionContextSection } = await import('@/components/sessions/work/context/SessionContextSection');
const { SessionMemorySection } = await import('@/components/sessions/work/memory/SessionMemorySection');
const { SessionWorkPlanRow } = await import('@/components/sessions/work/SessionWorkPlanRow');
const { ProjectContextBody } = await import('@/components/projects/context/ProjectContextBody');
const { PromptStackEntryRow } = await import('./PromptStackEntryRow');
const { Item } = await import('@/components/ui/lists/Item');
const { MemoryDocumentBody } = await import('@/components/memory/MemoryDocumentBody');
const { AttachExistingMenu } = await import('@/components/sessions/work/instructions/SessionInstructionsSection');

type Home = Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
const fixtures: Home[] = [];
afterEach(() => {
    standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    for (const fixture of fixtures.splice(0).reverse()) fixture.dispose();
    vi.restoreAllMocks();
    promptStacksRouterPushSpy.mockClear();
});

async function seed(home: Home, kind: string, title: string, id = 'same-id') {
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
        header: encodePlainArtifactStoredContent({ v: 1, kind, title }),
        // Classification must succeed without opening this deliberately unreadable body.
        body: 'unreadable body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
}

describe('qualified Context presentation', () => {
    it('keeps every mounted Context row loading while its first qualified header read is held', async () => {
        const foreign = await createPlainArtifactHomeFixture('https://context-held-foreign.test'); fixtures.push(foreign);
        const active = await createPlainArtifactHomeFixture('https://context-held-active.test'); fixtures.push(active);
        const hold = createDeferred<void>();
        let failHeaders = false;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (url.origin === foreign.home.serverUrl && url.pathname === '/v1/artifacts/read') {
                await hold.promise;
                if (failHeaders) return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            const target = url.origin === active.home.serverUrl ? active : foreign;
            return await target.boundary.handle(`${url.pathname}${url.search}`, init)
                ?? Response.json({ error: 'not_found' }, { status: 404 });
        });
        const scope = { serverId: active.home.id, accountId: 'artifact-account' };
        const ref = (artifactId: string) => ({ kind: 'doc' as const, artifactId, serverId: foreign.home.id });
        const entry = (id: string, artifactId: string) => ({ id, ref: ref(artifactId), enabled: true, placement: 'system_append' as const });
        storage.setState({ isDataReady: true, settingsVersion: 7, settingsScope: scope, profileScope: scope });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1,
            record: { key: 'voice', value: { v: 1, scope: { kind: 'voice' }, entries: [entry('editor', 'editor-doc')] } } }, { revision: 1,
            record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [entry('account.memory', 'memory-doc')] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const workspaceRef = { id: 'held-workspace', serverId: active.home.id, machineId: 'machine', rootPath: '/repo/held',
            projectKey: 'held', createdAtMs: 1 };
        storage.getState().activateProjectAccountRowsScope(scope);
        storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete', workspaceRefs: [workspaceRef],
            relationships: [], organizations: [{ key: { kind: 'project-organization', serverId: active.home.id, projectKey: 'held' }, revision: 1,
                value: { promptStack: [entry('project', 'project-doc')] } }], revisionsByPhysicalKey: {} });
        const session = createSessionFixture({ id: 'held-session', serverId: active.home.id });
        const sessionMetadata = session.metadata;
        if (!sessionMetadata) throw new Error('Missing Session fixture metadata');
        type TestEntry = ReturnType<typeof entry> & Readonly<{ plan?: boolean }>;
        const withWork = (promptStack: readonly TestEntry[]) => ({ ...session,
            metadata: { ...sessionMetadata, host: sessionMetadata.host ?? '', path: '', work: { memoryEnabled: true, promptStack } } });
        const planSession = withWork([{ ...entry('plan', 'plan-doc'), plan: true }]);
        storage.getState().applySessions([planSession]);

        const planScreen = await renderScreen(<SessionWorkPlanRow sessionId={planSession.id} serverId={active.home.id} />);
        const contextScreen = await renderScreen(<InjectedAuthProvider credentials={null}><SessionContextSection serverId={active.home.id}
            session={withWork([entry('context', 'context-doc')])} /></InjectedAuthProvider>);
        const memoryScreen = await renderScreen(<InjectedAuthProvider credentials={null}><SessionMemorySection serverId={active.home.id}
            session={withWork([])} /></InjectedAuthProvider>);
        const editorScreen = await renderScreen(<InjectedAuthProvider credentials={null}><PromptStackEditorScreen surface="voice" title="Voice" /></InjectedAuthProvider>);
        const projectScreen = await renderScreen(<InjectedAuthProvider credentials={null}><ProjectContextBody workspaceRef={workspaceRef} /></InjectedAuthProvider>);
        const promptRow = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => screen.findAllByType(PromptStackEntryRow)
            .find(node => node.props.testID === testID);

        await vi.waitFor(() => {
            expect(planScreen.findAllByType(Item).find(node => node.props.testID === 'session-work-plan')?.props.loading).toBe(true);
            expect(promptRow(contextScreen, 'session-work-context.entry.session.context')?.props.loading).toBe(true);
            expect(promptRow(contextScreen, 'session-work-context.entry.session.context')?.props.unavailable).not.toBe(true);
            expect(memoryScreen.findByType(MemoryDocumentBody).props.source.status).toBe('loading');
            expect(promptRow(editorScreen, 'promptStack.entry.editor')?.props.loading).toBe(true);
            expect(promptRow(editorScreen, 'promptStack.entry.editor')?.props.unavailable).not.toBe(true);
            expect(promptRow(projectScreen, 'project-context.personal.project')?.props.loading).toBe(true);
            expect(promptRow(projectScreen, 'project-context.personal.project')?.props.unavailable).not.toBe(true);
        });

        failHeaders = true;
        await React.act(async () => hold.resolve());
        await vi.waitFor(() => {
            expect(planScreen.findAllByType(Item).find(node => node.props.testID === 'session-work-plan')?.props.loading).toBe(false);
            expect(promptRow(contextScreen, 'session-work-context.entry.session.context')?.props.unavailable).toBe(true);
            expect(memoryScreen.findByType(MemoryDocumentBody).props.source.status).toBe('unavailable');
            expect(promptRow(editorScreen, 'promptStack.entry.editor')?.props.unavailable).toBe(true);
            expect(promptRow(projectScreen, 'project-context.personal.project')?.props.unavailable).toBe(true);
        });
    });
    it.each(['id', 'legacy-id'] as const)('retains qualified facts when requested headers reorder, grow or shrink while refresh is held or fails (%s)', async identifier => {
        const foreign = await createPlainArtifactHomeFixture('https://context-set-foreign.test'); fixtures.push(foreign);
        const active = await createPlainArtifactHomeFixture('https://context-set-active.test'); fixtures.push(active);
        if (identifier === 'legacy-id') {
            const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
            await setServerProfileIdentityForUrl(foreign.home.serverUrl, 'srv_context_set_foreign');
        }
        await seed(foreign, 'memory_doc.v1', 'Foreign memory', 'memory');
        await seed(foreign, 'prompt_doc.v2', 'Foreign notes', 'notes');
        await seed(foreign, 'prompt_doc.v2', 'New notes', 'added');
        let hold: ReturnType<typeof createDeferred<void>> | null = null;
        let failed = false;
        let reads = 0;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (url.pathname === '/v1/artifacts/read') {
                reads++;
                if (hold) await hold.promise;
                if (failed) return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return await (url.origin === active.home.serverUrl ? active : foreign).boundary.handle(`${url.pathname}${url.search}`, init)
                ?? Response.json({ error: 'not_found' }, { status: 404 });
        });
        const { usePromptStackEntryPresentations } = await import('./promptStackEntryPresentation');
        const entries = ['memory', 'notes', 'added'].map(id => ({ id,
            ref: { kind: 'doc' as const, artifactId: id, serverId: foreign.home.id },
            enabled: true, placement: 'system_append' as const }));
        const hook = await renderHook((requested: typeof entries) => usePromptStackEntryPresentations(requested, active.home.id),
            { initialProps: entries.slice(0, 2) });
        const retained = () => {
            expect(hook.getCurrent()(entries[0]!)).toMatchObject({ title: 'Foreign memory', kind: 'memory' });
            expect(hook.getCurrent()(entries[1]!)).toMatchObject({ title: 'Foreign notes', kind: 'doc' });
        };
        try {
            await vi.waitFor(retained);
            expect(reads).toBe(1);
            hold = createDeferred<void>();
            const before = reads;
            await hook.rerender([entries[1]!, entries[0]!, entries[2]!]);
            await vi.waitFor(() => expect(reads).toBe(before + 1));
            retained();
            expect(hook.getCurrent()(entries[2]!).kind).toBe('unknown');
            expect(hook.getCurrent().status(entries[2]!)).toBe('loading');
            failed = true;
            hold.resolve(); hold = null;
            await vi.waitFor(() => expect(hook.getCurrent().status(entries[2]!)).toBe('unavailable'));
            retained();
            failed = false;
            await React.act(async () => publishHomeAccountChange(foreign.home.id, ['added'], { changeKinds: ['artifact'] }));
            await vi.waitFor(() => expect(hook.getCurrent()(entries[2]!).title).toBe('New notes'));
            expect(hook.getCurrent().status(entries[2]!)).toBe('ready');
            hold = createDeferred<void>();
            await hook.rerender([entries[0]!, entries[1]!]);
            retained();
            expect(hook.getCurrent()(entries[2]!).kind).toBe('unknown');
            await React.act(async () => { retireActiveServerAccountScopeLifetime(); storage.setState({ profileScope: null }); });
            expect(hook.getCurrent()(entries[0]!).kind).toBe('unknown');
            expect(hook.getCurrent()(entries[1]!).kind).toBe('unknown');
        } finally { hold?.resolve(); await hook.unmount(); }
    });
    it('projects requested Context headers only, ignores unrelated changes, retains refresh facts and clears a revoked ref', async () => {
        const foreign = await createPlainArtifactHomeFixture('https://context-cost-foreign.test'); fixtures.push(foreign);
        const active = await createPlainArtifactHomeFixture('https://context-cost-active.test'); fixtures.push(active);
        await seed(foreign, 'memory_doc.v1', 'Foreign memory');
        await Promise.all(Array.from({ length: 1001 }, (_, index) => foreign.boundary.handle('/v1/artifacts', {
            method: 'POST', body: JSON.stringify({ id: `other-${index}`,
                header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Other' }),
                body: 'unreadable body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }),
        })));
        const local = { id: 'local', title: 'Local', header: { kind: 'prompt_doc.v2', title: 'Local' },
            rawHeader: { kind: 'prompt_doc.v2', title: 'Local' }, isDecrypted: true as const,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([local, ...Array.from({ length: 3500 }, (_, index) => ({ ...local, id: `unrelated-${index}` }))]);
        const reads: Array<{ path: string; body: unknown }> = [];
        let hold: ReturnType<typeof createDeferred<void>> | null = null;
        let refuseHeaders = false;
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            if (url.pathname.startsWith('/v1/artifacts')) {
                reads.push({ path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
                if (hold) await hold.promise;
                if (refuseHeaders && url.pathname === '/v1/artifacts/read') return Response.json({ error: 'unavailable' }, { status: 503 });
            }
            return await (url.origin === 'https://context-cost-active.test' ? active : foreign).boundary.handle(`${url.pathname}${url.search}`, init)
                ?? Response.json({ error: 'not_found' }, { status: 404 });
        });
        const { usePromptStackEntryPresentations } = await import('./promptStackEntryPresentation');
        const choices = await import('./promptStackDocumentChoices');
        const classification = vi.spyOn(choices, 'promptStackArtifactPresentation');
        const entries = [
            { id: 'local', ref: { kind: 'doc' as const, artifactId: 'local' }, placement: 'system_append' as const, enabled: true },
            { id: 'foreign', ref: { kind: 'doc' as const, artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append' as const, enabled: true },
            { id: 'missing', ref: { kind: 'doc' as const, artifactId: 'missing', serverId: foreign.home.id }, placement: 'system_append' as const, enabled: true },
        ];
        let renders = 0;
        const hook = await renderHook(() => { renders++; return usePromptStackEntryPresentations(entries, active.home.id); });
        try {
            await vi.waitFor(() => expect(hook.getCurrent()(entries[1]!).title).toBe('Foreign memory'));
            expect(reads).toEqual([{ path: '/v1/artifacts/read', body: { artifactIds: ['same-id', 'missing'], projection: 'headers' } }]);
            classification.mockClear(); reads.length = 0;
            const before = hook.getCurrent();
            await React.act(async () => {
                storage.getState().updateArtifact({ ...local, id: 'unrelated-1', headerVersion: 2 });
                publishHomeAccountChange(foreign.home.id, ['other-1'], { changeKinds: ['artifact'] });
                publishHomeAccountChange(foreign.home.id, ['session-unrelated'], { changeKinds: ['session'], profileCatalogAffects: false });
            });
            await flushHookEffects();
            expect(classification).not.toHaveBeenCalled();
            expect(reads).toEqual([]);
            expect(hook.getCurrent()).toBe(before);
            hold = createDeferred<void>();
            await React.act(async () => publishHomeAccountChange(foreign.home.id, ['same-id'], { changeKinds: ['artifact'] }));
            await vi.waitFor(() => expect(reads).toHaveLength(1));
            expect(hook.getCurrent()(entries[1]!).title).toBe('Foreign memory');
            hold.resolve(); hold = null;
            await flushHookEffects();
            const beforeFailure = renders;
            reads.length = 0;
            refuseHeaders = true;
            await React.act(async () => publishHomeAccountChange(foreign.home.id, ['same-id'], { changeKinds: ['artifact'] }));
            await vi.waitFor(() => expect(reads).toHaveLength(1));
            await flushHookEffects();
            expect(hook.getCurrent()(entries[1]!).title).toBe('Foreign memory');
            expect(renders).toBe(beforeFailure);
            refuseHeaders = false;
            await foreign.boundary.handle('/v1/artifacts/same-id', { method: 'DELETE' });
            await React.act(async () => publishHomeAccountChange(foreign.home.id, ['same-id'], { changeKinds: ['artifact'] }));
            await vi.waitFor(() => expect(hook.getCurrent()(entries[1]!).kind).toBe('unknown'));
            expect(hook.getCurrent()(entries[0]!).title).toBe('Local');
        } finally { hold?.resolve(); await hook.unmount(); }
    });
    it('offers documents and memory in Context, excludes skill bundles, and limits Instructions to documents', async () => {
        const active = await createPlainArtifactHomeFixture('https://context-kinds.test'); fixtures.push(active);
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([
            ['doc', 'prompt_doc.v2'], ['skill', 'prompt_bundle.v2'], ['memory', 'memory_doc.v1'], ['other', 'workflow-definition.v1'],
        ].map(([id, kind]) => ({ id: id!, title: id!, header: { kind, title: id, ...(kind === 'prompt_bundle.v2' ? { bundleSchemaId: 'skills.skill_md_v1' } : {}) }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 })));
        const menu = await renderScreen(<PromptStackDocumentMenu testID="all-context" anchorRef={{ current: null }}
            serverId={active.home.id} attachedRefs={[]} onClose={() => {}} onPick={() => {}} />);
        expect(menu.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(['doc', 'memory']);
        const onAttach = vi.fn();
        const instructions = await renderScreen(<AttachExistingMenu anchorRef={{ current: null }} serverId={active.home.id}
            onClose={() => {}} onAttach={onAttach} />);
        const instructionMenu = instructions.findByType(DropdownMenu);
        expect(instructionMenu.props.items.map((item: { id: string }) => item.id)).toEqual(['doc']);
        instructionMenu.props.onSelect('memory');
        expect(onAttach).not.toHaveBeenCalled();
    });
    it('does not relabel the active Artifact inventory as another menu Home', async () => {
        const active = await createPlainArtifactHomeFixture('https://context-picker-active.test'); fixtures.push(active);
        storage.setState({ isDataReady: true });
        seedAdmittedArtifactRows([{ id: 'same-id', title: 'Active instructions',
            header: { kind: 'prompt_doc.v2', title: 'Active instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }], storage);
        const onPick = vi.fn();
        const screen = await renderScreen(<PromptStackDocumentMenu testID="qualified-picker" anchorRef={{ current: null }}
            serverId="other-home" attachedRefs={[]} onClose={() => {}} onPick={onPick} />);
        const menu = screen.findByType(DropdownMenu);
        expect(menu.props.items).toEqual([]);
        menu.props.onSelect('same-id');
        expect(onPick).not.toHaveBeenCalled();
    });
    it('does not hide this Home document when only an equal-id foreign document is attached to the Session', async () => {
        const foreign = await createPlainArtifactHomeFixture('https://context-exclusion-foreign.test'); fixtures.push(foreign);
        const active = await createPlainArtifactHomeFixture('https://context-exclusion-active.test'); fixtures.push(active);
        storage.setState({ isDataReady: true });
        seedAdmittedArtifactRows([{ id: 'same-id', title: 'Local instructions',
            header: { kind: 'prompt_doc.v2', title: 'Local instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }], storage);
        const session = createSessionFixture({ id: 'session-exclusion' });
        if (!session.metadata) throw new Error('Missing Session fixture metadata');
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><SessionContextSection serverId={active.home.id} session={{ ...session,
            metadata: { ...session.metadata, work: { promptStack: [{ id: 'foreign',
                ref: { kind: 'doc', artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append', enabled: true }] } } }} /></InjectedAuthProvider>);
        const add = screen.findAllByTestId('session-work-context.add').find(node => typeof node.props.onPress === 'function');
        expect(add).toBeDefined();
        await React.act(async () => { add!.props.onPress(); });
        expect(screen.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toContain('same-id');
    });
    it('shows and opens equal-id documents on their actual Homes using header-only reads', async () => {
        const foreign = await createPlainArtifactHomeFixture('https://context-foreign.test'); fixtures.push(foreign);
        const active = await createPlainArtifactHomeFixture('https://context-active.test'); fixtures.push(active);
        await seed(active, 'prompt_doc.v2', 'Active instructions');
        await seed(foreign, 'memory_doc.v1', 'Foreign memory');
        const requests: string[] = [];
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/health' || url.pathname === '/v1/features' || url.pathname === '/v1/auth/ping') return Response.json({});
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
            const target = url.origin === 'https://context-active.test' ? active : foreign;
            const path = `${url.pathname}${url.search}`;
            requests.push(path);
            return await target.boundary.handle(path, init) ?? Response.json({ error: 'not_found' }, { status: 404 });
        });
        const scope = { serverId: active.home.id, accountId: 'artifact-account' };
        storage.setState({ isDataReady: true, settingsVersion: 7 });
        seedAdmittedArtifactRows([{ id: 'same-id', title: 'Active instructions',
            header: { kind: 'prompt_doc.v2', title: 'Active instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }], storage);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'voice',
            value: { v: 1, scope: { kind: 'voice' }, entries: [
                { id: 'active', ref: { kind: 'doc', artifactId: 'same-id' }, placement: 'system_append', enabled: true },
                { id: 'foreign', ref: { kind: 'doc', artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append', enabled: true },
                { id: 'unknown', ref: { kind: 'doc', artifactId: 'missing', serverId: foreign.home.id }, placement: 'system_append', enabled: true },
            ] } } }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        const screen = await renderScreen(<InjectedAuthProvider credentials={null}><PromptStackEditorScreen surface="voice" title="Voice" /></InjectedAuthProvider>);
        const title = (id: string) => screen.findAllByTestId(`promptStack.entry.${id}`).map(node => node.props.title).find(value => typeof value === 'string');
        expect(title('active')).toBe('Active instructions');
        await vi.waitFor(() => expect(title('foreign')).toBe('Foreign memory'));
        expect(title('active')).toBe('Active instructions');
        const headerReads = () => requests.filter(path => path === '/v1/artifacts/read').length;
        const readsBeforeUnrelatedChanges = headerReads();
        await React.act(async () => {
            for (let index = 0; index < 8; index++) publishHomeAccountChange(foreign.home.id, [`session-${index}`], {
                changeKinds: ['session'], profileCatalogAffects: false,
            });
        });
        await flushHookEffects();
        expect(title('foreign')).toBe('Foreign memory');
        expect(headerReads()).toBe(readsBeforeUnrelatedChanges);
        const actions = screen.findAllByType(ItemRowActions);
        const edit = actions[1]?.props.actions.find((action: { id: string }) => action.id === 'edit');
        expect(edit).toBeDefined();
        edit.onPress();
        expect(promptStacksRouterPushSpy).toHaveBeenCalledWith(`/settings/prompts/memory/same-id?serverId=${encodeURIComponent(foreign.home.id)}`);
        expect(requests.some(path => path === '/v1/artifacts/read')).toBe(true);
        expect(requests.some(path => path.startsWith('/v1/artifacts?'))).toBe(false);
        expect(requests.some(path => path.includes('includeBody=true') || path.startsWith('/v1/artifacts/same-id'))).toBe(false);
        expect(actions[2]?.props.actions.some((action: { id: string }) => action.id === 'edit')).toBe(false);
        const entries = [
            { id: 'active', ref: { kind: 'doc' as const, artifactId: 'same-id' }, placement: 'system_append' as const, enabled: true },
            { id: 'foreign', ref: { kind: 'doc' as const, artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append' as const, enabled: true },
            { id: 'unknown', ref: { kind: 'doc' as const, artifactId: 'missing', serverId: foreign.home.id }, placement: 'system_append' as const, enabled: true },
        ];
        const hook = await renderHook(() => useSessionContextLayers({ sessionId: 'session', serverId: active.home.id,
            ownerMetadata: { work: { memoryEnabled: false, promptStack: entries } }, metadataVersion: 1 }));
        await vi.waitFor(() => expect(hook.getCurrent().session.map(row => [row.kind, row.title, row.off])).toEqual([
            ['doc', 'Active instructions', null], ['memory', 'Foreign memory', 'memory'], ['unknown', null, null],
        ]));
        await foreign.boundary.handle('/v1/artifacts/same-id', { method: 'POST', body: JSON.stringify({
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Changed foreign instructions' }),
            expectedHeaderVersion: 1,
        }) });
        await React.act(async () => { publishHomeAccountChange(foreign.home.id); });
        await vi.waitFor(() => expect(hook.getCurrent().session[1]).toMatchObject({
            kind: 'doc', title: 'Changed foreign instructions', on: true, off: null,
        }));
        const session = createSessionFixture({ id: 'session' });
        if (!session.metadata) throw new Error('Missing Session fixture metadata');
        const workScreen = await renderScreen(<InjectedAuthProvider credentials={null}><SessionContextSection serverId={active.home.id}
            session={{ ...session, metadata: { ...session.metadata, work: { promptStack: entries } } }} /></InjectedAuthProvider>);
        let open: (() => void) | undefined;
        await vi.waitFor(() => {
            open = workScreen.findAllByTestId('session-work-context.entry.session.foreign')
                .find(node => typeof node.props.onPress === 'function')?.props.onPress;
            expect(open).toBeDefined();
        });
        promptStacksRouterPushSpy.mockClear();
        await React.act(async () => {
            retireActiveServerAccountScopeLifetime();
            open?.();
            expect(promptStacksRouterPushSpy).not.toHaveBeenCalled();
        });
    });
});
