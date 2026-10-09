import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { PromptFoldersV1 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { storage } from '@/sync/domains/state/storage';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { installPromptLibrarySettingsCommonModuleMocks } from '../promptLibrarySettingsTestHelpers';

const confirm = vi.hoisted(() => vi.fn(async () => true));
const prompt = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
const alert = vi.hoisted(() => vi.fn());
installPromptLibrarySettingsCommonModuleMocks({
    // Platform presentation is replaced; catalog/store/Actions remain real.
    storage: importOriginal => importOriginal(),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm, prompt, alert } }).module;
    },
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// The menu's popover is platform presentation; its items and selection stay the tree's own.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let homeCount = 0;
afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    fixture?.dispose(); fixture = undefined;
    // Clear, not restore: restoring would strip the Modal boundary's delegation to these case spies.
    vi.clearAllMocks();
});

async function setup() {
    const value: PromptFoldersV1 = { v: 1, folders: [{ id: 'parent', name: 'Ops', parentId: null },
        { id: 'child', name: 'Reviews', parentId: 'parent' }],
        artifactHeadersById: { received: { folderId: 'parent', tags: ['personal'] } } };
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value }], revision: 4 });
    const folderWrites: { statusCode: number; body: unknown }[] = [];
    // A Home per case: a catalog read still settling from the previous case cannot publish into this one.
    fixture = await createPlainArtifactHomeFixture(`https://folder-screen-${++homeCount}.test`, { handleRequest: async (path, init) => {
        const response = await catalog.handle(path, init);
        if (response && path === '/v1/account/entity-rows/prompt-library/folders' && init?.method === 'POST') {
            folderWrites.push({ statusCode: response.status, body: await response.clone().json() });
        }
        return response;
    } });
    await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'legacy',
        header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Legacy', folderId: 'parent', tags: ['legacy'] }),
        body: encodePlainArtifactStoredContent({ body: '{' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }) });
    // The listed Artifacts are the synced store's; the Home holds the same `legacy` row for the Actions.
    storage.setState({ isDataReady: true, artifacts: { legacy: { id: 'legacy', title: 'Legacy',
        header: { title: 'Legacy', kind: 'prompt_doc.v2', folderId: 'parent', tags: ['legacy'] }, access: 'owner',
        ownerAccountId: 'artifact-account', isDecrypted: true, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 },
        received: { id: 'received', title: 'Received',
        header: { title: 'Received', kind: 'workflow-definition.v1', folderId: 'foreign' }, access: 'view',
        isDecrypted: true, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
    return { read: () => { const record = catalog.read('folders'); if (record.key !== 'folders') throw new Error('Wrong catalog'); return record.value; },
        fixture, mutations: catalog.requests, folderWrites };
}

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The row's ⋯ through the shared menu contract: open it, then read the items it offers. */
async function openRowMenu(screen: Screen, key: string) {
    const find = () => {
        const menu = screen.findAll(node => node.props.testID === `promptFolders:menu:${key}` && typeof node.props.onSelect === 'function').at(0);
        if (!menu) throw new Error(`No menu for ${key}`);
        return menu;
    };
    await act(async () => { find().props.onOpenChange(true); });
    const items: readonly DropdownMenuItem[] = find().props.items;
    return { items, select: async (id: string) => { await act(async () => { find().props.onSelect(id); }); } };
}

describe('Prompt folders: the Artifacts folder tree filtered to prompts, through real catalog and Action owners', () => {
    it('lists prompts under their personal folders and leaves other kinds to Artifacts', async () => {
        await setup();
        const { PromptFoldersScreen } = await import('./PromptFoldersScreen');
        const screen = await renderScreen(<PromptFoldersScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptFolders:row:folder:parent')).toBeTruthy());
        await vi.waitFor(() => expect(screen.findByTestId('promptFolders:row:artifact:legacy')).toBeTruthy());
        expect(screen.findByTestId('promptFolders:row:folder:child')).toBeTruthy();
        expect(screen.findByTestId('promptFolders:row:artifact:received')).toBeNull();
    });

    it('names a new folder once, at the current catalog revision, without rewriting settings', async () => {
        const state = await setup();
        const { PromptFoldersScreen } = await import('./PromptFoldersScreen');
        const screen = await renderScreen(<PromptFoldersScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptFolders:row:folder:parent')).toBeTruthy());
        prompt.mockClear();
        alert.mockClear();
        prompt.mockResolvedValueOnce('  Release   notes  ');
        await screen.pressByTestIdAsync('promptFolders.add');
        expect(prompt).toHaveBeenCalledTimes(1);
        // The write and the catalog reread both cross the real Home HTTP boundary.
        await vi.waitFor(() => expect({
            alerts: alert.mock.calls,
            mutations: state.mutations,
            responses: state.folderWrites,
            folder: state.read().folders.find(folder => folder.name === 'Release notes'),
        }).toMatchObject({
            alerts: [],
            mutations: [{ key: 'folders', expectedRevision: 4 }],
            responses: [{ statusCode: 200, body: { status: 'updated', revision: 5 } }],
            folder: { name: 'Release notes', parentId: null },
        }), { timeout: 10_000 });
        await vi.waitFor(() => expect(screen.findByTestId(`promptFolders:row:folder:${state.read().folders.find(folder => folder.name === 'Release notes')?.id}`)).toBeTruthy(), { timeout: 10_000 });
        prompt.mockResolvedValueOnce('release NOTES');
        await screen.pressByTestIdAsync('promptFolders.add');
        expect(prompt).toHaveBeenCalledTimes(2);
        expect(state.read().folders).toHaveLength(3);
        expect(state.read().artifactHeadersById?.received).toEqual({ folderId: 'parent', tags: ['personal'] });
        expect(state.fixture.requests.some(request => request.path === '/v2/account/settings' && request.method !== 'GET')).toBe(false);
    });

    it('moves a prompt through Move to folder…, checks its current place and refuses a folder into itself', async () => {
        const state = await setup();
        const { PromptFoldersScreen } = await import('./PromptFoldersScreen');
        const screen = await renderScreen(<PromptFoldersScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptFolders:row:artifact:legacy')).toBeTruthy());
        const before = state.fixture.boundary.read('legacy');

        const folderMenu = await openRowMenu(screen, 'folder:parent');
        const folderPlaces = folderMenu.items.find(item => item.id === 'move')?.submenu?.items ?? [];
        expect(folderPlaces.find(place => place.title === 'Reviews')).toMatchObject({ disabled: true });
        expect(folderPlaces.find(place => place.checked)).toBeTruthy();

        const menu = await openRowMenu(screen, 'artifact:legacy');
        const places = menu.items.find(item => item.id === 'move')?.submenu?.items ?? [];
        expect(places.find(place => place.title === 'Ops')).toMatchObject({ checked: true, disabled: true });
        const reviews = places.find(place => place.title === 'Reviews');
        expect(reviews).toMatchObject({ disabled: false });
        await menu.select(reviews?.id ?? '');
        await vi.waitFor(() => expect(state.read().artifactHeadersById?.legacy).toMatchObject({ folderId: 'child' }));
        expect(state.fixture.boundary.read('legacy')).toEqual(before);
    });

    it('deletes personal placement, reparents children and leaves even malformed Artifact bodies untouched', async () => {
        const state = await setup();
        const { PromptFoldersScreen } = await import('./PromptFoldersScreen');
        const before = state.fixture.boundary.read('legacy');
        const screen = await renderScreen(<PromptFoldersScreen />);
        await vi.waitFor(() => expect(screen.findByTestId('promptFolders:row:folder:parent')).toBeTruthy());
        const menu = await openRowMenu(screen, 'folder:parent');
        await menu.select('delete');
        await vi.waitFor(() => expect(state.read().folders.find(folder => folder.id === 'parent')).toBeUndefined());
        expect(state.read().folders.find(folder => folder.id === 'child')?.parentId).toBeNull();
        expect(state.read().artifactHeadersById?.received).toEqual({ folderId: null, tags: ['personal'] });
        expect(state.read().artifactHeadersById?.legacy).toEqual({ folderId: null, tags: ['legacy'] });
        expect(state.fixture.boundary.read('legacy')).toEqual(before);
        expect(state.fixture.requests.some(request => request.path.startsWith('/v1/artifacts/') && request.method === 'POST')).toBe(false);
    });
});
