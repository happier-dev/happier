import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    getTranscriptModalMockRef,
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn();
const updateSessionDraftSpy = vi.fn();
const createDefaultActionExecutorSpy = vi.fn((_: unknown) => ({
    execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
}));

installTranscriptCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: createStorageStoreMock({
                    updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
                }),
            },
        });
    },
});
resetTranscriptCommonModuleMockState();

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => `server:${sessionId}`,
}));

describe('TranscriptRollbackActionButton', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        executeSpy.mockReset();
        updateSessionDraftSpy.mockReset();
        createDefaultActionExecutorSpy.mockClear();
        getTranscriptModalMockRef().current?.spies.alert?.mockReset();
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
        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).not.toHaveBeenCalled();
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

        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).toHaveBeenCalledWith('common.error', 'nope');
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
