import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { installWorkspaceFileDetailsCommonModuleMocks } from './workspaceFileDetailsTestHelpers';

import type { WorkspaceFileEditorState } from './useWorkspaceFileEditorState';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

installWorkspaceFileDetailsCommonModuleMocks({
    modal: async () =>
        createModalModuleMock({
            spies: {
                alert: (title, message, buttons) => modalAlertSpy(title, message, buttons),
            },
        }).module,
});

type WorkspaceWriteFileFn = typeof import('@/sync/domains/workspaces/files/workspaceFileReadWrite').workspaceWriteFile;
const workspaceWriteFileSpy = vi.hoisted(() => vi.fn<WorkspaceWriteFileFn>(async () => ({ success: true, hash: 'h1' })));
const modalAlertSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/workspaces/files/workspaceFileReadWrite', () => ({
    WORKSPACE_WRITE_FILE_TOO_LARGE_ERROR: 'File exceeds the inline file write size limit',
    workspaceWriteFile: (params: any) => workspaceWriteFileSpy(params),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: () => {},
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

async function createHarness() {
    const { useWorkspaceFileEditorState } = await import('./useWorkspaceFileEditorState');
    let latest: WorkspaceFileEditorState | null = null;
    const getState = () => {
        const state = latest;
        if (!state) throw new Error('Expected editor state to be captured');
        return state;
    };
    const fileTextRef = { current: 'hello' };
    const Harness = () => {
        latest = useWorkspaceFileEditorState({
            scope: { serverId: 'srv1', machineId: 'm1', rootPath: '/repo' },
            filePath: 'src/a.ts',
            displayMode: 'file',
            fileText: fileTextRef.current,
            fileHash: null,
            fileWriteSupported: true,
            setFileWriteSupported: vi.fn(),
            fileEditorFeatureEnabled: true,
            filesEditorWebMonacoEnabled: true,
            filesEditorNativeCodeMirrorEnabled: true,
            filesEditorAutoSave: false,
            filesEditorChangeDebounceMs: 0,
            filesEditorMaxFileBytes: 1_000_000,
            filesEditorBridgeMaxChunkBytes: 1_000_000,
            mountedRef: { current: true },
            refreshAll: vi.fn(async () => undefined),
            persistedDraft: null,
            persistDraft: vi.fn(),
        });
        return null;
    };
    return { Harness, getState, fileTextRef };
}

describe('useWorkspaceFileEditorState (save/typing divergence)', () => {
    beforeEach(() => {
        workspaceWriteFileSpy.mockReset();
        modalAlertSpy.mockReset();
    });

    it('does not seed the editor with the saved snapshot when the user typed during the async write', async () => {
        let resolveWrite: ((value: Awaited<ReturnType<WorkspaceWriteFileFn>>) => void) | null = null;
        workspaceWriteFileSpy.mockImplementationOnce(() => new Promise((resolve) => {
            resolveWrite = resolve;
        }));

        const { Harness, getState } = await createHarness();
        await renderScreen(<Harness />);

        await act(async () => {
            getState().startEditingFile();
        });
        await act(async () => {
            getState().onEditorChange('hello changed');
        });
        await act(async () => {
            getState().saveFileEdits();
        });
        for (let i = 0; i < 10 && resolveWrite === null; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
        }
        expect(resolveWrite).not.toBeNull();

        // The user keeps typing while the write is in flight.
        await act(async () => {
            getState().onEditorChange('hello changed more');
        });

        await act(async () => {
            resolveWrite?.({ success: true, hash: 'h2' });
        });
        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
        }

        // The completed save must not clobber the live editor with the stale snapshot:
        // stay in edit mode, stay dirty, and never seed the editor with the older text.
        expect(getState().isEditingFile).toBe(true);
        expect(getState().editorDirty).toBe(true);
        expect(getState().editorSeedText).not.toBe('hello changed');
        // The server-side baseline still advances to what was actually written.
        expect(getState().editorOriginalText).toBe('hello changed');
    });

    it('completes the save normally when the editor did not diverge during the write', async () => {
        workspaceWriteFileSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });

        const { Harness, getState } = await createHarness();
        await renderScreen(<Harness />);

        await act(async () => {
            getState().startEditingFile();
        });
        await act(async () => {
            getState().onEditorChange('hello changed');
        });
        await act(async () => {
            getState().saveFileEdits();
        });
        for (let i = 0; i < 10 && getState().isEditingFile; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
        }

        expect(getState().isEditingFile).toBe(false);
        expect(getState().editorDirty).toBe(false);
        // The full edited text was written. (Editor seed/original then re-sync from the
        // fileText prop, which this static harness does not refresh after the save.)
        expect(workspaceWriteFileSpy).toHaveBeenCalledTimes(1);
        expect(workspaceWriteFileSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({ content: 'hello changed' }),
        );
    });
});
