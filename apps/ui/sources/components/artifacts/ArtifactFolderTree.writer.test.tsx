// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests, refreshPromptLibraryCatalog, invalidatePromptLibraryCatalogProjection } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { ArtifactFolderTree, useArtifactFolderCommands, type ArtifactFolderTreeHandle } from './ArtifactFolderTree';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ArtifactsBrowser } from './ArtifactsBrowserScreen';
import { ModalProvider } from '@/modal';

const navigation = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }));
// Only platform/rendering boundaries are replaced. Storage and the real ModalProvider stay
// unmocked: an async importActual mock of the modal barrel can await its own import graph.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', ScrollView: 'ScrollView', TextInput: 'TextInput',
        Platform: { OS: 'web', select: ({ web, default: fallback }: { web?: unknown; default?: unknown }) => web ?? fallback } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
// Browser portal transport is outside the renderer's host tree; retain the actual modal,
// focus/dismissal components and form while projecting their portal children into this tree.
vi.mock('@/utils/web/reactDomCjs', () => {
    const portal = { createPortal: (children: React.ReactNode) => children };
    return { requireReactDOM: () => portal, preloadReactDOM: async () => portal };
});
// Popover rendering is a platform boundary; the menu choices and command owner remain real.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

/** The page's one New folder control (the browser toolbar draws it): the tree itself carries no invite. */
function FolderCreateControl(props: Readonly<{ tree: React.RefObject<ArtifactFolderTreeHandle | null> }>) {
    const commands = useArtifactFolderCommands();
    return <ReactNativeButton testID="folders:create" disabled={!commands.canWrite} onPress={() => props.tree.current?.createFolder(null)} />;
}
function ReactNativeButton(props: Readonly<{ testID: string; disabled: boolean; onPress: () => void }>) {
    return React.createElement('Pressable', { ...props, accessibilityRole: 'button' });
}

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let webLocks: WebLockManagerMockHandle | undefined;
let homeCount = 0;
beforeEach(() => {
    webLocks = installWebLockManagerMock();
});
afterEach(async () => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    await fixture?.dispose(); fixture = undefined;
    webLocks?.restore(); webLocks = undefined;
    vi.clearAllMocks();
});

async function setup(kind: 'all' | 'prompt', initial: readonly { id: string; name: string; parentId: string | null }[] = [], browser = false, askFirst = false, holdFirstRead = false) {
    const boundary = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1, folders: [...initial] } }], revision: 4 });
    let outcome: 'updated' | 'conflict' | 'failed' = 'updated';
    let holdReads: Promise<void> | null = null;
    let holdWrites: Promise<void> | null = null;
    let catalogReads = 0;
    let releaseFirstRead: () => void = () => {};
    if (holdFirstRead) holdReads = new Promise<void>(resolve => { releaseFirstRead = () => { holdReads = null; resolve(); }; });
    fixture = await createPlainArtifactHomeFixture(`https://inline-folders-${++homeCount}.test`, { handleRequest: async (path, init) => {
        if (path === '/v2/account/settings' && askFirst) return Response.json({ version: 0, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'artifact.folders.create': { approvalRequiredSurfaces: ['ui'] } } },
        } } });
        if (path === '/v1/account/entity-rows/prompt-library') {
            catalogReads++;
            const response = await boundary.handle(path, init);
            if (holdReads) await holdReads;
            return response;
        }
        if (path === '/v1/account/entity-rows/prompt-library/folders' && init?.method === 'POST') {
            if (holdWrites) await holdWrites;
            if (outcome === 'conflict') return Response.json({ status: 'conflict', revision: 4 });
            if (outcome === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        return boundary.handle(path, init);
    } });
    if (askFirst) await fixture.hydrateAccountSettings();
    const testID = browser ? 'artifacts:folders' : 'folders';
    const treeRef = React.createRef<ArtifactFolderTreeHandle>();
    const screen = await renderScreen(<ModalProvider>{browser ? <AppPaneProvider><ArtifactsBrowser artifacts={[{
        id: 'document', title: 'Notes', isDecrypted: true, header: { title: 'Notes' }, headerVersion: 1,
        bodyVersion: 1, seq: 1, body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain',
    }]} loaded loadFailed={false} onRetry={() => {}} usage={null} /></AppPaneProvider>
        : <CoreCollectionScope><FolderCreateControl tree={treeRef} /><ArtifactFolderTree ref={treeRef} testID={testID} accessibilityLabel="Folders"
            filter={{ query: '', kind, sort: 'title_asc' }} onOpenArtifact={() => {}} /></CoreCollectionScope>}</ModalProvider>);
    if (browser) await screen.pressByTestIdAsync('artifacts:view:folders');
    const createControl = browser ? 'artifacts:folders:new' : 'folders:create';
    if (!holdFirstRead) await vi.waitFor(() => expect(initial.length ? screen.findByTestId(`${testID}:row:folder:${initial[0]!.id}`)
        : screen.findAll(node => node.props.testID === createControl && node.props.disabled === false).length).toBeTruthy());
    const read = () => {
        const record = boundary.read('folders');
        if (record.key !== 'folders') throw new Error('Wrong record');
        return record.value;
    };
    const changeName = async (name: string) => {
        await act(async () => { screen.findByTestId(`${testID}:edit:name`)!.props.onChangeText(name); });
    };
    const select = async (id: string, folderId = 'original') => {
        const menu = screen.findAll(node => node.props.testID === `folders:menu:folder:${folderId}` && typeof node.props.onSelect === 'function')[0];
        await act(async () => { menu!.props.onSelect(id); });
    };
    return { screen, read, boundary, changeName, select, releaseFirstRead, readCount: () => catalogReads,
        setOutcome: (next: typeof outcome) => { outcome = next; },
        holdCatalogWrites: () => {
            let release!: () => void;
            holdWrites = new Promise<void>(resolve => { release = resolve; });
            return () => { holdWrites = null; release(); };
        },
        holdCatalogReads: () => {
            let release!: () => void;
            holdReads = new Promise<void>(resolve => { release = resolve; });
            return () => { holdReads = null; release(); };
        } };
}

