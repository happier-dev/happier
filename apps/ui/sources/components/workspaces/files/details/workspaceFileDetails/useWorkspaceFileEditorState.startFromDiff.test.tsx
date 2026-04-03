import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks();

vi.mock('@/sync/domains/workspaces/files/workspaceFileReadWrite', () => ({
    workspaceWriteFile: vi.fn(async () => ({ success: true, hash: 'h1' })),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: vi.fn(),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type HarnessProps = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string;
}>;

describe('useWorkspaceFileEditorState (start from diff)', () => {
    it('enters edit mode after switching to file display mode', async () => {
        const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useWorkspaceFileEditorState({
                scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
                filePath: 'src/a.ts',
                displayMode: props.displayMode,
                fileText: props.fileText,
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

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="diff" fileText={'console.log(1);'} />)).tree;

        expect(latest).not.toBeNull();

        await act(async () => {
            latest.startEditingFile();
        });

        expect(latest.isEditingFile).toBe(false);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);'} />);
        });

        expect(latest.isEditingFile).toBe(true);
    });
});
