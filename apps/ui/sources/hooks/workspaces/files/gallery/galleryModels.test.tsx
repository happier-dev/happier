import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemGetDirectoryTreeInputSchema, FilesystemListDirectoryInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishSessionMessageChanges } from '@/sync/store/sessionMessageChanges';
import { useFolderGalleryModel } from './useFolderGalleryModel';
import { useSessionMediaModel } from './useSessionMediaModel';
import { createGalleryStageItems } from './galleryStage';

await loadSyncSingletonForTests();
const account = createProviderSettingsAccountHarness();
const machineId = 'gallery-machine';
const listAction = 'daemon.filesystem.listDirectory';
const treeAction = 'daemon.filesystem.getDirectoryTree';
type ListingAction = typeof listAction | typeof treeAction;
type ListingInput = ReturnType<typeof FilesystemGetDirectoryTreeInputSchema.parse | typeof FilesystemListDirectoryInputSchema.parse>;

afterEach(async () => { await standardCleanup(); await account.reset(); });

async function installListings(reply: (action: ListingAction, input: ListingInput) => unknown) {
    const home = await account.restore({ accountId: 'gallery-account', currentAccount: true, serverIdentityId: 'srv_gallery_home' });
    const scope = { serverId: home.serverId, machineId, rootPath: '/workspace' };
    const respond = vi.fn(reply);
    for (const actionId of [listAction, treeAction] as const) {
        await answerExternalActionAccountForHome(account.home, home.serverId, {
            machineId, actionId, tokenEpoch: 0,
            execute: input => respond(actionId, (actionId === listAction
                ? FilesystemListDirectoryInputSchema : FilesystemGetDirectoryTreeInputSchema).parse(input)),
            failure: result => {
                if (result && typeof result === 'object' && 'error' in result && 'errorCode' in result
                    && typeof result.error === 'string' && typeof result.errorCode === 'string') {
                    return { error: result.error, errorCode: result.errorCode };
                }
                return null;
            },
        });
    }
    return {
        scope,
        captureScope: { ...scope, rootPath: '/happier-home' },
        lifetime: { scope: { serverId: home.serverId, accountId: 'gallery-account' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
        respond,
    };
}
const node = (name: string, modified: number, children?: ReturnType<typeof leaf>[]) => ({
    ...leaf(name, modified), type: 'directory' as const, children,
});
const listEntry = (name: string, modified: number) => ({ name, type: 'file' as const, modified, size: 100 });
const leaf = (name: string, modified: number) => ({ ...listEntry(name, modified), path: name });

describe('gallery models', () => {
    it('separates folders and other files, and widens a capped listing only on demand', async () => {
        const { scope, respond } = await installListings(action => action === listAction
            ? { success: true, entries: [{ name: 'fake.png', type: 'directory' }, listEntry('older.PNG', 1), listEntry('readme.md', 3)], truncated: true }
            : { success: true, tree: node('folder', 1, [leaf('older.PNG', 1), leaf('newer.mp4', 172800000)]) });
        let model!: ReturnType<typeof useFolderGalleryModel>;
        function Test() { model = useFolderGalleryModel({ scope, folderPath: 'folder', enabled: true }); return null; }
        await renderScreen(<Test />);
        await vi.waitFor(() => expect(model.incomplete).toBe(true));
        expect(model.folders.map(item => item.name)).toEqual(['fake.png']);
        expect(model.otherFiles.map(item => item.name)).toEqual(['readme.md']);
        expect(model.items.map(item => item.name)).toEqual(['older.PNG']);
        expect(respond.mock.calls.map(([action]) => action)).toEqual([listAction]);
        await act(async () => { await model.loadMore?.(); });
        expect(model.incomplete).toBe(false);
        expect(model.sections.map(section => section.items.map(item => item.name))).toEqual([['newer.mp4'], ['older.PNG']]);
        expect(createGalleryStageItems(model.items).map(item => [item.title, item.kind])).toEqual([
            ['newer.mp4', 'video'], ['older.PNG', 'image'],
        ]);
    });

    it('reads only on demand, merges all four roots, and recovers capped folders one at a time', async () => {
        const { scope, captureScope, lifetime, respond } = await installListings((action, input) => {
            const { path, rootPath } = input;
            if (action === listAction) {
                return { success: true, entries: path.endsWith('/late') ? [listEntry('newest.webp', 5)] : [
                    { name: 'early', type: 'directory', modified: 1 }, { name: 'late', type: 'directory', modified: 5 },
                ] };
            }
            expect(input).toHaveProperty('maxDepth', 2);
            if (rootPath === '/happier-home') return { success: true, tree: node('session', 0, [
                node('capture-id', 0, [leaf('capture.png', 4)]),
            ]) };
            if (path.includes('/messages/')) return { success: true, truncated: true, tree: node('session', 0, [
                node('early', 0, [leaf('input.png', 1)]),
            ]) };
            if (path.includes('/generated/')) return { success: true, tree: node('session', 0, [
                node('output-id', 0, [leaf('output.mov', 3)]),
            ]) };
            return { success: false, error: 'missing', errorCode: 'ENOENT' };
        });
        let model!: ReturnType<typeof useSessionMediaModel>;
        function Test({ enabled }: { enabled: boolean }) {
            model = useSessionMediaModel({ scope, captureScope, sessionId: 'session', enabled, online: true, lifetime });
            return null;
        }
        const screen = await renderScreen(<Test enabled={false} />);
        expect(respond).not.toHaveBeenCalled();
        await act(async () => { screen.update(<Test enabled />); });
        await vi.waitFor(() => expect(model.items.map(item => [item.name, item.messageLocalId])).toEqual([
            ['capture.png', undefined], ['output.mov', 'output-id'], ['input.png', 'early'],
        ]));
        expect(respond).toHaveBeenCalledTimes(4);
        expect(model.failures).toEqual([]);
        expect(model.incomplete).toBe(true);
        await act(async () => { await model.loadMore?.(); });
        expect(model.pendingFolders.map(folder => folder.name)).toEqual(['late', 'early']);
        expect(respond).toHaveBeenCalledTimes(5);
        await act(async () => { await model.loadFolder(model.pendingFolders[0]!.id); });
        expect(model.items[0]?.name).toBe('newest.webp');
        expect(model.incomplete).toBe(true);
        const ordinary = { kind: 'agent-text' as const, id: 'ordinary', localId: null, text: 'hello', createdAt: 1 };
        await act(async () => { publishSessionMessageChanges('session', [{ previous: null, next: ordinary }]); });
        expect(respond).toHaveBeenCalledTimes(6);
        const media = { ...ordinary, id: 'with-media', meta: { happier: {
            kind: 'session_media.v1', payload: { media: [{
                id: 'media', role: 'output', category: 'generated', mediaKind: 'image',
                mimeType: 'image/png', name: 'new.png', path: '.happier/uploads/generated/session/with-media/new.png',
                sizeBytes: 10, origin: { source: 'provider-generated' },
            }] },
        } } };
        await act(async () => { publishSessionMessageChanges('session', [{ previous: null, next: media }]); });
        await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(10));
    });
});