it('Retry requests fresh folder authority instead of only joining the read already on screen', async () => {
    const state = await setup('all', [{ id: 'original', name: 'Original', parentId: null }]);
    const { storage } = await import('@/sync/domains/state/storage');
    const release = state.holdCatalogReads();
    const before = state.readCount();
    const pending = invalidatePromptLibraryCatalogProjection(storage.getState().settingsScope!);
    try {
        await vi.waitFor(() => expect(state.readCount()).toBe(before + 1));
        const line = state.screen.findAll(node => typeof node.type === 'function' && node.type.name === 'SurfaceFreshnessLine')
            .find(node => node.props.testID === 'folders:unavailable');
        expect(line).toBeDefined();
        await act(async () => { line!.props.action.onPress(); });
        expect(await state.boundary.handle('/v1/account/entity-rows/prompt-library/folders', {
            method: 'POST', body: JSON.stringify({ expectedRevision: 4, content: { t: 'plain', v: {
                key: 'folders', value: { v: 1, folders: [
                    { id: 'original', name: 'Original', parentId: null },
                    { id: 'remote', name: 'Added remotely', parentId: null },
                ] },
            } } }),
        })).toMatchObject({ status: 200 });
        release();
        await pending;
        await vi.waitFor(() => expect(state.readCount()).toBe(before + 2));
        expect(state.screen.findByTestId('folders:row:folder:original')).toBeTruthy();
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:row:folder:remote')).toBeTruthy());
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:unavailable')).toBeNull());
    } finally { release(); await pending; }
});

it('uses current catalog authority and settles its durable receipt before a held refresh', async () => {
    const state = await setup('all');
    await state.screen.pressByTestIdAsync('folders:create');
    await state.changeName('Receipt folder');
    const release = state.holdCatalogReads();
    try {
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.read().folders[0]?.name).toBe('Receipt folder'));
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        expect(state.screen.findByTestId('folders:row:folder:' + state.read().folders[0]!.id)).toBeTruthy();
        // An acknowledged write confirms its own row (it starts no catalog refresh), so the held read
        // neither blocks the next write nor puts the folders behind an unavailable line.
        expect(state.screen.findByTestId('folders:unavailable')).toBeNull();
    } finally { await act(async () => { release(); }); }
    await vi.waitFor(() => expect(state.screen.findByTestId('folders:unavailable')).toBeNull());
});

it('holds the tree rows in place until the folders are first read, then draws them grouped', async () => {
    const state = await setup('all', [{ id: 'filed', name: 'Filed', parentId: null }], true, false, true);
    // Before the folder catalog answers, the Notes document must not be drawn loose at the top level:
    // it would jump under its folder once the folders arrive.
    await vi.waitFor(() => expect(state.screen.findByTestId('artifacts:folders:loading')).toBeTruthy());
    expect(state.screen.findByTestId('artifacts:folders:row:artifact:document')).toBeNull();
    await act(async () => { state.releaseFirstRead(); });
    await vi.waitFor(() => expect(state.screen.findByTestId('artifacts:folders:row:folder:filed')).toBeTruthy());
    expect(state.screen.findByTestId('artifacts:folders:loading')).toBeNull();
});

