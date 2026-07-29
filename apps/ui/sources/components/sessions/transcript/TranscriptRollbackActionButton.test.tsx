import * as React from 'react';
import { act } from 'react-test-renderer';
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
const createDefaultActionExecutorSpy = vi.fn((_: Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
}> | undefined) => ({
    execute: (actionId: unknown, input: unknown, ctx: unknown) => executeSpy(actionId, input, ctx),
}));
const preferredSessionServerIdState = vi.hoisted(() => {
    let value = 'server-explicit';
    const listeners = new Set<(nextValue: string) => void>();

    return {
        get value() {
            return value;
        },
        set value(nextValue: string) {
            value = nextValue;
            for (const listener of listeners) {
                listener(nextValue);
            }
        },
        subscribe(listener: (nextValue: string) => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const resolveSessionTargetServerIdSpy = vi.fn<(sessionId: string) => string | null>();

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!Array.isArray(style)) {
        return style && typeof style === 'object' ? style as Record<string, unknown> : {};
    }
    return Object.assign({}, ...style.map(flattenStyle));
}

installTranscriptCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSession: () => ({
                    id: 's1',
                    serverId: 'server-explicit',
                    metadata: { machineId: 'm1' },
                } as any),
                storage: createStorageStoreMock({
                    updateSessionDraft: (...args: any[]) => updateSessionDraftSpy(...args),
                }),
            },
        });
    },
});
resetTranscriptCommonModuleMockState();

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (opts?: unknown) => createDefaultActionExecutorSpy(opts as any),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => {
        const [sessionServerId, setSessionServerId] = React.useState(preferredSessionServerIdState.value);
        React.useEffect(() => preferredSessionServerIdState.subscribe(setSessionServerId), []);
        return sessionServerId;
    },
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
    resolveSessionTargetServerId: (sessionId: string, fallbackServerId?: string | null) =>
        resolveSessionTargetServerIdSpy(sessionId) ?? fallbackServerId ?? null,
}));

