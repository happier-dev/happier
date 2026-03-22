import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                                    Platform: {
                                                        OS: 'web',
                                                    },
                                                }
    );
});

vi.mock('@/sync/ops', () => ({
    sessionWriteFile: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: vi.fn(),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type HarnessProps = Readonly<{
    displayMode: 'file' | 'diff';
    fileText: string;
}>;

describe('useSessionFileEditorState (start from diff)', () => {
    it('enters edit mode after switching to file display mode', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
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

    it('does not clobber dirty edits when fileText refreshes', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        let latest: any = null;

        function Harness(props: HarnessProps) {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/repo',
                filePath: 'src/a.ts',
                displayMode: 'file',
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
            });
            return null;
        }

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<Harness displayMode="file" fileText={'console.log(1);'} />)).tree;

        await act(async () => {
            latest.startEditingFile();
        });

        await act(async () => {
            latest.onEditorChange('console.log(2);');
        });

        expect(latest.editorDirty).toBe(true);

        await act(async () => {
            tree.update(<Harness displayMode="file" fileText={'console.log(1);\\n// refreshed'} />);
        });

        expect(latest.getEditorText()).toBe('console.log(2);');
    });

});
