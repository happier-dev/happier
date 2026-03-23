import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import {
    changeTextTestInstance,
    renderScreen,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sendMessageSpy = vi.fn(async () => undefined);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: ({ children, ...props }: any) => React.createElement('View', props, children),
                    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        sendMessage: sendMessageSpy,
    }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

describe('ClaudeAgentTeamLaunchCard', () => {
    it('sends a structured team-create message', async () => {
        const { ClaudeAgentTeamLaunchCard } = await import('@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard');

        const screen = await renderScreen(<ClaudeAgentTeamLaunchCard sessionId="s1" teamIds={[]} />);

        const teamIdInput = screen.findAllByProps({ placeholder: 'session.subagents.panel.teamIdPlaceholder' })[0];
        const teamDescriptionInput = screen.findByProps({ placeholder: 'session.subagents.panel.teamDescriptionPlaceholder' });

        await act(async () => {
            changeTextTestInstance(teamIdInput, 'qa-team', 'team id input');
            changeTextTestInstance(teamDescriptionInput, 'Coordinate QA work.', 'team description input');
        });

        await screen.pressByTestIdAsync('session-subagent-launch-claude-team');

        expect(sendMessageSpy).toHaveBeenCalledWith(
            's1',
            'Create team qa-team',
            'Create team qa-team',
            expect.objectContaining({
                happier: {
                    kind: 'subagent_launch.v1',
                    payload: expect.objectContaining({
                        kind: 'agent_team_create',
                        teamId: 'qa-team',
                        description: 'Coordinate QA work.',
                    }),
                },
            }),
        );
    });

    it('can render teammate-only mode with an initial team id', async () => {
        const { ClaudeAgentTeamLaunchCard } = await import('@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard');

        const screen = await renderScreen(
            <ClaudeAgentTeamLaunchCard
                sessionId="s1"
                teamIds={['qa-team']}
                mode="member"
                initialTeamId="qa-team"
            />,
        );

        expect(screen.findByProps({ placeholder: 'session.subagents.panel.teamIdPlaceholder' })?.props.value).toBe('qa-team');
        expect(screen.findByProps({ placeholder: 'session.subagents.panel.teammateLabelPlaceholder' })?.props.value).toBe('');
        expect(screen.findByProps({ placeholder: 'session.subagents.panel.teammateInstructionsPlaceholder' })?.props.value).toBe('');
        expect(screen.findByTestId('session-subagent-launch-claude-team')).toBeNull();
        expect(screen.findByTestId('session-subagent-launch-claude-teammate')).toBeTruthy();
    });

    it('lets the user pick an existing team when launching a teammate', async () => {
        const { ClaudeAgentTeamLaunchCard } = await import('@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard');

        const screen = await renderScreen(
            <ClaudeAgentTeamLaunchCard
                sessionId="s1"
                teamIds={['qa-team', 'ops-team']}
                mode="member"
            />,
        );

        await screen.pressByTestIdAsync('session-subagent-team-choice:ops-team');
        expect(screen.findByProps({ placeholder: 'session.subagents.panel.teamIdPlaceholder' })?.props.value).toBe('ops-team');
    });
});
