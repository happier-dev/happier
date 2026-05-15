import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks();

type WorkspaceWriteFileFn = typeof import('@/sync/domains/workspaces/files/workspaceFileReadWrite').workspaceWriteFile;
const workspaceWriteFileSpy = vi.hoisted(() => vi.fn<WorkspaceWriteFileFn>(async () => ({ success: true, hash: 'saved-hash' })));

vi.mock('@/sync/domains/workspaces/files/workspaceFileReadWrite', () => ({
    workspaceWriteFile: (params: any) => workspaceWriteFileSpy(params),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: vi.fn(),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type HarnessProps = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string;
    fileHash?: string | null;
}>;

describe('useWorkspaceFileEditorState (start from diff)', () => {
    it('enters edit mode after switching to file display mode', async () => {
        const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');

        let latest: WorkspaceFileEditorState | null = null;

        function Harness(props: HarnessProps) {
            latest = useWorkspaceFileEditorState({
                scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: null,
                persistDraft: vi.fn(),
            });
            return null;
        }
        const readLatest = () => {
            const state = latest;
            if (!state) throw new Error('Expected editor state to be captured');
            return state;
        };

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="diff" fileText={'console.log(1);'} />)).tree;

        expect(latest).not.toBeNull();

        await act(async () => {
            readLatest().startEditingFile();
        });

        expect(readLatest().isEditingFile).toBe(false);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(readLatest().isEditingFile).toBe(true);
    });

    it('keeps save callback stable across equivalent input rerenders', async () => {
        const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');

        let latest: WorkspaceFileEditorState | null = null;
        const mountedRef = { current: true };
        const setFileWriteSupported = vi.fn();
        const refreshAll = vi.fn(async () => undefined);
        const persistDraft = vi.fn();

        function Harness(props: HarnessProps) {
            latest = useWorkspaceFileEditorState({
                scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported,
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef,
                refreshAll,
                persistedDraft: null,
                persistDraft,
            });
            return null;
        }
        const readLatest = () => {
            const state = latest;
            if (!state) throw new Error('Expected editor state to be captured');
            return state;
        };

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />)).tree;
        await act(async () => {});

        const firstSaveFileEdits = readLatest().saveFileEdits;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(readLatest().saveFileEdits).toBe(firstSaveFileEdits);
    });

    it('does not reset the editor while editing when fileText refreshes before dirty state changes', async () => {
        const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');

        let latest: WorkspaceFileEditorState | null = null;

        function Harness(props: HarnessProps) {
            latest = useWorkspaceFileEditorState({
                scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: null,
                persistDraft: vi.fn(),
            });
            return null;
        }
        const readLatest = () => {
            const state = latest;
            if (!state) throw new Error('Expected editor state to be captured');
            return state;
        };

        const tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="hash-1" />)).tree;

        await act(async () => {
            readLatest().startEditingFile();
        });

        const resetKeyBeforeRefresh = readLatest().editorResetKey;
        const seedBeforeRefresh = readLatest().editorSeedText;

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\n// refreshed'} fileHash="hash-2" />);
        });

        expect(readLatest().editorResetKey).toBe(resetKeyBeforeRefresh);
        expect(readLatest().editorSeedText).toBe(seedBeforeRefresh);
        expect(readLatest().getEditorText()).toBe(seedBeforeRefresh);
        expect(readLatest().fileChangedExternally).toBe(true);
    });

    it('guards saves with the hash from the loaded file content', async () => {
        const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');

        let latest: WorkspaceFileEditorState | null = null;

        function Harness(props: HarnessProps) {
            latest = useWorkspaceFileEditorState({
                scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
                filePath: 'src/a.ts',
                displayMode: 'file',
                fileText: props.fileText,
                fileHash: props.fileHash ?? null,
                fileWriteSupported: true,
                setFileWriteSupported: vi.fn(),
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 10,
                filesEditorMaxFileBytes: 10_000,
                filesEditorBridgeMaxChunkBytes: 10_000,
                mountedRef: { current: true },
                refreshAll: vi.fn(async () => undefined),
                persistedDraft: null,
                persistDraft: vi.fn(),
            });
            return null;
        }
        const readLatest = () => {
            const state = latest;
            if (!state) throw new Error('Expected editor state to be captured');
            return state;
        };

        workspaceWriteFileSpy.mockClear();
        await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} fileHash="loaded-hash" />);

        await act(async () => {
            readLatest().startEditingFile();
        });

        await act(async () => {
            readLatest().onEditorChange('console.log(2);');
        });

        await act(async () => {
            readLatest().saveFileEdits();
        });

        expect(workspaceWriteFileSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            path: 'src/a.ts',
            content: 'console.log(2);',
            expectedHash: 'loaded-hash',
        }));
    });
});