describe('TranscriptRollbackActionButton', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        executeSpy.mockReset();
        updateSessionDraftSpy.mockReset();
        createDefaultActionExecutorSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockReset();
        preferredSessionServerIdState.value = 'server-explicit';
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
                surface: 'ui',
            },
        );
        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).not.toHaveBeenCalled();
        const rollbackAction = screen.findByTestId('rollback-action');
        expect(rollbackAction?.props.accessibilityLabel).toBe('session.rollback.latestTurnA11y');
        const rollbackStyle = typeof rollbackAction?.props.style === 'function'
            ? rollbackAction.props.style({ pressed: false })
            : rollbackAction?.props.style;
        expect(flattenStyle(rollbackStyle).minWidth).toBeGreaterThanOrEqual(44);
        expect(flattenStyle(rollbackStyle).minHeight).toBeGreaterThanOrEqual(44);
        expect(createDefaultActionExecutorSpy).toHaveBeenCalledWith(expect.objectContaining({
            resolveServerIdForSessionId: expect.any(Function),
        }));
        expect(createDefaultActionExecutorSpy.mock.calls[0]?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-explicit');
        await screen.unmount();
    }, 120000);

    it('re-resolves the session server when the preferred server changes', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: true } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
            />,
        );

        expect(createDefaultActionExecutorSpy.mock.calls[0]?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-explicit');

        await act(async () => {
            preferredSessionServerIdState.value = 'server-reactive';
            screen.tree.update(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                />,
            );
        });

        expect(createDefaultActionExecutorSpy.mock.calls.at(-1)?.[0]?.resolveServerIdForSessionId?.('s1')).toBe('server-reactive');
        await screen.unmount();
    });

    it('uses a physical 48dp Android target without overlapping hit slop', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
            const screen = await renderScreen(
                <TranscriptRollbackActionButton
                    sessionId="session-1"
                    testID="rollback-action"
                />,
            );

            const rollbackAction = screen.findByTestId('rollback-action');
            const rollbackStyle = typeof rollbackAction?.props.style === 'function'
                ? rollbackAction.props.style({ pressed: false })
                : rollbackAction?.props.style;
            expect(flattenStyle(rollbackStyle).minWidth).toBeGreaterThanOrEqual(48);
            expect(flattenStyle(rollbackStyle).minHeight).toBeGreaterThanOrEqual(48);
            expect(rollbackAction?.props.hitSlop).toBeUndefined();
            await screen.unmount();
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('alerts when the underlying rollback RPC result is not ok', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { ok: false, errorMessage: 'nope' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText="do not restore"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).toHaveBeenCalledWith('common.error', 'nope');
        expect(updateSessionDraftSpy).not.toHaveBeenCalled();
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
                surface: 'ui',
            },
        );
        expect(updateSessionDraftSpy).toHaveBeenCalledWith('session-1', 'edit this prompt');
        await screen.unmount();
    });

    it('does not prefill the draft when rollback is only routed to an approval request', async () => {
        executeSpy.mockResolvedValueOnce({
            ok: true,
            result: {
                kind: 'approval_request_created',
                artifactId: 'artifact-1',
                actionId: 'session.rollback',
            },
        });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                restoredDraftText="edit this prompt"
            />,
        );
        await screen.pressByTestIdAsync('rollback-action');

        expect(updateSessionDraftSpy).not.toHaveBeenCalled();
        expect(getTranscriptModalMockRef().current?.spies.alert).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('runs advanced code-only rollback through production action after explicit confirmation', async () => {
        executeSpy.mockResolvedValueOnce({ ok: true, result: { status: 'applied' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                checkpointCodeRollback={{
                    conversationRollbackSupported: false,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'code_only_without_stash',
            backupMode: 'happier_checkpoint_only',
            codeOnlyTranscriptDivergenceConfirmed: true,
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current?.spies.show).toHaveBeenCalled();
        expect(executeSpy).toHaveBeenCalledWith(
            'session.checkpoint_code_rollback',
            {
                v: 1,
                sessionId: 'session-1',
                turnId: 'turn-1',
                cwd: '/repo',
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        await screen.unmount();
    });

    it('composes conversation rollback in UI before invoking code-only rollback action', async () => {
        executeSpy
            .mockResolvedValueOnce({ ok: true, result: { ok: true } })
            .mockResolvedValueOnce({ ok: true, result: { status: 'applied' } });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                checkpointCodeRollback={{
                    conversationRollbackSupported: true,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(executeSpy).toHaveBeenNthCalledWith(
            1,
            'session.rollback',
            {
                sessionId: 'session-1',
                target: { type: 'before_user_message', userMessageSeq: 7 },
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        expect(executeSpy).toHaveBeenNthCalledWith(
            2,
            'session.checkpoint_code_rollback',
            {
                v: 1,
                sessionId: 'session-1',
                turnId: 'turn-1',
                cwd: '/repo',
                codeMode: 'code_only_without_stash',
                backupMode: 'happier_checkpoint_only',
                expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                codeOnlyTranscriptDivergenceConfirmed: true,
            },
            {
                defaultSessionId: 'session-1',
                surface: 'ui',
            },
        );
        await screen.unmount();
    });

    it('surfaces checkpoint code rollback conflict after conversation rollback succeeds', async () => {
        executeSpy
            .mockResolvedValueOnce({ ok: true, result: { ok: true } })
            .mockResolvedValueOnce({
                ok: true,
                result: {
                    status: 'conflict',
                    diagnostics: ['reverse patch did not apply cleanly'],
                },
            });

        const { TranscriptRollbackActionButton } = await import('./TranscriptRollbackActionButton');
        const screen = await renderScreen(
            <TranscriptRollbackActionButton
                sessionId="session-1"
                testID="rollback-action"
                target={{ type: 'before_user_message', userMessageSeq: 7 }}
                checkpointCodeRollback={{
                    conversationRollbackSupported: true,
                    turnId: 'turn-1',
                    cwd: '/repo',
                    expectedStartRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-start/turn-1',
                    expectedFinalRef: 'refs/happier/checkpoints/c2Vzc2lvbi0x/turn-final/turn-1',
                }}
            />,
        );
        getTranscriptModalMockRef().current?.spies.show?.mockImplementationOnce(({ props }: any) => props?.onConfirm?.({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
        }));

        await screen.pressByTestIdAsync('rollback-action');

        expect(getTranscriptModalMockRef().current?.spies.alert).toHaveBeenCalledWith(
            'common.error',
            expect.stringContaining('reverse patch did not apply cleanly'),
        );
        await screen.unmount();
    });

});
