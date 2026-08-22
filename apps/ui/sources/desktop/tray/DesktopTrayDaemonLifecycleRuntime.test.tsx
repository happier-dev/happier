import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { IModal } from '@/modal';

const isDesktopHostState = vi.hoisted(() => ({ value: false }));
const listenDesktopHostEvent = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn(async () => 'task_1'));
const alertMock = vi.hoisted(() => vi.fn());
const snapshotState = vi.hoisted(() => ({
    result: null as null | { ok: boolean; error?: { message?: string } },
}));

vi.mock('@/utils/platform/desktopHost', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/desktopHost')>('@/utils/platform/desktopHost');
    return {
        ...actual,
        isDesktopHost: () => isDesktopHostState.value,
        listenDesktopHostEvent,
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

const modalMock = createModalModuleMock({
    spies: {
        alert: (...args: Parameters<IModal['alert']>) => {
            alertMock(...args);
        },
    },
});

vi.mock('@/modal', () => modalMock.module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

describe('DesktopTrayDaemonLifecycleRuntime', () => {
    afterEach(() => {
        isDesktopHostState.value = false;
        listenDesktopHostEvent.mockReset();
        startMock.mockReset();
        alertMock.mockReset();
        snapshotState.result = null;
    });

    it('starts the daemon lifecycle task when the tray emits a daemon action', async () => {
        isDesktopHostState.value = true;
        let capturedListener: ((payload: { action: 'start' | 'stop' | 'restart' }) => void) | null = null;
        listenDesktopHostEvent.mockImplementation(async (_event: string, handler: (payload: { action: 'start' | 'stop' | 'restart' }) => void) => {
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
        isDesktopHostState.value = true;
        startMock.mockRejectedValueOnce(new Error('bridge unavailable'));
        let capturedListener: ((payload: { action: 'start' | 'stop' | 'restart' }) => void) | null = null;
        listenDesktopHostEvent.mockImplementation(async (_event: string, handler: (payload: { action: 'start' | 'stop' | 'restart' }) => void) => {
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