it('removes an empty folder directly through its safe Action', async () => {
    const state = await setup('all', [{ id: 'original', name: 'Original', parentId: null }]);
    await state.select('delete');
    await vi.waitFor(() => expect(state.read().folders).toEqual([]));
    expect(state.boundary.requests).toHaveLength(1);
    expect(state.screen.findAll(node => node.props.accessibilityRole === 'dialog')).toEqual([]);
});

it.each(['all', 'prompt'] as const)('inserts New folder into the shared tree (%s)', async kind => {
    const state = await setup(kind);
    await state.screen.pressByTestIdAsync('folders:create');
    expect(state.screen.findByTestId('folders:edit:modal')).toBeNull();
    expect(state.screen.findByTestId('folders:edit:name')).toBeTruthy();
    const tree = state.screen.findByTestId('folders:sheet')!;
    expect(tree.findAll(node => node.props.testID === 'folders:edit:name').length).toBeGreaterThan(0);
    await state.screen.pressByTestIdAsync('folders:edit:cancel');
    await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
    expect(state.read().folders).toEqual([]);
});

it('keeps a draft while stale and refuses submission until the canonical refresh completes', async () => {
    const state = await setup('all');
    await state.screen.pressByTestIdAsync('folders:create');
    await state.changeName('Reviewed after refresh');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = storage.getState().settingsScope!;
    const release = state.holdCatalogReads();
    let refresh!: Promise<void>;
    try {
        await act(async () => { refresh = refreshPromptLibraryCatalog(scope); });
        expect(state.screen.findByTestId('folders:edit:save')!.props.disabled).toBe(true);
        expect(state.screen.findByTestId('folders:unavailable-action')).toBeTruthy();
        // The folders on screen are the last-known ones: said as one quiet line, not as an unavailable failure.
        expect(state.screen.getTextContent()).toContain('artifacts.browser.folders.lastKnown');
        expect(state.screen.getTextContent()).not.toContain('artifacts.browser.folders.refusedUnavailable');
        await act(async () => { state.screen.findByTestId('folders:edit:name')!.props.onSubmitEditing(); });
        expect(state.boundary.requests).toEqual([]);
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('Reviewed after refresh');
    } finally { await act(async () => { release(); await refresh; }); }
    await state.screen.pressByTestIdAsync('folders:edit:save');
    await vi.waitFor(() => expect(state.read().folders[0]?.name).toBe('Reviewed after refresh'));
});

