import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agentInputSpy = vi.fn();
const modalAlertSpy = vi.fn();
const syncSendMessageSpy = vi.fn(async () => undefined);
const sessionExecutionRunSendSpy = vi.fn<
    (sessionId: string, request: { runId: string; message: string; delivery?: 'prompt' | 'steer_if_supported' | 'interrupt' }) => Promise<{ ok: boolean; error?: string }>
>(async () => ({ ok: true }));
const isExecutionRunNotRunningSendErrorSpy = vi.fn(() => false);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('View', props, children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: unknown) => {
        agentInputSpy(props);
        return React.createElement('AgentInput', props as Record<string, unknown>);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children),
}));

vi.mock('@/components/autocomplete/suggestions', () => ({
    getSuggestions: vi.fn(async () => []),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: (...args: unknown[]) => modalAlertSpy(...args),
        },
    }).module;
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunSend: (...args: Parameters<typeof sessionExecutionRunSendSpy>) => sessionExecutionRunSendSpy(...args),
    isExecutionRunNotRunningSendError: (...args: Parameters<typeof isExecutionRunNotRunningSendErrorSpy>) => isExecutionRunNotRunningSendErrorSpy(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: Parameters<typeof syncSendMessageSpy>) => syncSendMessageSpy(...args),
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('SessionParticipantComposer', () => {
    beforeEach(() => {
        agentInputSpy.mockClear();
        modalAlertSpy.mockClear();
        syncSendMessageSpy.mockClear();
        sessionExecutionRunSendSpy.mockClear();
        isExecutionRunNotRunningSendErrorSpy.mockClear();
    });

    it('routes execution-run sends through sessionExecutionRunSend', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        const tree: renderer.ReactTestRenderer | null = (await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            executionRunDelivery="interrupt"
        />)).tree;

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Refine the current review');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(tree).toBeTruthy();
        expect(sessionExecutionRunSendSpy).toHaveBeenCalledWith('s1', {
            runId: 'run_1',
            message: 'Refine the current review',
            delivery: 'interrupt',
        });
        expect(syncSendMessageSpy).not.toHaveBeenCalled();
    });

    it('routes agent-team sends through sync.sendMessage with participant meta', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');

        const tree: renderer.ReactTestRenderer | null = (await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            }}
        />)).tree;

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Please focus on regressions only');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(tree).toBeTruthy();
        expect(syncSendMessageSpy).toHaveBeenCalledWith(
            's1',
            'Please focus on regressions only',
            undefined,
            expect.objectContaining({
                happier: expect.objectContaining({
                    kind: 'participant_message.v1',
                    payload: expect.objectContaining({
                        recipient: expect.objectContaining({
                            kind: 'agent_team_member',
                            teamId: 'qa-team',
                            memberId: 'alpha@qa-team',
                        }),
                    }),
                }),
            }),
        );
        expect(sessionExecutionRunSendSpy).not.toHaveBeenCalled();
    });

    it('clears the focused execution-run recipient when the run is no longer running', async () => {
        sessionExecutionRunSendSpy.mockResolvedValueOnce({ ok: false, error: 'execution_run_not_running' });
        isExecutionRunNotRunningSendErrorSpy.mockReturnValueOnce(true);

        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const onExecutionRunUnavailable = vi.fn();

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            onExecutionRunUnavailable={onExecutionRunUnavailable}
        />);

        let agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onChangeText('Ping');
        });
        agentInputProps = agentInputSpy.mock.lastCall?.[0] as {
            onChangeText: (text: string) => void;
            onSend: () => void;
        };
        await act(async () => {
            agentInputProps.onSend();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(onExecutionRunUnavailable).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).toHaveBeenCalled();
    });

    it('passes extra action chips through to AgentInput', async () => {
        const { SessionParticipantComposer } = await import('./SessionParticipantComposer');
        const extraActionChips = [{
            key: 'recipient',
            render: () => null,
        }] satisfies readonly AgentInputExtraActionChip[];

        await renderScreen(<SessionParticipantComposer
            sessionId="s1"
            canSendMessages
            recipient={{ kind: 'execution_run', runId: 'run_1' }}
            extraActionChips={extraActionChips}
        />);

        expect(agentInputSpy).toHaveBeenCalledWith(expect.objectContaining({
            extraActionChips,
        }));
    });
});
