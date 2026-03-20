import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const executeSpy = vi.fn();
const modalAlertSpy = vi.fn();
const updateSessionDraftSpy = vi.fn();
const createDefaultActionExecutorSpy = vi.fn((_: unknown) => ({
    execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
}));

vi.mock('react-native', async () => ({
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ActivityIndicator: 'ActivityIndicator',
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#555',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => (typeof input === 'function' ? input({ colors: { textSecondary: '#555' } }, {}) : input),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: (title: unknown, message: unknown) => modalAlertSpy(title, message) },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => `server:${sessionId}`,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
        }),
    },
}));

describe('TranscriptRollbackActionButton', () => {
    beforeEach(() => {
        executeSpy.mockReset();
        modalAlertSpy.mockReset();
        updateSessionDraftSpy.mockReset();
        createDefaultActionExecutorSpy.mockClear();
    });

    it('executes the latest-turn rollback action for the session', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                />,
            );
        });

        const button = tree!.root.findByType('Pressable');

        await act(async () => {
            await button.props.onPress();
        });

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
        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(button.props.accessibilityLabel).toBe('session.rollback.latestTurnA11y');
        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(expect.objectContaining({
            resolveServerIdForSessionId: expect.any(Function),
        }));
    }, 120000);

    it('alerts when the underlying rollback RPC result is not ok', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: false, errorMessage: 'nope' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                />,
            );
        });

        const button = tree!.root.findByType('Pressable');

        await act(async () => {
            await button.props.onPress();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'nope');
    });

    it('prefills the session draft after rollback-to-point succeeds', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                    target={{ type: 'before_user_message', userMessageSeq: 7 }}
                    restoredDraftText="edit this prompt"
                />,
            );
        });

        const button = tree!.root.findByType('Pressable');
        expect(button.props.accessibilityLabel).toBe('session.rollback.beforeUserMessageA11y');

        await act(async () => {
            await button.props.onPress();
        });

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
    });

});