it('keeps the explicit-Ask UI create draft pending until persistence acknowledges it without an approval Artifact', async () => {
    const state = await setup('all', [], false, true);
    const release = state.holdCatalogWrites();
    try {
        await state.screen.pressByTestIdAsync('folders:create');
        await state.changeName('Approval folder');
        expect(state.read().folders).toEqual([]);
        expect(state.boundary.requests).toEqual([]);
        // a4a360ea3cc retains saved Ask through native confirmation; 02102e614e1 removed self-approval Artifacts.
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(fixture!.requests.filter(request =>
            request.method === 'POST' && request.path === '/v1/account/entity-rows/prompt-library/folders')).toEqual([]);
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('Approval folder');
        expect(state.read().folders).toEqual([]);
        expect(fixture!.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();

        await state.screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await vi.waitFor(() => expect(fixture!.requests.filter(request =>
            request.method === 'POST' && request.path === '/v1/account/entity-rows/prompt-library/folders')).toHaveLength(1));
        expect(state.screen.findByTestId('folders:edit:name')!.props.editable).toBe(false);
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('Approval folder');
        expect(state.screen.findHostByTestId('folders:edit:save')!.props.accessibilityState)
            .toMatchObject({ busy: true, disabled: true });
        expect(state.screen.findByTestId('folders:edit:name.error')).toBeNull();
        expect(state.screen.findByTestId('folders:edit:approval')).toBeNull();
        expect(state.read().folders).toEqual([]);
        expect(fixture!.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();

        await act(async () => { release(); });
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        expect(state.read().folders).toEqual([expect.objectContaining({ name: 'Approval folder', parentId: null })]);
        expect(state.boundary.requests).toHaveLength(1);
        expect(fixture!.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();
    } finally { await act(async () => { release(); }); }
});

describe.each(['all', 'prompt'] as const)('shared folder inline writes (%s)', kind => {
    it('renames a just-settled create without reloading the tree', async () => {
        const state = await setup(kind);
        await state.screen.pressByTestIdAsync('folders:create');
        await state.changeName('r2-folder-created');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        const created = state.read().folders[0]!;
        await state.select('rename', created.id);
        await state.changeName('r2-folder-renamed');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        expect(state.read().folders).toEqual([expect.objectContaining({ id: created.id, name: 'r2-folder-renamed' })]);
        expect(state.boundary.requests.map(request => request.expectedRevision)).toEqual([4, 5]);
    });

    it('refreshes a stale revision refusal and keeps the rename draft retryable', async () => {
        const state = await setup(kind, [{ id: 'original', name: 'Original', parentId: null }]);
        await state.select('rename');
        await state.changeName('  r2-folder   retry  ');
        // Another client advances the real row boundary after this tree reviewed revision 4.
        await state.boundary.handle('/v1/account/entity-rows/prompt-library/folders', { method: 'POST', body: JSON.stringify({
            expectedRevision: 4, content: { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [
                { id: 'original', name: 'Original', parentId: null }, { id: 'neighbor', name: 'Neighbor', parentId: null },
            ] } } },
        }) });
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:refused')).toBeTruthy());
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('  r2-folder   retry  ');
        expect(state.read().folders[0]!.name).toBe('Original');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        expect(state.read().folders).toEqual([
            expect.objectContaining({ id: 'original', name: 'r2-folder retry' }),
            expect.objectContaining({ id: 'neighbor', name: 'Neighbor' }),
        ]);
        expect(state.boundary.requests.map(request => request.expectedRevision)).toEqual([4, 4, 5]);
    });

    it('creates only on Save, normalizes names, and reuses an existing folder', async () => {
        const { screen, read, boundary, changeName, select } = await setup(kind);
        await screen.pressByTestIdAsync('folders:create');
        expect(screen.findByTestId('folders:edit:name')).toBeTruthy();
        await changeName('  Release   notes  ');
        expect(read().folders).toEqual([]);
        expect(boundary.requests).toEqual([]);
        await screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(read().folders).toEqual([expect.objectContaining({ name: 'Release notes', parentId: null })]));
        await vi.waitFor(() => expect(screen.findByTestId('folders:edit:name')).toBeNull());
        const folderId = read().folders[0]!.id;
        await select('newInside', folderId);
        const tree = screen.findByTestId('folders:sheet')!;
        expect(tree.findAll(node => node.props.testID === 'folders:edit:name').length).toBeGreaterThan(0);
        await changeName('release NOTES');
        await screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(screen.findByTestId('folders:edit:name')).toBeNull());
        expect(read().folders).toHaveLength(1);
        expect(boundary.requests).toHaveLength(1);
        await select('newInside', folderId);
        await changeName('Discard this child');
        await act(async () => { screen.findByTestId('folders:edit:name')!.props.onKeyPress({ nativeEvent: { key: 'Escape' } }); });
        await vi.waitFor(() => expect(screen.findByTestId('folders:edit:name')).toBeNull());
        expect(boundary.requests).toHaveLength(1);
        await select('newInside', folderId);
        await changeName('Child folder');
        await act(async () => { screen.findByTestId('folders:edit:name')!.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(read().folders).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Child folder', parentId: folderId }),
        ])));
    });

    it('files the entry into the folder the Move chooser\'s New folder… creates', async () => {
        const state = await setup(kind, [
            { id: 'original', name: 'Original', parentId: null },
            { id: 'child', name: 'Child', parentId: 'original' },
        ]);
        await state.select('move:new', 'child');
        await state.changeName('Fresh home');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        await vi.waitFor(() => {
            const fresh = state.read().folders.find(folder => folder.name === 'Fresh home');
            expect(fresh).toEqual(expect.objectContaining({ parentId: null }));
            expect(state.read().folders.find(folder => folder.id === 'child')?.parentId).toBe(fresh!.id);
        });
    });

    it('retires a child-create draft when its parent identity is replaced', async () => {
        const state = await setup(kind, [{ id: 'original', name: 'Original', parentId: null }]);
        await state.select('newInside');
        await state.changeName('Retire this child');
        await state.boundary.handle('/v1/account/entity-rows/prompt-library/folders', { method: 'POST', body: JSON.stringify({
            expectedRevision: 4, content: { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [{ id: 'replacement', name: 'Replacement', parentId: null }] } } },
        }) });
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => { await refreshPromptLibraryCatalog(storage.getState().settingsScope!); });
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        await state.select('newInside', 'replacement');
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('');
    });

    it.each(['conflict', 'failed'] as const)('keeps the create draft and typed refusal after %s, then saves on retry', async outcome => {
        const state = await setup(kind);
        state.setOutcome(outcome);
        await state.screen.pressByTestIdAsync('folders:create');
        await state.changeName('  Keep   my draft  ');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:refused')).toBeTruthy());
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('  Keep   my draft  ');
        expect(state.read().folders).toEqual([]);
        state.setOutcome('updated');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.read().folders[0]?.name).toBe('Keep my draft'));
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
    });

    it('keeps a refused rename, submits on Enter, cancels on Escape, and retires a replaced folder identity', async () => {
        const state = await setup(kind, [{ id: 'original', name: 'Original', parentId: null }]);
        await state.select('rename');
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('Original');
        await state.changeName('  Renamed   folder  ');
        state.setOutcome('conflict');
        await act(async () => { state.screen.findByTestId('folders:edit:name')!.props.onSubmitEditing(); });
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:refused')).toBeTruthy());
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('  Renamed   folder  ');
        state.setOutcome('updated');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.read().folders[0]?.name).toBe('Renamed folder'));
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        await state.select('rename');
        await state.changeName('Cancelled');
        await act(async () => { state.screen.findByTestId('folders:edit:name')!.props.onKeyPress({ nativeEvent: { key: 'Escape' } }); });
        expect(state.screen.findByTestId('folders:edit:name')).toBeNull();
        expect(state.read().folders[0]?.name).toBe('Renamed folder');
        await state.select('rename');
        await state.changeName('Retire this draft');
        await state.boundary.handle('/v1/account/entity-rows/prompt-library/folders', { method: 'POST', body: JSON.stringify({
            expectedRevision: 5, content: { t: 'plain', v: { key: 'folders', value: { v: 1, folders: [{ id: 'replacement', name: 'Replacement', parentId: null }] } } },
        }) });
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => { await refreshPromptLibraryCatalog(storage.getState().settingsScope!); });
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        await state.select('rename', 'replacement');
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('Replacement');
    });
});

