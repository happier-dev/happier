import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedSelectionListPopoverProps: any = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: any) => (options && typeof options === 'object' ? options.web ?? options.default : undefined),
        },
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000000',
                textSecondary: '#49454F',
            },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, vars?: Record<string, unknown>) => {
        if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;
        if (vars && typeof vars.teamId === 'string') return `${key}:${vars.teamId}`;
        if (vars && typeof vars.runId === 'string') return `${key}:${vars.runId}`;
        return key;
    } });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: any) => {
        capturedSelectionListPopoverProps = props;
        return null;
    },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement('Popover', props, props.children),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

describe('RecipientChip', () => {
    it('does not render when there are no non-lead targets', async () => {
        capturedSelectionListPopoverProps = null;
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<RecipientChip ctx={ctx} targets={[]} recipient={null} onRecipientChange={() => {}} />)).tree;

        expect(tree!.toJSON()).toBeNull();
        expect(capturedSelectionListPopoverProps).toBeNull();
    });

    it('can transition from no targets to targets without a hooks-order crash', async () => {
        capturedSelectionListPopoverProps = null;
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<RecipientChip ctx={ctx} targets={[]} recipient={null} onRecipientChange={() => {}} />)).tree;

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

    it('uses the shared SelectionList popover with lead and participant options', async () => {
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<RecipientChip
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
                />)).tree;

        expect(tree!.toJSON()).not.toBeNull();
        expect(capturedSelectionListPopoverProps).toEqual(expect.objectContaining({
            selectedOptionId: 'lead',
        }));
        expect(capturedSelectionListPopoverProps?.rootStep?.title).toBe('session.participants.sendToTitle');
        expect(capturedSelectionListPopoverProps?.rootStep?.sections?.[0]?.options).toEqual([
            expect.objectContaining({ id: 'lead', label: 'session.participants.lead' }),
            expect.objectContaining({ id: 'agent_team_broadcast:team_1', label: 'session.participants.broadcast:team_1' }),
        ]);
    });

    /**
     * FR4-W1-CHIP: the wrapper `AgentInputSelectionListPopover` is the SINGLE
     * close-after-select owner. The inline chip's wrapper-level `onSelect`
     * must NOT close the popover synchronously — closing synchronously on
     * web lets the click event fall through to the underlying chip anchor
     * and re-open the popover after the portaled popover unmounts. The chip
     * passes a no-op `onSelect` and relies on the wrapper to defer
     * `onRequestClose`, which is wired to `setOpen(false)` (single close path).
     *
     * Behavioral assertion: open the popover via the trigger, capture the
     * `open: true` snapshot, then invoke the wrapper-level `onSelect`. The
     * popover MUST still be open afterward because the wrapper-level
     * `onSelect` is a no-op. Closing happens only via `onRequestClose`.
     */
    it('wrapper-level onSelect does NOT close the popover synchronously (close happens only via onRequestClose)', async () => {
        capturedSelectionListPopoverProps = null;
        const { RecipientChip } = await import('./RecipientChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        const screen = await renderScreen(<RecipientChip
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
                />);

        // Open the popover via its trigger.
        await screen.pressByTestIdAsync('agent-input-recipient-chip');
        expect(capturedSelectionListPopoverProps?.open).toBe(true);

        const wrapperOnSelect = capturedSelectionListPopoverProps.onSelect as (id: string) => void;
        expect(typeof wrapperOnSelect).toBe('function');

        // Invoke the wrapper-level onSelect. The chip MUST NOT close itself sync.
        act(() => {
            wrapperOnSelect('agent_team_broadcast:team_1');
        });

        // Popover should still be open — the wrapper owns the close path,
        // not the chip.
        expect(capturedSelectionListPopoverProps?.open).toBe(true);

        // Now invoke onRequestClose; THIS is the canonical close path.
        act(() => {
            (capturedSelectionListPopoverProps.onRequestClose as () => void)();
        });

        expect(capturedSelectionListPopoverProps?.open).toBe(false);
    });

    it('routes SelectionList selections back through onRecipientChange via per-option onSelect (RV-1 F1)', async () => {
        const { RecipientChip } = await import('./RecipientChip');
        const onRecipientChange = vi.fn();
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            popoverAnchorRef: null,
        } as any;

        await renderScreen(<RecipientChip
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
                />);

        // Per-option onSelect (set inside `buildRecipientRootStep`) carries the
        // mutation. The popover-level onSelect is close-only.
        const memberOption = capturedSelectionListPopoverProps.rootStep.sections[0].options.find(
            (option: { id: string }) => option.id === 'agent_team_member:team_1:alpha',
        );
        expect(typeof memberOption?.onSelect).toBe('function');
        act(() => memberOption.onSelect());
        expect(onRecipientChange).toHaveBeenCalledWith({
            kind: 'agent_team_member',
            teamId: 'team_1',
            memberId: 'alpha',
        });
    });
});
