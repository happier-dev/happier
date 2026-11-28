import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


const globalObject = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

globalObject.IS_REACT_ACT_ENVIRONMENT = true;

type SessionWriteFileFn = typeof import('@/sync/ops').sessionWriteFile;

const sessionWriteFileSpy = vi.hoisted(() =>
    vi.fn<SessionWriteFileFn>(async () => ({ success: true, hash: 'h1' })),
);
const modalAlertSpy = vi.hoisted(() => vi.fn());

installSessionFileDetailsCommonModuleMocks({
    modal: async () =>
        createModalModuleMock({
            spies: {
                alert: (title, message, buttons) => modalAlertSpy(title, message, buttons),
            },
        }).module,
});

vi.mock('@/sync/ops', () => ({
    SESSION_WRITE_FILE_TOO_LARGE_ERROR: 'File exceeds the inline file write size limit',
    sessionWriteFile: (...args: Parameters<SessionWriteFileFn>) => sessionWriteFileSpy(...args),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: () => {},
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type SessionFileEditorState = {
    isEditingFile: boolean;
    editorDirty: boolean;
    editorSeedText: string;
    editorOriginalText: string;
    startEditingFile: () => void;
    onEditorChange: (value: string) => void;
    saveFileEdits: () => void;
};

async function createHarness(refreshAll: () => Promise<void> = async () => {}) {
    const { useSessionFileEditorState } = await import('./useSessionFileEditorState');
    const mountedRef = { current: true };
    let latest: unknown = null;
    const getState = () => latest as SessionFileEditorState;
    const Harness = () => {
        latest = useSessionFileEditorState({
            sessionId: 's1',
            sessionPath: '/tmp/workspace',
            filePath: 'a.txt',
            displayMode: 'file',
            fileText: 'hello',
            fileHash: null,
            fileWriteSupported: true,
            setFileWriteSupported: () => {},
            fileEditorFeatureEnabled: true,
            filesEditorWebMonacoEnabled: true,
            filesEditorNativeCodeMirrorEnabled: true,
            filesEditorAutoSave: false,
            filesEditorChangeDebounceMs: 0,
            filesEditorMaxFileBytes: 1_000_000,
            filesEditorBridgeMaxChunkBytes: 1_000_000,
            mountedRef,
            refreshAll,
        });
        return null;
    };
    return { Harness, getState };
}

describe('useSessionFileEditorState (save/typing divergence)', () => {
    beforeEach(() => {
        sessionWriteFileSpy.mockReset();
        modalAlertSpy.mockReset();
    });

    it('does not seed the editor with the saved snapshot when the user typed during the async write', async () => {
        let resolveWrite: ((value: Awaited<ReturnType<SessionWriteFileFn>>) => void) | null = null;
        sessionWriteFileSpy.mockImplementationOnce(() => new Promise((resolve) => {
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

    it('keeps editing the saved text until the file refresh finishes', async () => {
        sessionWriteFileSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });
        let finishRefresh!: () => void;
        const refresh = new Promise<void>((resolve) => { finishRefresh = resolve; });
        const { Harness, getState } = await createHarness(() => refresh);
        await renderScreen(<Harness />);
        await act(async () => { getState().startEditingFile(); });
        await act(async () => { getState().onEditorChange('hello changed'); });
        await act(async () => { getState().saveFileEdits(); });
        await act(async () => { await flushHookEffects(); });

        // The old read snapshot still says "hello". Exposing Edit here lets
        // another edit session seed from it before the saved file is loaded.
        expect(getState().isEditingFile).toBe(true);
        expect(getState().editorOriginalText).toBe('hello changed');
        await act(async () => { finishRefresh(); });
        expect(getState().isEditingFile).toBe(false);
        expect(getState().editorDirty).toBe(false);
    });

    it('completes the save normally when the editor did not diverge during the write', async () => {
        sessionWriteFileSpy.mockResolvedValueOnce({ success: true, hash: 'h2' });

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
        expect(sessionWriteFileSpy).toHaveBeenCalledTimes(1);
        expect(sessionWriteFileSpy.mock.calls[0]?.[2]).toBe('hello changed');
    });
});
