import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sendMessageSpy = vi.fn(async () => undefined);

vi.mock('react-native', () => ({
    View: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Pressable', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: unknown) => styles,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('Text', props, children),
}));

vi.mock('@/components/sessions/agents/list/SessionSubagentRow', () => ({
    SessionSubagentRow: (props: { subagent: SessionSubagent }) => React.createElement('SessionSubagentRow', { testID: `row:${props.subagent.id}` }),
}));

vi.mock('@/text', () => ({
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'session.subagents.panel.groupCount' && typeof values?.count === 'number') {
            return `${values.count} agents`;
        }
        return key;
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: sendMessageSpy,
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

describe('SessionSubagentGroup', () => {
    it('sends a structured team-delete message for Claude team groups', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');
        sendMessageSpy.mockClear();

        const subagents: readonly SessionSubagent[] = [{
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: {
                title: 'alpha',
                providerLabel: 'Claude',
                groupKey: 'qa-team',
                groupLabel: 'qa-team',
            },
            transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        }];

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    subagents={subagents}
                    activityPreviewById={new Map()}
                    pendingPermissionById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />,
            );
        });

        const [deleteButton] = tree!.root.findAllByProps({ testID: 'session-subagent-team-delete:qa-team' });
        expect(deleteButton).toBeTruthy();

        await act(async () => {
            await deleteButton.props.onPress();
        });

        expect(sendMessageSpy).toHaveBeenCalledWith(
            's1',
            'Delete team qa-team',
            'Delete team qa-team',
            expect.objectContaining({
                happier: {
                    kind: 'subagent_command.v1',
                    payload: expect.objectContaining({
                        kind: 'agent_team_delete',
                        teamId: 'qa-team',
                    }),
                },
            }),
        );
    });

    it('renders a group count alongside the group label', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');

        const subagents: readonly SessionSubagent[] = [
            {
                id: 'agent_team_member:qa-team:alpha',
                kind: 'agent_team_member',
                status: 'running',
                display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
                recipient: {
                    kind: 'agent_team_member',
                    teamId: 'qa-team',
                    memberId: 'alpha@qa-team',
                    memberLabel: 'alpha',
                },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
                timestamps: {},
            },
            {
                id: 'agent_team_member:qa-team:beta',
                kind: 'agent_team_member',
                status: 'running',
                display: { title: 'beta', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolId: 'toolu_2', toolMessageRouteId: 'tool-msg-2', sidechainId: 'toolu_2' },
                recipient: {
                    kind: 'agent_team_member',
                    teamId: 'qa-team',
                    memberId: 'beta@qa-team',
                    memberLabel: 'beta',
                },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
                timestamps: {},
            },
        ];

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    subagents={subagents}
                    activityPreviewById={new Map()}
                    pendingPermissionById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />,
            );
        });

        const text = JSON.stringify(tree!.toJSON());
        expect(text).toContain('qa-team');
        expect(text).toContain('2 agents');
    });

    it('can request launching a teammate for an existing Claude team group', async () => {
        const { SessionSubagentGroup } = await import('./SessionSubagentGroup');
        const launchTeammateSpy = vi.fn();

        const subagents: readonly SessionSubagent[] = [{
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
            transcript: { toolId: 'toolu_1', toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1' },
            recipient: {
                kind: 'agent_team_member',
                teamId: 'qa-team',
                memberId: 'alpha@qa-team',
                memberLabel: 'alpha',
            },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        }];

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentGroup
                    sessionId="s1"
                    label="qa-team"
                    subagents={subagents}
                    activityPreviewById={new Map()}
                    pendingPermissionById={new Map()}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                    onLaunchTeammate={launchTeammateSpy}
                />,
            );
        });

        const [addButton] = tree!.root.findAllByProps({ testID: 'session-subagent-team-add:qa-team' });
        expect(addButton).toBeTruthy();

        await act(async () => {
            await addButton.props.onPress();
        });

        expect(launchTeammateSpy).toHaveBeenCalledWith('qa-team');
    });
});
