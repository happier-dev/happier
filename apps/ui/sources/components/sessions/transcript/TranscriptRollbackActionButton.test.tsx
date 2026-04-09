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
                surface: 'ui_button',
            },
        );
        expect(getTranscriptModalMockRef().current).not.toBeNull();
        expect(getTranscriptModalMockRef().current.spies.alert).not.toHaveBeenCalled();
        expect(screen.findByTestId('rollback-action')?.props.accessibilityLabel).toBe('session.rollback.latestTurnA11y');
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

        preferredSessionServerIdState.value = 'server-reactive';
        await act(async () => {
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
