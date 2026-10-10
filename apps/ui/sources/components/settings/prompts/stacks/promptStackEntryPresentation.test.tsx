import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

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
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => async () => {} }));
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});
const { storage } = await import('@/sync/domains/state/storage');
const { PromptStackEditorScreen } = await import('./PromptStackEditorScreen');
const { PromptStackDocumentMenu } = await import('./PromptStackDocumentMenu');
const { useSessionContextLayers } = await import('@/components/sessions/work/context/useSessionContextLayers');
const { SessionContextSection } = await import('@/components/sessions/work/context/SessionContextSection');
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

async function seed(home: Home, kind: string, title: string) {
    await home.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'same-id',
        header: encodePlainArtifactStoredContent({ v: 1, kind, title }),
        // Classification must succeed without opening this deliberately unreadable body.
        body: 'unreadable body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
}

describe('qualified Context presentation', () => {
    it('offers docs, skills and memory in Context but only instruction documents in Instructions', async () => {
        const active = await createPlainArtifactHomeFixture('https://context-kinds.test'); fixtures.push(active);
        storage.setState({ isDataReady: true });
        storage.getState().applyArtifacts([
            ['doc', 'prompt_doc.v2'], ['skill', 'prompt_bundle.v2'], ['memory', 'memory_doc.v1'], ['other', 'workflow-definition.v1'],
        ].map(([id, kind]) => ({ id: id!, title: id!, header: { kind, title: id, ...(kind === 'prompt_bundle.v2' ? { bundleSchemaId: 'skills.skill_md_v1' } : {}) }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 })));
        const menu = await renderScreen(<PromptStackDocumentMenu testID="all-context" anchorRef={{ current: null }}
            serverId={active.home.id} attachedRefs={[]} onClose={() => {}} onPick={() => {}} />);
        expect(menu.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(['doc', 'skill', 'memory']);
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
        storage.setState({ isDataReady: true, artifacts: { 'same-id': { id: 'same-id', title: 'Active instructions',
            header: { kind: 'prompt_doc.v2', title: 'Active instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
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
        storage.setState({ isDataReady: true, artifacts: { 'same-id': { id: 'same-id', title: 'Local instructions',
            header: { kind: 'prompt_doc.v2', title: 'Local instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        const session = createSessionFixture({ id: 'session-exclusion' });
        const screen = await renderScreen(<SessionContextSection serverId={active.home.id} session={{ ...session,
            metadata: { ...session.metadata, work: { promptStack: [{ id: 'foreign',
                ref: { kind: 'doc', artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append', enabled: true }] } } }} />);
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
        storage.setState({ isDataReady: true, artifacts: { 'same-id': { id: 'same-id', title: 'Active instructions',
            header: { kind: 'prompt_doc.v2', title: 'Active instructions' }, isDecrypted: true,
            body: null, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'voice',
            value: { v: 1, scope: { kind: 'voice' }, entries: [
                { id: 'active', ref: { kind: 'doc', artifactId: 'same-id' }, placement: 'system_append', enabled: true },
                { id: 'foreign', ref: { kind: 'doc', artifactId: 'same-id', serverId: foreign.home.id }, placement: 'system_append', enabled: true },
                { id: 'unknown', ref: { kind: 'doc', artifactId: 'missing', serverId: foreign.home.id }, placement: 'system_append', enabled: true },
            ] } } }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: storage.getState().settingsVersion }, true);
        const screen = await renderScreen(<PromptStackEditorScreen surface="voice" title="Voice" />);
        const title = (id: string) => screen.findAllByTestId(`promptStack.entry.${id}`).map(node => node.props.title).find(value => typeof value === 'string');
        expect(title('active')).toBe('Active instructions');
        await vi.waitFor(() => expect(title('foreign')).toBe('Foreign memory'));
        expect(title('active')).toBe('Active instructions');
        const actions = screen.findAllByType(ItemRowActions);
        const edit = actions[1]?.props.actions.find((action: { id: string }) => action.id === 'edit');
        expect(edit).toBeDefined();
        edit.onPress();
        expect(promptStacksRouterPushSpy).toHaveBeenCalledWith(`/settings/prompts/memory/same-id?serverId=${encodeURIComponent(foreign.home.id)}`);
        expect(requests.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
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
        const workScreen = await renderScreen(<SessionContextSection serverId={active.home.id}
            session={{ ...session, metadata: { ...session.metadata, work: { promptStack: entries } } }} />);
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
