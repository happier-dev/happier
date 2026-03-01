import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedPopoverProps: any = null;

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

// Popover uses platform-bound native modules (reanimated) that aren't available in this unit test environment.
// We mock it to assert on the props RecipientChip passes through.
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => {
        capturedPopoverProps = props;
        return null;
    },
}));

// AgentInputPopoverSurface depends on FloatingOverlay, which depends on reanimated. Keep this unit test focused.
vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

describe('RecipientChip', () => {
    it('renders popover via portal so it is not clipped on web', async () => {
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
        expect(capturedPopoverProps?.portal?.web).toBe(true);
    });
});
