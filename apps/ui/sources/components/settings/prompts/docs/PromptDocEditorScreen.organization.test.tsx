import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { storage } from '@/sync/domains/state/storage';
import { resetPromptLibraryCatalogSnapshotsForTests } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { resetPromptLibraryCatalogEngineForTests } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { installPromptLibrarySettingsCommonModuleMocks, promptLibrarySettingsRouterPushSpy, promptLibrarySettingsRouterReplaceSpy } from '../promptLibrarySettingsTestHelpers';
import { promptCollectionItemHref } from '../collection/promptCollectionRoutes';
import { PromptEditorHeader } from '../collection/PromptEditorHeader';

installPromptLibrarySettingsCommonModuleMocks({ storage: importOriginal => importOriginal(), router: async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: promptLibrarySettingsRouterReplaceSpy, push: promptLibrarySettingsRouterPushSpy } }).module });
vi.mock('expo-router', async () => {
    const spies = await import('../promptLibrarySettingsTestHelpers');
    return (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        router: { replace: spies.promptLibrarySettingsRouterReplaceSpy, push: spies.promptLibrarySettingsRouterPushSpy },
    }).module;
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@react-navigation/native', async importOriginal => ({
    ...await importOriginal<typeof import('@react-navigation/native')>(),
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
}));
const { PromptDocEditorScreen } = await import('./PromptDocEditorScreen');
const { Modal } = await import('@/modal');

// The real web editor falls back to its native TextInput without a Monaco API.
// Draft and save logic is driven through the raw source boundary: the person's "Markdown opens as: Raw" preference.
beforeEach(() => { storage.setState((state) => ({ settings: { ...state.settings, markdownDefaultEditMode: 'raw' } })); vi.stubGlobal('window', {}); promptLibrarySettingsRouterReplaceSpy.mockClear(); promptLibrarySettingsRouterPushSpy.mockClear();
    vi.spyOn(Modal, 'confirm').mockResolvedValue(true); });

