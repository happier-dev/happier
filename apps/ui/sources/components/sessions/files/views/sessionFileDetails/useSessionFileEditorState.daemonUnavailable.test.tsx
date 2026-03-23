import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { installSessionFileDetailsCommonModuleMocks } from './sessionFileDetailsTestHelpers';
import { renderScreen } from '@/dev/testkit';


const globalObject = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

globalObject.IS_REACT_ACT_ENVIRONMENT = true;

type SessionWriteFileFn = typeof import('@/sync/ops').sessionWriteFile;

const sessionWriteFileSpy = vi.hoisted(() =>
    vi.fn<SessionWriteFileFn>(async () => ({ success: true, hash: 'h1' })),
);
const showDaemonUnavailableAlertSpy = vi.hoisted(() => vi.fn());
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
    sessionWriteFile: (...args: Parameters<SessionWriteFileFn>) => sessionWriteFileSpy(...args),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    showDaemonUnavailableAlert: (params: DaemonUnavailableAlertParams) => showDaemonUnavailableAlertSpy(params),
    tryShowDaemonUnavailableAlertForRpcError: () => false,
}));

type SessionFileEditorState = {
    editorSurfaceEnabled: boolean;
    isEditingFile: boolean;
    startEditingFile: () => void;
    onEditorChange: (value: string) => void;
    saveFileEdits: () => void;
};

type DaemonUnavailableAlertParams = {
    titleKey: string;
    bodyKey: string;
    machine?: unknown;
    onRetry?: (() => void) | null;
    shouldContinue?: (() => boolean) | null;
};

describe('useSessionFileEditorState (daemon unavailable)', () => {
    beforeEach(() => {
        sessionWriteFileSpy.mockReset();
        showDaemonUnavailableAlertSpy.mockReset();
        modalAlertSpy.mockReset();
    });

    it('treats METHOD_NOT_AVAILABLE as daemon unavailable without disabling editor support', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        sessionWriteFileSpy.mockResolvedValueOnce({
            success: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        });

        const mountedRef = { current: true };
        const setFileWriteSupported = vi.fn();
        let latest: unknown = null;
        const getState = () => latest as SessionFileEditorState;

        const Harness = () => {
            latest = useSessionFileEditorState({
                sessionId: 's1',
                sessionPath: '/tmp/workspace',
                filePath: 'a.txt',
                displayMode: 'file',
                fileText: 'hello',
                fileWriteSupported: true,
                setFileWriteSupported,
                fileEditorFeatureEnabled: true,
                filesEditorWebMonacoEnabled: true,
                filesEditorNativeCodeMirrorEnabled: true,
                filesEditorAutoSave: false,
                filesEditorChangeDebounceMs: 0,
                filesEditorMaxFileBytes: 1_000_000,
                filesEditorBridgeMaxChunkBytes: 1_000_000,
                mountedRef,
                refreshAll: async () => {},
            });
            return null;
        };

        await renderScreen(<Harness />);

        expect(getState().editorSurfaceEnabled).toBe(true);

        await act(async () => {
            getState().startEditingFile();
        });

        await act(async () => {
            getState().onEditorChange('hello changed');
        });

        await act(async () => {
            getState().saveFileEdits();
        });

        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
            if (showDaemonUnavailableAlertSpy.mock.calls.length > 0) break;
        }

        expect(showDaemonUnavailableAlertSpy).toHaveBeenCalledTimes(1);
        expect(showDaemonUnavailableAlertSpy.mock.calls[0]?.[0]).toEqual(
            expect.objectContaining({
                titleKey: 'errors.daemonUnavailableTitle',
                bodyKey: 'errors.daemonUnavailableBody',
                machine: null,
            }),
        );

        expect(setFileWriteSupported).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(getState().editorSurfaceEnabled).toBe(true);
        expect(getState().isEditingFile).toBe(true);
        expect(sessionWriteFileSpy).toHaveBeenCalledTimes(1);
        expect(sessionWriteFileSpy.mock.calls[0]?.[2]).toBe('hello changed');
    });

    it('passes a shouldContinue guard that becomes false after unmount', async () => {
        const { useSessionFileEditorState } = await import('./useSessionFileEditorState');

        sessionWriteFileSpy.mockResolvedValueOnce({
            success: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        });

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
                refreshAll: async () => {},
            });
            return null;
        };

        await renderScreen(<Harness />);

        await act(async () => {
            getState().startEditingFile();
            getState().onEditorChange('hello changed');
        });

        await act(async () => {
            getState().saveFileEdits();
        });

        for (let i = 0; i < 10; i++) {
            await act(async () => {
                await flushHookEffects({ cycles: 1, turns: 1 });
            });
            if (showDaemonUnavailableAlertSpy.mock.calls.length > 0) break;
        }

        const params = showDaemonUnavailableAlertSpy.mock.calls[0]?.[0] as DaemonUnavailableAlertParams | undefined;
        expect(params?.shouldContinue).toBeTypeOf('function');
        expect(params?.shouldContinue?.()).toBe(true);

        mountedRef.current = false;
        expect(params?.shouldContinue?.()).toBe(false);
    });
});
