import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { installPromptLibrarySettingsCommonModuleMocks } from '../settings/prompts/promptLibrarySettingsTestHelpers';
import { ArtifactFolderTree } from './ArtifactFolderTree';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { ArtifactsBrowser } from './ArtifactsBrowserScreen';

installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal() });
// Popover rendering is a platform boundary; the menu choices and command owner remain real.
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
let homeCount = 0;
afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    fixture?.dispose(); fixture = undefined;
    vi.clearAllMocks();
});

async function setup(kind: 'all' | 'prompt', initial: readonly { id: string; name: string; parentId: string | null }[] = [], browser = false) {
    const boundary = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1, folders: [...initial] } }], revision: 4 });
    let outcome: 'updated' | 'conflict' | 'failed' = 'updated';
    fixture = await createPlainArtifactHomeFixture(`https://inline-folders-${++homeCount}.test`, { handleRequest: async (path, init) => {
        if (path === '/v1/account/entity-rows/prompt-library/folders' && init?.method === 'POST') {
            if (outcome === 'conflict') return Response.json({ status: 'conflict', revision: 4 });
            if (outcome === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        return boundary.handle(path, init);
    } });
    const testID = browser ? 'artifacts:folders' : 'folders';
    const screen = await renderScreen(browser ? <AppPaneProvider><ArtifactsBrowser artifacts={[{
        id: 'document', title: 'Notes', isDecrypted: true, header: { title: 'Notes' }, headerVersion: 1,
        bodyVersion: 1, seq: 1, body: 'Notes', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain',
    }]} loaded loadFailed={false} onRetry={() => {}} usage={null} /></AppPaneProvider>
        : <CoreCollectionScope><ArtifactFolderTree testID={testID} accessibilityLabel="Folders"
            filter={{ query: '', kind, sort: 'title_asc' }} onOpenArtifact={() => {}} /></CoreCollectionScope>);
    if (browser) await screen.pressByTestIdAsync('artifacts:view:folders');
    await vi.waitFor(() => expect(screen.findByTestId(initial.length ? `${testID}:row:folder:${initial[0]!.id}` : `${testID}:invite:new`)).toBeTruthy());
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
    return { screen, read, boundary, changeName, select, setOutcome: (next: typeof outcome) => { outcome = next; } };
}

describe.each(['all', 'prompt'] as const)('shared folder inline writes (%s)', kind => {
    it('renames a just-settled create without reloading the tree', async () => {
        const state = await setup(kind);
        await state.screen.pressByTestIdAsync('folders:invite:new');
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
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name.error')).toBeTruthy());
        expect(state.screen.findByTestId('folders:edit:name')!.props.value).toBe('  r2-folder   retry  ');
        expect(state.read().folders[0]!.name).toBe('Original');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name')).toBeNull());
        expect(state.read().folders).toEqual([
            expect.objectContaining({ id: 'original', name: 'r2-folder retry' }),
            expect.objectContaining({ id: 'neighbor', name: 'Neighbor' }),
        ]);
        expect(state.boundary.requests.map(request => request.expectedRevision)).toEqual([4, 5]);
    });

    it('creates only on Save, normalizes names, and reuses an existing folder', async () => {
        const { screen, read, boundary, changeName, select } = await setup(kind);
        await screen.pressByTestIdAsync('folders:invite:new');
        expect(screen.findByTestId('folders:edit:name')).toBeTruthy();
        await changeName('  Release   notes  ');
        expect(read().folders).toEqual([]);
        expect(boundary.requests).toEqual([]);
        await screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(read().folders).toEqual([expect.objectContaining({ name: 'Release notes', parentId: null })]));
        await vi.waitFor(() => expect(screen.findByTestId('folders:edit:name')).toBeNull());
        const folderId = read().folders[0]!.id;
        await select('newInside', folderId);
        await changeName('release NOTES');
        await screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(screen.findByTestId('folders:edit:name')).toBeNull());
        expect(read().folders).toHaveLength(1);
        expect(boundary.requests).toHaveLength(1);
        await select('newInside', folderId);
        await changeName('Discard this child');
        await screen.pressByTestIdAsync('folders:edit:cancel');
        expect(screen.findByTestId('folders:edit:name')).toBeNull();
        expect(boundary.requests).toHaveLength(1);
        await select('newInside', folderId);
        await changeName('Child folder');
        await screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(read().folders).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Child folder', parentId: folderId }),
        ])));
    });

    it.each(['conflict', 'failed'] as const)('keeps the create draft and inline error after %s, then saves on retry', async outcome => {
        const state = await setup(kind);
        state.setOutcome(outcome);
        await state.screen.pressByTestIdAsync('folders:invite:new');
        await state.changeName('  Keep   my draft  ');
        await state.screen.pressByTestIdAsync('folders:edit:save');
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name.error')).toBeTruthy());
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
        await vi.waitFor(() => expect(state.screen.findByTestId('folders:edit:name.error')).toBeTruthy());
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

it('starts the same inline draft from the Artifacts browser toolbar', async () => {
    const state = await setup('all', [], true);
    await state.screen.pressByTestIdAsync('artifacts:folders:new');
    await state.changeName('  Browser   folder  ');
    expect(state.read().folders).toEqual([]);
    await state.screen.pressByTestIdAsync('artifacts:folders:edit:save');
    await vi.waitFor(() => expect(state.read().folders).toEqual([
        expect.objectContaining({ name: 'Browser folder', parentId: null }),
    ]));
    await vi.waitFor(() => expect(state.screen.findByTestId('artifacts:folders:edit:name')).toBeNull());
});