let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
function storedKind(header: unknown) {
    const value = typeof header === 'string' ? decodePlainArtifactStoredContent(header) : null;
    return value && typeof value === 'object' && 'kind' in value ? value.kind : null;
}
async function seedDocument(id: string, title: string, folderId: string | null, tags: string[]) {
    await fixture!.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id,
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title, folderId, tags }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Visible content', createdAtMs: 1, updatedAtMs: 1 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    }) });
}
afterEach(async () => {
    resetPromptLibraryCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    await fixture?.dispose(); fixture = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Prompt document editor personal organization', () => {
    it.each(['folder-disabled', 'save-rejected'] as const)('does not write a new folder or document when %s', async outcome => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture(`https://prompt-doc-folder-${outcome}.test`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: outcome === 'folder-disabled'
                    ? { 'artifact.folders.create': { disabledSurfaces: ['ui'] } }
                    : { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        const screen = await renderScreen(<PromptDocEditorScreen artifactId={null} />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => {
            screen.changeTextByTestId('promptDoc.title', 'Uncommitted document');
            screen.changeTextByTestId('promptDoc.folderName', 'A genuinely new folder');
        });
        let saving: Promise<unknown> | undefined;
        act(() => { saving = screen.findByTestId('promptDoc.save')!.props.onPress(); });
        if (outcome === 'save-rejected') {
            await vi.waitFor(() => expect(fixture!.boundary.list().filter(row => storedKind(row.header) === 'approval_request.v1')).toHaveLength(1));
            expect(catalog.requests).toHaveLength(0);
            const approval = fixture.boundary.list().find(row => storedKind(row.header) === 'approval_request.v1')!;
            await decideApprovalAsInbox(fixture.home.id, approval.id, 'reject');
        }
        await act(async () => { await saving; });
        expect(catalog.read('folders').value).toMatchObject({ folders: [] });
        expect(catalog.requests).toHaveLength(0);
        expect(fixture.boundary.list().filter(row => storedKind(row.header) === 'prompt_doc.v2')).toHaveLength(0);
        expect(screen.findByTestId('promptDoc.folderName')?.props.value).toBe('A genuinely new folder');
        expect(promptLibrarySettingsRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it('does not attach a retired document conflict to the replacement editor', async () => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-retarget-approval.test', { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'prompt_doc.update': { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        await seedDocument('owned', 'Owned', null, []);
        await seedDocument('next', 'Next document', null, []);
        let showDocument: ((artifactId: string) => void) | undefined;
        function RetargetableEditor() {
            const [artifactId, setArtifactId] = React.useState('owned');
            showDocument = setArtifactId;
            return <PromptDocEditorScreen artifactId={artifactId} />;
        }
        const screen = await renderScreen(<RetargetableEditor />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Original reviewed draft'); });
        let saving: Promise<unknown> | undefined;
        act(() => { saving = screen.findByTestId('promptDoc.save')!.props.onPress(); });
        await vi.waitFor(() => expect(fixture!.boundary.list().filter(row => storedKind(row.header) === 'approval_request.v1')).toHaveLength(1));
        const approval = fixture.boundary.list().find(row => storedKind(row.header) === 'approval_request.v1')!;
        await act(async () => { showDocument!('next'); });
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Next document'));
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Next local draft'); });
        const current = fixture.boundary.read('owned')!;
        await fixture.boundary.handle('/v1/artifacts/owned', { method: 'POST', body: JSON.stringify({
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Concurrent' }),
            expectedHeaderVersion: current.headerVersion,
        }) });
        await decideApprovalAsInbox(fixture.home.id, approval.id, 'approve');
        await act(async () => { await saving; });
        expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Next local draft');
        expect(screen.findByTestId('promptDoc.conflict')).toBeNull();
        expect(decodePlainArtifactStoredContent(fixture.boundary.read('next')!.header)).toMatchObject({ title: 'Next document' });
        expect(promptLibrarySettingsRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it.each(['reject', 'conflict'] as const)('retains the captured update draft after approval %s', async outcome => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture(`https://prompt-doc-editor-${outcome}-approval.test`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'prompt_doc.update': { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        await seedDocument('owned', 'Owned', null, []);
        const screen = await renderScreen(<PromptDocEditorScreen artifactId="owned" />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Retained reviewed draft'); });
        let saving: Promise<unknown> | undefined;
        act(() => { saving = screen.findByTestId('promptDoc.save')!.props.onPress(); });
        await vi.waitFor(() => expect(fixture!.boundary.list().filter(row => storedKind(row.header) === 'approval_request.v1')).toHaveLength(1));
        const approval = fixture.boundary.list().find(row => storedKind(row.header) === 'approval_request.v1')!;
        if (outcome === 'conflict') {
            const current = fixture.boundary.read('owned')!;
            await fixture.boundary.handle('/v1/artifacts/owned', { method: 'POST', body: JSON.stringify({
                header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Concurrent' }),
                expectedHeaderVersion: current.headerVersion,
            }) });
        }
        await decideApprovalAsInbox(fixture.home.id, approval.id, outcome === 'reject' ? 'reject' : 'approve');
        await act(async () => { await saving; });
        expect(decodePlainArtifactStoredContent(fixture.boundary.read('owned')!.header)).toMatchObject({ title: outcome === 'conflict' ? 'Concurrent' : 'Owned' });
        expect(screen.findByTestId('promptDoc.title')?.props.value).toBe('Retained reviewed draft');
        expect(screen.findByTestId('promptDoc.save')?.props.disabled).toBe(false);
        expect(Boolean(screen.findByTestId('promptDoc.conflict'))).toBe(outcome === 'conflict');
        expect(promptLibrarySettingsRouterReplaceSpy).not.toHaveBeenCalled();
    });

    it.each(['create', 'update', 'duplicate', 'delete'] as const)('settles the mounted %s approval before adopting the document receipt', async operation => {
        const action = operation === 'delete' ? 'artifact.delete' : operation === 'update' ? 'prompt_doc.update' : 'prompt_doc.create';
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture(`https://prompt-doc-editor-${operation}-approval.test`, { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [action]: { approvalRequiredSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        if (operation !== 'create') await seedDocument('owned', 'Owned', null, []);
        const screen = await renderScreen(<PromptDocEditorScreen artifactId={operation === 'create' ? null : 'owned'} />);
        await vi.waitFor(() => expect(screen.findByTestId('promptDoc.tags')?.props.editable).toBe(true));
        let saving: Promise<unknown> | undefined;
        await act(async () => {
            if (operation === 'duplicate' || operation === 'delete') {
                saving = screen.findByType(PromptEditorHeader).props.menuActions.find((item: { id: string }) => item.id === operation).onSelect();
            } else {
                screen.changeTextByTestId('promptDoc.title', 'Reviewed draft');
            }
        });
        if (operation === 'create' || operation === 'update') act(() => { saving = screen.findByTestId('promptDoc.save')!.props.onPress(); });
        await vi.waitFor(() => expect(fixture!.boundary.list().filter(row =>
            storedKind(row.header) === 'approval_request.v1')).toHaveLength(1));
        const approval = fixture.boundary.list().find(row => storedKind(row.header) === 'approval_request.v1')!;
        expect(fixture.boundary.list().filter(row => storedKind(row.header) === 'prompt_doc.v2'))
            .toHaveLength(operation === 'create' ? 0 : 1);
        expect(promptLibrarySettingsRouterReplaceSpy).not.toHaveBeenCalled();
        expect(promptLibrarySettingsRouterPushSpy).not.toHaveBeenCalled();
        if (operation === 'create') expect(screen.findByTestId('promptDoc.title')?.props.editable).toBe(false);
        if (operation === 'update') await act(async () => { screen.changeTextByTestId('promptDoc.title', 'Later local draft'); });
        const decision = await decideApprovalAsInbox(fixture.home.id, approval.id, 'approve');
        expect(JSON.parse(fixture.boundary.readPlainBody(approval.id)!).execution).not.toMatchObject({ ok: false });
        expect(decision).toMatchObject({ ok: true, result: { status: 'executed' } });
        await act(async () => { await saving; });
        await vi.waitFor(() => {
            const documents = fixture!.boundary.list().filter(row => storedKind(row.header) === 'prompt_doc.v2');
            expect(documents).toHaveLength(operation === 'delete' ? 0 : operation === 'duplicate' ? 2 : 1);
            if (operation === 'update') expect(decodePlainArtifactStoredContent(fixture!.boundary.read('owned')!.header)).toMatchObject({ title: 'Reviewed draft' });
            else expect(operation === 'duplicate' ? promptLibrarySettingsRouterPushSpy : promptLibrarySettingsRouterReplaceSpy).toHaveBeenCalled();
        });
        expect(screen.findByTestId('promptDoc.title')?.props.value).toBe(operation === 'update' ? 'Later local draft'
            : operation === 'duplicate' || operation === 'delete' ? 'Owned' : 'Reviewed draft');
    });

    it.each(['create', 'update'] as const)('keeps the %s draft when its UI Action is disabled', async operation => {
        const catalog = createPromptLibraryCatalogBoundary();
        fixture = await createPlainArtifactHomeFixture('https://prompt-doc-editor-admission.test', { handleRequest: async (path, init) => {
            if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { [`prompt_doc.${operation}`]: { disabledSurfaces: ['ui'] } } },
            } } });
            return catalog.handle(path, init);
        } });
        await fixture.hydrateAccountSettings();
        if (operation === 'update') await seedDocument('owned', 'Owned', null, []);
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