it('lists unfiled entries flat under the page\'s one New folder, with no invite beneath them, while there are no folders (owner 11-11 Artifacts 02)', async () => {
    const state = await setup('all', [], true);
    expect(state.screen.findByTestId('artifacts:folders:row:artifact:document')).toBeTruthy();
    expect(state.screen.findAll(node => node.props.testID === 'artifacts:folders:new' && node.props.disabled === false).length).toBeGreaterThan(0);
    expect(state.screen.findByTestId('artifacts:folders:invite')).toBeNull();
    expect(state.screen.getTextContent()).not.toContain('artifacts.browser.folders.emptyInvite');
});

it('starts the same inline editor from the Artifacts browser toolbar', async () => {
    const state = await setup('all', [], true);
    await state.screen.pressByTestIdAsync('artifacts:folders:new');
    expect(state.screen.findByTestId('artifacts:folders:edit:modal')).toBeNull();
    expect(state.screen.findByTestId('artifacts:folders:sheet')!.findAll(node => node.props.testID === 'artifacts:folders:edit:name').length).toBeGreaterThan(0);
    await state.changeName('  Browser   folder  ');
    expect(state.read().folders).toEqual([]);
    await state.screen.pressByTestIdAsync('artifacts:folders:edit:save');
    await vi.waitFor(() => expect(state.read().folders).toEqual([
        expect.objectContaining({ name: 'Browser folder', parentId: null }),
    ]));
    await vi.waitFor(() => expect(state.screen.findByTestId('artifacts:folders:edit:name')).toBeNull());
});

it('says an open folder is empty instead of opening onto nothing, and drops the line once it is closed', async () => {
    const state = await setup('all', [{ id: 'postmortems', name: 'Postmortems', parentId: null }]);
    const empty = state.screen.findByTestId('folders:row:empty:folder:postmortems');
    expect(empty).toBeTruthy();
    expect(empty!.props.accessibilityLabel).toBe('artifacts.browser.folders.emptyFolder');
    await state.screen.pressByTestIdAsync('folders:disclosure:folder:postmortems');
    await vi.waitFor(() => expect(state.screen.findByTestId('folders:row:empty:folder:postmortems')).toBeNull());
});
