import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sendMessageSpy = vi.fn(async () => undefined);

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#ddd',
                        text: '#000',
                        textSecondary: '#666',
                    },
                })
                : styles,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: sendMessageSpy,
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

describe('ClaudeAgentTeamLaunchCard', () => {
    it('sends a structured team-create message', async () => {
        const { ClaudeAgentTeamLaunchCard } = await import('@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ClaudeAgentTeamLaunchCard sessionId="s1" teamIds={[]} />);
        });

        const inputs = tree!.root.findAllByType('TextInput');
        expect(inputs.length).toBeGreaterThanOrEqual(2);

        await act(async () => {
            inputs[0]!.props.onChangeText('qa-team');
            inputs[1]!.props.onChangeText('Coordinate QA work.');
        });

        const [launchTeam] = tree!.root.findAllByProps({ testID: 'session-subagent-launch-claude-team' });
        await act(async () => {
            await launchTeam.props.onPress();
        });

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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ClaudeAgentTeamLaunchCard
                    sessionId="s1"
                    teamIds={['qa-team']}
                    mode="member"
                    initialTeamId="qa-team"
                />,
            );
        });

        const inputs = tree!.root.findAllByType('TextInput');
        expect(inputs).toHaveLength(3);
        expect(inputs[0]!.props.value).toBe('qa-team');
        expect(tree!.root.findAllByProps({ testID: 'session-subagent-launch-claude-team' })).toHaveLength(0);
        expect(tree!.root.findAllByProps({ testID: 'session-subagent-launch-claude-teammate' }).length).toBeGreaterThan(0);
    });

    it('lets the user pick an existing team when launching a teammate', async () => {
        const { ClaudeAgentTeamLaunchCard } = await import('@/agents/providers/claude/sessionSubagents/ClaudeAgentTeamLaunchCard');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ClaudeAgentTeamLaunchCard
                    sessionId="s1"
                    teamIds={['qa-team', 'ops-team']}
                    mode="member"
                />,
            );
        });

        const [opsChoice] = tree!.root.findAllByProps({ testID: 'session-subagent-team-choice:ops-team' });
        await act(async () => {
            opsChoice.props.onPress();
        });

        const inputs = tree!.root.findAllByType('TextInput');
        expect(inputs[0]!.props.value).toBe('ops-team');
    });
});
