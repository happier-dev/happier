import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { FilesystemWriteFileInputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { dispatchEscapeToLayerStack } from '@/keyboard/escape';
import {
    cleanupWorkspaceFileDetailsActionBoundary,
    getWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsActionBoundary,
    installWorkspaceFileDetailsCommonModuleMocks,
    prepareWorkspaceFileDetailsActionBoundary,
} from './workspaceFileDetailsTestHelpers';
import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';
import type { WorkspaceFileEditorDraft } from './workspaceFileEditorDraft';
import type { PaneDetailsState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';

installWorkspaceFileDetailsCommonModuleMocks({ modal: () => vi.importActual('@/modal') });
installWorkspaceFileDetailsActionBoundary();
const transport = vi.hoisted(() => ({ diff: vi.fn(), stat: vi.fn() }));
// Only remote filesystem and SCM reads are scripted; the loader, editor and Close guard stay real.
vi.mock('@/sync/ops/scm/machineScm', () => ({ machineScmDiffFile: transport.diff }));
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime')>(),
    callDaemonWorkspaceStatFileRpc: transport.stat,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Test Renderer cannot paint DOM portals or mount Radix's DOM effects. Keep the app's entire modal path real.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

const { ModalProvider } = await import('@/modal');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { DetailsTabStrip } = await import('@/components/appShell/panes/details/workspace/DetailsTabStrip');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { buildDetailsWorkspaceStateView } = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors');
const {
    applyCloseDetailsTab, applyOpenDetailsTab, applyPinDetailsTab, applySetActiveDetailsTab,
    applySetDetailsTabState, applyUnpinDetailsTab, createEmptyPaneDetailsState,
} = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceReducer');
const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
const { useWorkspaceFileDetailsLoading } = await import('./useWorkspaceFileDetailsLoading');
const { useWorkspaceFileEditorCommands } = await import('./useWorkspaceFileEditorCommands');
const { useModalPaneBoundary } = await import('@/components/ui/panels/ModalPaneBoundary');

const tab = createWorkspaceFileDetailsTab('src/retry.ts');
const scope = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const actionBoundary = getWorkspaceFileDetailsActionBoundary();
const refreshAll = async () => {};
let editor!: WorkspaceFileEditorState;
let details!: PaneDetailsState;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let loading: ReturnType<typeof useWorkspaceFileDetailsLoading>;

function EditorBody({ persistDraft, loadDetails }: Readonly<{ persistDraft: (draft: WorkspaceFileEditorDraft | null) => void; loadDetails: boolean }>) {
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    loading = useWorkspaceFileDetailsLoading({ scope, accountId: 'account-a', filePath: 'src/retry.ts',
        diffMode: 'pending', fileEntryKind: 'modified', includeFile: true, includeDiff: true,
        isActive: loadDetails, refreshFingerprint: '1' });
    editor = useWorkspaceFileEditorState({
        scope, accountId: 'account-a', filePath: 'src/retry.ts', displayMode: 'file',
        fileText: loadDetails ? loading.fileContent?.content ?? null : 'saved text',
        fileHash: loadDetails ? loading.fileContent?.contentHash ?? null : 'saved-hash',
        encoding: loadDetails ? loading.fileContent?.encoding : undefined, fileWriteSupported, setFileWriteSupported,
        fileEditorFeatureEnabled: true, filesEditorWebMonacoEnabled: true, filesEditorNativeCodeMirrorEnabled: true,
        filesEditorAutoSave: false, filesEditorChangeDebounceMs: 100, mountedRef,
        refreshAll: loadDetails ? loading.refreshAll : refreshAll,
        publishSavedFile: loadDetails ? loading.publishSavedFile : undefined, persistDraft,
    });
    useWorkspaceFileEditorCommands({ editor, tabKey: tab.key, serverId: scope.serverId,
        accountId: 'account-a', focused: true, onStart: editor.startEditingFile });
    return null;
}

function PaneEscape({ onClose }: Readonly<{ onClose(): void }>) {
    useModalPaneBoundary({ active: false, label: 'Details panel', escapeEnabled: true, onRequestClose: onClose });
    return null;
}

function FileWorkspace({ escape = false, loadDetails = false }: Readonly<{ escape?: boolean; loadDetails?: boolean }>) {
    const [state, setDetails] = React.useState(() => applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' }));
    details = state;
    const pane = React.useMemo(() => ({
        setActiveDetailsTab: (key: string) => setDetails(previous => applySetActiveDetailsTab(previous, key)),
        pinDetailsTab: (key: string) => setDetails(previous => applyPinDetailsTab(previous, key)),
        unpinDetailsTab: (key: string) => setDetails(previous => applyUnpinDetailsTab(previous, key)),
        closeDetailsTab: (key: string) => setDetails(previous => applyCloseDetailsTab(previous, key)),
    }), []);
    const persistDraft = React.useCallback((draft: WorkspaceFileEditorDraft | null) => {
        setDetails(previous => applySetDetailsTabState(previous, tab.key, draft));
    }, []);
    const group = buildDetailsWorkspaceStateView(state).groups[0];
    return <ModalProvider><KeyboardShortcutProvider handlers={{}}>
        {escape ? <PaneEscape onClose={() => pane.closeDetailsTab(tab.key)} /> : null}
        {group ? <DetailsTabStrip pane={pane} group={group} testIds={{ tabClose: () => 'close-file' }} /> : null}
        {state.tabsByKey[tab.key] ? <EditorBody persistDraft={persistDraft} loadDetails={loadDetails} /> : null}
    </KeyboardShortcutProvider></ModalProvider>;
}

describe('dirty File Close through the real strip, editor guard and modal host', () => {
    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://editor.test' });
        scope.serverId = await prepareWorkspaceFileDetailsActionBoundary();
        actionBoundary.read.mockReset();
        transport.diff.mockReset(); transport.stat.mockReset();
    });

    it('saves newer bytes and closes while a superseded post-receipt diff read is still held', async () => {
        const staleDiff = createDeferred<{ success: true; diff: string }>();
        const patch = (text: string) => `diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+${text}\n`;
        const writes: ReturnType<typeof FilesystemWriteFileInputSchema.parse>[] = [];
        let disk = 'saved text';
        actionBoundary.read.mockImplementation(async request => {
            const write = FilesystemWriteFileInputSchema.safeParse(request.payload);
            if (write.success) {
                writes.push(write.data); disk = Buffer.from(write.data.content, 'base64').toString('utf8');
                return { success: true, hash: `receipt-${writes.length}` };
            }
            return { success: true, content: Buffer.from(disk).toString('base64') };
        });
        transport.stat.mockResolvedValue({ success: true, exists: true, sizeBytes: 10 });
        transport.diff.mockImplementation(async () => writes.length === 1 ? staleDiff.promise : { success: true, diff: patch(disk) });
        const screen = await renderScreen(<FileWorkspace loadDetails />);
        let first: Promise<boolean> | undefined;
        let second: Promise<boolean> | undefined;
        try {
            await waitForHomeGovernance(() => expect(loading.fileContent?.content).toBe('saved text'));
            await act(async () => editor.startEditingFile());
            await act(async () => editor.onEditorChange('first saved bytes'));
            await act(async () => { first = editor.saveFileEdits(); });
            await waitForHomeGovernance(() => expect(loading.isDiffLoading).toBe(true));
            await act(async () => editor.onEditorChange('newer saved bytes'));
            await act(async () => { second = editor.saveFileEdits(); });
            await vi.waitFor(() => expect(writes).toHaveLength(2));
            expect(writes[1]?.expectedHash).toBe('receipt-1');
            expect(disk).toBe('newer saved bytes');
            await act(async () => { expect(await first).toBe(true); expect(await second).toBe(true); });
            await waitForHomeGovernance(() => expect(loading.diffContent).toBe(patch('newer saved bytes')));
            expect(editor.getEditorText()).toBe('newer saved bytes');
            await screen.pressByTestIdAsync('close-file');
            expect(details.tabsByKey[tab.key]).toBeUndefined();
            expect(writes).toHaveLength(2);
            // Even a transport ignoring cancellation cannot publish the retired display read.
            await act(async () => { staleDiff.resolve({ success: true, diff: patch('first saved bytes') }); });
            expect(loading.diffContent).toBe(patch('newer saved bytes'));
        } finally {
            staleDiff.resolve({ success: true, diff: patch('first saved bytes') });
            await act(async () => { await first; await second; });
        }
    });
    afterEach(async () => {
        await standardCleanup();
        await cleanupWorkspaceFileDetailsActionBoundary();
        browser.restore();
    });

    it.each((['strip', 'escape'] as const).flatMap(entry => (['keepEditing', 'discard', 'save', 'failedSave'] as const)
        .map(decision => ({ entry, decision }))))('presents the existing decision through $entry and applies $decision', async ({ entry, decision }) => {
        actionBoundary.read.mockResolvedValue(decision === 'failedSave'
            ? { success: false, errorCode: 'hash_mismatch', error: 'Changed on disk' }
            : { success: true, hash: 'new-hash' });
        const screen = await renderScreen(<FileWorkspace escape={entry === 'escape'} />);
        const close = () => entry === 'strip' ? screen.pressByTestIdAsync('close-file')
            : act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
        await act(async () => { editor.startEditingFile(); });
        await act(async () => { editor.onEditorChange('unfinished draft'); });
        expect(editor.readSnapshot()).toMatchObject({ dirty: true });
        await close();
        // These are the public buttons of the actual WebAlertModal, not a fake alert callback.
        expect(screen.findByTestId('web-modal-button-0')).not.toBeNull();
        expect(screen.findByTestId('web-modal-button-1')).not.toBeNull();
        expect(screen.findByTestId('web-modal-button-2')).not.toBeNull();
        expect(details.tabsByKey[tab.key]).toBeDefined();
        const button = decision === 'discard' ? 0 : decision === 'keepEditing' ? 2 : 1;
        await screen.pressByTestIdAsync(`web-modal-button-${button}`);
        if (decision === 'save' || decision === 'failedSave') {
            // The modal resolves the choice; the guarded Action continues asynchronously.
            await waitForHomeGovernance(() => {
                expect(actionBoundary.calls).toHaveLength(1);
                expect(editor.isSavingEdits).toBe(false);
            });
        }
        if (decision === 'discard') {
            expect(details.tabsByKey[tab.key]).toBeUndefined();
            expect(details.tabState[tab.key]).toBeUndefined();
        } else {
            expect(details.tabsByKey[tab.key]).toBeDefined();
            expect(editor.readSnapshot()).toMatchObject({ dirty: decision !== 'save' });
            expect(editor.getEditorText()).toBe('unfinished draft');
        }
        expect(actionBoundary.calls).toHaveLength(decision === 'save' || decision === 'failedSave' ? 1 : 0);
        if (decision === 'save') {
            await close();
            expect(details.tabsByKey[tab.key]).toBeUndefined();
            expect(actionBoundary.calls).toHaveLength(1);
        }
    });
});
