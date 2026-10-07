// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { createRepositoryPickerInputHost } from '@/components/workspaces/files/repositoryTree/repositoryUploadBrowserTestFixture';
import { createSessionFilesViewFixture, prepareSessionFilesViewTestkit, type FileViewRpcRequest } from './sessionFilesViewTestkit';

const { promptSpy, alertSpy, machineRpcSpy } = vi.hoisted(() => ({
    promptSpy: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
    alertSpy: vi.fn<(...args: unknown[]) => void>(),
    machineRpcSpy: vi.fn(async (params: FileViewRpcRequest) => {
        if (params.method === 'listDirectory') return { success: true, entries: [] };
        if (params.method === 'writeFile') return { success: true, hash: 'created-file-hash' };
        if (params.method === 'createDirectory') return { success: true };
        if (params.method === 'statFile') return { success: true, exists: false };
        return { success: false, error: 'Unprovided daemon capability' };
    }),
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => {
    const boundary = (await import('@/dev/testkit')).createModalModuleMock();
    boundary.spies.prompt.mockImplementation(promptSpy);
    boundary.spies.alert.mockImplementation(alertSpy);
    return boundary.module;
});
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit')).createInlinePopoverModuleMock(importOriginal));
// Execute the real Metro web owners in the Node renderer.
vi.mock('@/hooks/ui/useWebFileDropZone', () => import('@/hooks/ui/useWebFileDropZone.web'));
vi.mock('@/utils/files/webDroppedEntries', () => import('@/utils/files/webDroppedEntries.web'));

describe('SessionRepositoryTreeBrowserView (create actions)', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
    beforeAll(prepareSessionFilesViewTestkit);

    beforeEach(async () => {
        vi.stubGlobal('SharedWorker', class SharedWorker {});
        fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: machineRpcSpy });
        promptSpy.mockReset();
        alertSpy.mockClear();
        machineRpcSpy.mockClear();
    });

    afterEach(async () => {
        standardCleanup();
        await fixture?.dispose();
        vi.unstubAllGlobals();
    });

    async function changeSession(update: Partial<import('@/sync/domains/state/storageTypes').Session>) {
        const session = fixture.storage.getState().sessions.s1;
        if (!session) throw new Error('Expected session fixture');
        fixture.storage.getState().applySessions([{ ...session, ...update }]);
    }

    async function renderRepositoryTreeBrowserView(
        overrides: Partial<React.ComponentProps<typeof import('./SessionRepositoryTreeBrowserView').SessionRepositoryTreeBrowserView>> = {},
    ) {
        const { SessionRepositoryTreeBrowserView } = await import('./SessionRepositoryTreeBrowserView');
        const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
        function HeaderAction() {
            return <>{usePublishedPaneHeaderContent('files')?.action ?? null}</>;
        }
        const inputs: HTMLInputElement[] = [];
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        screen = await fixture.render(
            <PaneHeaderSlotProvider>
                <HeaderAction />
                <PaneHeaderSlotScope slotKey="files">
                    <SessionRepositoryTreeBrowserView sessionId="s1" onOpenFile={vi.fn()} {...overrides} />
                </PaneHeaderSlotScope>
            </PaneHeaderSlotProvider>,
            { createNodeMock: element => {
                if (element.props.testID === 'repository-tree-drop-zone') return document.createElement('div');
                const index = inputs.length;
                return createRepositoryPickerInputHost(element, inputs, () => screen?.findAllByType('input')[index]?.props.onChange);
            } },
        );
        return Object.assign(screen, { inputs });
    }

    function createMenuItem(screen: Awaited<ReturnType<typeof renderRepositoryTreeBrowserView>>, id: string): DropdownMenuItem | undefined {
        const menu = screen.find(node => node.props.testID === 'repository-tree-create-menu' && Array.isArray(node.props.items));
        return (menu.props.items as readonly DropdownMenuItem[]).find(item => item.id === id);
    }

    async function selectMenuItem(screen: Awaited<ReturnType<typeof renderRepositoryTreeBrowserView>>, id: string) {
        await screen.pressByTestIdAsync('repository-tree-create-button');
        await screen.pressByTestIdAsync(id);
        await flushHookEffects();
    }

    it('keeps create actions enabled when the session is inactive but the machine target is available', async () => {
        await changeSession({ active: false });
        const screen = await renderRepositoryTreeBrowserView();
        expect(createMenuItem(screen, 'repository-tree-upload-files')?.disabled).toBe(false);
        expect(createMenuItem(screen, 'repository-tree-create-file')?.disabled).toBe(false);
    });

    it('disables create actions when no machine RPC target is available', async () => {
        const session = fixture.session;
        await changeSession({ metadata: session.metadata ? { ...session.metadata, machineId: undefined, host: 'unknown-host' } : null });
        const screen = await renderRepositoryTreeBrowserView();
        expect(createMenuItem(screen, 'repository-tree-upload-files')?.disabled).toBe(true);
        expect(createMenuItem(screen, 'repository-tree-create-file')?.disabled).toBe(true);
    });

    it('disables create and upload actions when no workspace target is resolvable', async () => {
        const session = fixture.session;
        await changeSession({ metadata: session.metadata ? { ...session.metadata, path: '' } : null });
        const screen = await renderRepositoryTreeBrowserView();
        expect(createMenuItem(screen, 'repository-tree-upload-files')?.disabled).toBe(true);
        expect(createMenuItem(screen, 'repository-tree-create-file')?.disabled).toBe(true);
    });

    it('renders stable web upload input testIDs for UI e2e', async () => {
        const screen = await renderRepositoryTreeBrowserView();
        expect(screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-files' })).toHaveLength(1);
        expect(screen.findAllByProps({ 'data-testid': 'repository-tree-upload-input-folder' })).toHaveLength(1);
    });

    it('uses the selected upload destination for toolbar-triggered web uploads', async () => {
        promptSpy.mockResolvedValueOnce('src/uploads');
        const screen = await renderRepositoryTreeBrowserView();
        await selectMenuItem(screen, 'repository-tree-upload-destination-select');
        expect(promptSpy).toHaveBeenCalledWith(
            'settingsAttachments.workspaceDirectory.uploadsDirectory.promptTitle',
            'settingsAttachments.workspaceDirectory.uploadsDirectory.promptMessage',
            expect.objectContaining({ defaultValue: '', placeholder: 'files.projectRoot' }),
        );
        expect(createMenuItem(screen, 'repository-tree-upload-destination-select')).toMatchObject({ subtitle: 'src/uploads' });
        await selectMenuItem(screen, 'repository-tree-upload-files');
        const input = screen.inputs.find(candidate => !candidate.hasAttribute('webkitdirectory'));
        if (!input) throw new Error('Expected files picker input');
        Object.defineProperty(input, 'files', { value: [new File(['source'], 'upload-source.txt')] });
        await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.STAT_FILE,
            payload: { path: '/repo/src/uploads/upload-source.txt' },
        })));
    });

    it('creates a file and opens it pinned', async () => {
        promptSpy.mockResolvedValueOnce('src/new-file.ts');
        const onOpenFile = vi.fn();
        const onOpenFilePinned = vi.fn();
        const screen = await renderRepositoryTreeBrowserView({ onOpenFile, onOpenFilePinned });
        const { WorkspaceRepositoryTreeList } = await import('@/components/projects/files/WorkspaceRepositoryTreeList');
        const tree = screen.findByType(WorkspaceRepositoryTreeList);
        await selectMenuItem(screen, 'repository-tree-create-file');
        await vi.waitFor(() => expect(onOpenFilePinned).toHaveBeenCalledWith('src/new-file.ts'));
        expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.WRITE_FILE,
            payload: { path: '/repo/src/new-file.ts', content: '', expectedHash: null },
        }));
        expect(screen.findByType(WorkspaceRepositoryTreeList)).toBe(tree);
        expect(alertSpy).not.toHaveBeenCalled();
    });

    it('shows an error when create file path is invalid', async () => {
        promptSpy.mockResolvedValueOnce('../bad');
        const screen = await renderRepositoryTreeBrowserView();
        await selectMenuItem(screen, 'repository-tree-create-file');
        await vi.waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
        expect(machineRpcSpy.mock.calls.filter(([params]) => params.method === RPC_METHODS.WRITE_FILE)).toHaveLength(0);
    });

    it('creates a directory', async () => {
        promptSpy.mockResolvedValueOnce('src/new-folder');
        const screen = await renderRepositoryTreeBrowserView();
        await selectMenuItem(screen, 'repository-tree-create-folder');
        await vi.waitFor(() => expect(machineRpcSpy).toHaveBeenCalledWith(expect.objectContaining({
            targetId: 'm1', method: RPC_METHODS.CREATE_DIRECTORY,
            payload: { path: '/repo/src/new-folder' },
        })));
        expect(alertSpy).not.toHaveBeenCalled();
    });
});
