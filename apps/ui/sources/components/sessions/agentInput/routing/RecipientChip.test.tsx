import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedSimpleOptionsPopoverProps: any = null;

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (options: any) => (options && typeof options === 'object' ? options.web ?? options.default : undefined),
    },
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            if (typeof styles === 'function') {
                return styles({
                    colors: {
                        text: '#f4f4f4',
                        textSecondary: '#9ca3af',
                        accent: {
                            blue: '#3b82f6',
                            green: '#22c55e',
                            orange: '#f97316',
                            yellow: '#facc15',
                            red: '#ef4444',
                            indigo: '#6366f1',
                            purple: '#a855f7',
                        },
                    },
                });
            }
            return styles;
        },
        absoluteFillObject: {},
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#000000',
                textSecondary: '#49454F',
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
        if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;
        if (vars && typeof vars.teamId === 'string') return `${key}:${vars.teamId}`;
        if (vars && typeof vars.runId === 'string') return `${key}:${vars.runId}`;
        return key;
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover', () => ({
    AgentInputSimpleOptionsPopover: (props: any) => {
        capturedSimpleOptionsPopoverProps = props;
        return null;
    },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, props.children),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

describe('RecipientChip', () => {
    it('does not render when there are no non-lead targets', async () => {
        capturedSimpleOptionsPopoverProps = null;
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <RecipientChip ctx={ctx} targets={[]} recipient={null} onRecipientChange={() => {}} />,
            );
        });

        expect(tree!.toJSON()).toBeNull();
        expect(capturedSimpleOptionsPopoverProps).toBeNull();
    });

    it('can transition from no targets to targets without a hooks-order crash', async () => {
        capturedSimpleOptionsPopoverProps = null;
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <RecipientChip ctx={ctx} targets={[]} recipient={null} onRecipientChange={() => {}} />,
            );
        });

        expect(() => {
            act(() => {
                tree!.update(
                    <RecipientChip
                        ctx={ctx}
                        targets={[
                            {
                                key: 'agent_team_broadcast:team_1',
                                displayLabel: 'team_1',
                                recipient: { kind: 'agent_team_broadcast', teamId: 'team_1' },
                            },
                        ]}
                        recipient={null}
                        onRecipientChange={() => {}}
                    />,
                );
            });
        }).not.toThrow();
    });

    it('uses the shared simple options popover with lead and participant options', async () => {
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <RecipientChip
                    ctx={ctx}
                    targets={[
                        {
                            key: 'agent_team_broadcast:team_1',
                            displayLabel: 'team_1',
                            recipient: { kind: 'agent_team_broadcast', teamId: 'team_1' },
                        },
                    ]}
                    recipient={null}
                    onRecipientChange={() => {}}
                />,
            );
        });

        expect(tree!.toJSON()).not.toBeNull();
        expect(capturedSimpleOptionsPopoverProps).toEqual(expect.objectContaining({
            title: 'session.participants.sendToTitle',
            selectedOptionId: 'lead',
        }));
        expect(capturedSimpleOptionsPopoverProps?.options).toEqual([
            { id: 'lead', label: 'session.participants.lead' },
            { id: 'agent_team_broadcast:team_1', label: 'session.participants.broadcast:team_1' },
        ]);
    });

    it('routes simple-options selections back through onRecipientChange', async () => {
        const { RecipientChip } = await import('./RecipientChip');
        const onRecipientChange = vi.fn();
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        act(() => {
            renderer.create(
                <RecipientChip
                    ctx={ctx}
                    targets={[
                        {
                            key: 'agent_team_member:team_1:alpha',
                            displayLabel: 'alpha',
                            recipient: { kind: 'agent_team_member', teamId: 'team_1', memberId: 'alpha' },
                        },
                    ]}
                    recipient={null}
                    onRecipientChange={onRecipientChange}
                />,
            );
        });

        act(() => {
            capturedSimpleOptionsPopoverProps.onSelect('agent_team_member:team_1:alpha');
        });
        expect(onRecipientChange).toHaveBeenCalledWith({
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'alpha',
        });
    });
});
