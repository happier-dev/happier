import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

const isTauriDesktopState = vi.hoisted(() => ({ value: false }));
const listenTauriEvent = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn(async () => 'task_1'));
const alertMock = vi.hoisted(() => vi.fn(async () => {}));
const snapshotState = vi.hoisted(() => ({
    result: null as null | { ok: boolean; error?: { message?: string } },
}));

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        isTauriDesktop: () => isTauriDesktopState.value,
        listenTauriEvent,
    };
});

vi.mock('@/components/systemTasks', () => ({
    getDefaultSystemTaskRunner: () => ({
        mode: 'tauri',
        start: startMock,
        cancel: vi.fn(async () => {}),
        respond: vi.fn(async () => {}),
        getSnapshot: () => ({ taskId: 'task_1', status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: snapshotState.result }),
        subscribe: vi.fn(() => () => {}),
    }),
    useSystemTaskSnapshot: (_runner: unknown, taskId: string | null) => (taskId ? { taskId, status: 'running', currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: snapshotState.result } : null),
}));

vi.mock('@/components/systemTasks/systemTaskStartError', () => ({
    readSystemTaskStartErrorMessage: () => null,
}));

vi.mock('@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec', () => ({
    buildLocalDaemonServiceSystemTaskSpec: (kind: string) => ({ kind }),
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: alertMock,
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('DesktopTrayDaemonLifecycleRuntime', () => {
    afterEach(() => {
        isTauriDesktopState.value = false;
        listenTauriEvent.mockReset();
        startMock.mockReset();
        alertMock.mockReset();
        snapshotState.result = null;
    });

    it('starts the daemon lifecycle task when the tray emits a daemon action', async () => {
        isTauriDesktopState.value = true;
        let capturedListener: ((payload: { action: 'start' | 'stop' | 'restart' }) => void) | null = null;
        listenTauriEvent.mockImplementation(async (_event: string, handler: (payload: { action: 'start' | 'stop' | 'restart' }) => void) => {
            capturedListener = handler;
            return () => {};
        });

        const { DesktopTrayDaemonLifecycleRuntime } = await import('./DesktopTrayDaemonLifecycleRuntime');
        const { tree } = await renderScreen(<DesktopTrayDaemonLifecycleRuntime />);

        await act(async () => {
            capturedListener?.({ action: 'stop' });
        });

        expect(startMock).toHaveBeenCalledWith({ kind: 'daemon.service.stop.v1' });
        expect(alertMock).not.toHaveBeenCalled();

        await act(async () => {
            tree.unmount();
        });
    });

    it('shows an error alert when a tray lifecycle action fails to start', async () => {
        isTauriDesktopState.value = true;
        startMock.mockRejectedValueOnce(new Error('bridge unavailable'));
        let capturedListener: ((payload: { action: 'start' | 'stop' | 'restart' }) => void) | null = null;
        listenTauriEvent.mockImplementation(async (_event: string, handler: (payload: { action: 'start' | 'stop' | 'restart' }) => void) => {
            capturedListener = handler;
            return () => {};
        });

        const { DesktopTrayDaemonLifecycleRuntime } = await import('./DesktopTrayDaemonLifecycleRuntime');
        const { tree } = await renderScreen(<DesktopTrayDaemonLifecycleRuntime />);

        await act(async () => {
            capturedListener?.({ action: 'restart' });
        });

        expect(alertMock).toHaveBeenCalledWith('common.error', 'settings.systemTaskStartFailed');

        await act(async () => {
            tree.unmount();
        });
    });
});
