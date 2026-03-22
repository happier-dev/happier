import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn();
const updateSessionDraftSpy = vi.fn();
const createDefaultActionExecutorSpy = vi.fn((_: unknown) => ({
    execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
}));
const modalMockRuntime = vi.hoisted(() => ({ current: null as any }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                        Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
                        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                        ActivityIndicator: 'ActivityIndicator',
                        AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
                    }
    );
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#555',
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMockRuntime.current = modalMock;
    return modalMock.module;
});

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => `server:${sessionId}`,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            storage: createStorageStoreMock({
                updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
            }),
        },
    });
});

describe('TranscriptRollbackActionButton', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        executeSpy.mockReset();
        updateSessionDraftSpy.mockReset();
        createDefaultActionExecutorSpy.mockClear();
        modalMockRuntime.current?.spies.alert?.mockReset();
    });

    it('executes the latest-turn rollback action for the session', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenCalledWith(
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'latest_turn' },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui_button',
            },
        );
        expect(modalMockRuntime.current.spies.alert).not.toHaveBeenCalled();
        expect(screen.findByTestId('rollback-action')?.props.accessibilityLabel).toBe('session.rollback.latestTurnA11y');
        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(expect.objectContaining({
            resolveServerIdForSessionId: expect.any(Function),
        }));
        await screen.unmount();
    }, 120000);

    it('alerts when the underlying rollback RPC result is not ok', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: false, errorMessage: 'nope' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(modalMockRuntime.current.spies.alert).toHaveBeenCalledWith('common.error', 'nope');
        await screen.unmount();
    });

    it('prefills the session draft after rollback-to-point succeeds', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText="edit this prompt"
            />,
        );
        expect(screen.findByTestId('rollback-action')?.props.accessibilityLabel).toBe('session.rollback.beforeUserMessageA11y');
        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenCalledWith(
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'before_user_message', userMessageSeq: 7 },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui_button',
            },
        );
        expect(updateSessionDraftSpy).toHaveBeenCalledWith('session-1', 'edit this prompt');
        await screen.unmount();
    });

});
