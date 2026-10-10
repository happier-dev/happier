import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { storage } from '@/sync/domains/state/storage';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { installPromptLibrarySettingsCommonModuleMocks, promptLibrarySettingsRouterReplaceSpy } from '../promptLibrarySettingsTestHelpers';
import { promptCollectionItemHref } from '../collection/promptCollectionRoutes';
import { PromptDocEditorScreen } from './PromptDocEditorScreen';

installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal() });
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(), usePreventRemove: () => {},
}));

// The real web editor falls back to its native TextInput without a Monaco API.
beforeEach(() => { vi.stubGlobal('window', {}); promptLibrarySettingsRouterReplaceSpy.mockClear(); });

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
async function seedDocument(id: string, title: string, folderId: string, tags: string[]) {
    await fixture!.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title, folderId, tags }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Visible content', createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
}
afterEach(() => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Prompt document editor personal organization', () => {
    it.each(['create', 'update'] as const)('keeps the %s draft when its UI Action is disabled', async operation => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-admission.test', { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [`prompt_doc.${operation}`]: { disabledSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        if (operation === 'update') await seedDocument('owned', 'Owned', '', []);
        const screen = await renderScreen(<PromptDocEditorScreen artifactId={operation === 'update' ? 'owned' : null} />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Kept draft'); });
        await screen.pressByTestIdAsync('promptDoc.save');
        expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Kept draft');
        expect(fixture.boundary.list()).toHaveLength(operation === 'update' ? 1 : 0);
        if (operation === 'update') expect(decodePlainArtifactStoredContent(fixture.boundary.read('owned')!.header)).toMatchObject({ title: 'Owned' });
        expect(promptLibrarySettingsRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('opens an acknowledged new document when its personal placement loses CAS', async () => {
        const catalog = createPromptLibraryCatalogBoundary({ mutationOutcome: 'conflict', revision: 4 });
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-create-receipt.test', { handleRequest: catalog.handle });
        const screen = await renderScreen(<PromptDocEditorScreen artifactId={null} />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('promptDoc.title', 'Acknowledged prompt');
            screen.changeTextByTestId('promptDoc.tags', 'personal');
            screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.onChangeText('Created content');
        });
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('promptDoc.save');
        await vi.waitFor(() => expect(catalog.requests).toHaveLength(1));
        const committed = fixture.boundary.list()[0];
        expect(committed).toBeDefined();
        expect(JSON.parse(fixture.boundary.readPlainBody(committed!.id)!)).toMatchObject({ markdown: 'Created content' });
        const folders = catalog.read('folders');
        if (folders.key !== 'folders') throw new Error('Wrong catalog');
        expect(folders.value.artifactHeadersById?.[committed!.id]).toBeUndefined();
        await vi.waitFor(() => expect(promptLibrarySettingsRouterReplaceSpy).toHaveBeenCalledWith(
            promptCollectionItemHref('doc', committed!.id, { serverId: fixture!.home.id }),
        ));
        expect(fixture.boundary.list()).toHaveLength(1);
    });

    it('retains the acknowledged content revision when personal placement fails before a later deliberate edit', async () => {
        const catalog = createPromptLibraryCatalogBoundary({ mutationOutcome: 'conflict', revision: 4,
            records: [{ key: 'folders', value: { v: 1, folders: [{ id: 'legacy', name: 'Legacy' }] } }],
        });
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-update-receipt.test', { handleRequest: catalog.handle });
        await seedDocument('owned', 'Owned', 'legacy', ['private']);
        const screen = await renderScreen(<PromptDocEditorScreen artifactId="owned" />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Owned'));
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('promptDoc.title', 'First content ACK');
            screen.changeTextByTestId('promptDoc.tags', 'Uncommitted personal tags');
        });
        await screen.pressByTestIdAsync('promptDoc.save');
        await vi.waitFor(() => expect(catalog.requests).toHaveLength(1));
        expect(fixture.boundary.read('owned')).toMatchObject({ headerVersion: 2, bodyVersion: 2 });
        await flushHookEffects();
        expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe('Uncommitted personal tags');
        expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false);
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Second deliberate edit'); });
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('promptDoc.save');
        await vi.waitFor(() => expect(decodePlainArtifactStoredContent(fixture!.boundary.read('owned')!.header)).toMatchObject({
            title: 'Second deliberate edit', folderId: 'legacy', tags: ['private'],
        }));
        expect(fixture.boundary.read('owned')).toMatchObject({ headerVersion: 3, bodyVersion: 3 });
        const folders = catalog.read('folders');
        if (folders.key !== 'folders') throw new Error('Wrong catalog');
        expect(folders.value.artifactHeadersById?.owned).toBeUndefined();
    });

    it('keeps content but does not admit legacy organization while its catalog is unavailable', async () => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-unavailable.test', {
            handleRequest: async (path, init) => path.startsWith('/v1/account/entity-rows/prompt-library')
                ? Response.json({ error: 'forbidden' }, { status: 403 }) : catalog.handle(path, init),
        });
        await seedDocument('owned', 'Owned', 'legacy', ['private']);
        storage.setState({ isDataReady: true, artifacts: { owned: { id: 'owned', title: 'Owned',
            header: { title: 'Owned', kind: 'prompt_doc.v2', folderId: 'legacy', tags: ['private'] }, access: 'owner',
            body: JSON.stringify({ v: 1, markdown: 'Visible content', createdAtMs: 1, updatedAtMs: 1 }),
            isDecrypted: true, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        const screen = await renderScreen(<PromptDocEditorScreen artifactId="owned" />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Owned'));
        expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe('');
        expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Visible content');
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Edited'); });
        await screen.pressByTestIdAsync('promptDoc.save');
        await vi.waitFor(() => expect(decodePlainArtifactStoredContent(fixture!.boundary.read('owned')!.header)).toMatchObject({
            title: 'Edited', folderId: 'legacy', tags: ['private'],
        }));
        expect(fixture.requests.some(request => request.path.startsWith('/v1/account/entity-rows/prompt-library') && request.method !== 'GET')).toBe(false);
    });
    it.each([true, false])('shows personal fields, never the received owner placement (override=%s)', async override => {
        const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'folders', value: { v: 1,
            folders: [{ id: 'mine', name: 'Personal' }, { id: 'owner', name: 'Owner' }],
            ...(override ? { artifactHeadersById: { received: { folderId: 'mine', tags: ['personal'] } } } : {}),
        } }] });
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-organization.test', { handleRequest: async (path, init) => {
            const response = await catalog.handle(path, init);
            if (response) return response;
            if (path === '/v1/artifacts/received' && (init?.method ?? 'GET') === 'GET') {
                const row = fixture?.boundary.read('received');
                if (row) return Response.json({ ...row, access: 'view', ownerAccountId: 'foreign-account' });
            }
            if (new URL(path, 'https://prompt-doc-editor-organization.test').pathname === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET') {
                const inventory = await fixture?.boundary.handle(path, init);
                if (inventory) {
                    const rows = await inventory.json();
                    return Response.json(rows.map((row: { id: string }) => row.id === 'received'
                        ? { ...row, access: 'view', ownerAccountId: 'foreign-account' } : row));
                }
            }
            return null;
        } });
        await seedDocument('received', 'Received', 'owner', ['foreign']);
        storage.setState({ isDataReady: true, artifacts: { received: { id: 'received', title: 'Received',
            header: { title: 'Received', kind: 'prompt_doc.v2', folderId: 'owner', tags: ['foreign'] }, access: 'view',
            body: JSON.stringify({ v: 1, markdown: 'Visible content', createdAtMs: 1, updatedAtMs: 1 }),
            isDecrypted: true, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } } });
        const screen = await renderScreen(<PromptDocEditorScreen artifactId="received" />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe(override ? 'Personal' : ''));
        expect(screen.findByTestId('promptDoc.tags')?.props.value).toBe(override ? 'personal' : '');
        await vi.waitFor(() => expect(screen.findAllByType('TextInput').find(node => node.props.multiline === true)?.props.value).toBe('Visible content'));
    });
});
