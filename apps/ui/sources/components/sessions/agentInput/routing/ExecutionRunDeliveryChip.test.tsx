import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let capturedSelectionListPopoverProps: unknown = null;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                    OS: 'web',
                                    select: (options: unknown) =>
                                            options && typeof options === 'object' ? (options as any).web ?? (options as any).default : undefined,
                                },
                                    useWindowDimensions: () => ({ width: 1024, height: 768 }),
                                    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Pressable', props, props.children),
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string, vars?: Record<string, unknown>) => {
        if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;
        return key;
    } });
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: unknown) => {
        capturedSelectionListPopoverProps = props;
        return React.createElement('AgentInputSelectionListPopover', props as any);
    },
}));

function asSelectionListPopoverProps(value: unknown): any {
    return value as any;
}

describe('ExecutionRunDeliveryChip', () => {
    it('does not render when recipient is not an execution_run', async () => {
        capturedSelectionListPopoverProps = null;
        const { ExecutionRunDeliveryChip } = await import('./ExecutionRunDeliveryChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        } as const;

        const screen = await renderScreen(<ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'agent_team_broadcast', teamId: 'probe' }}
                    delivery="steer_if_supported"
                    onDeliveryChange={() => {}}
                />);

        expect(screen.tree.toJSON()).toBeNull();
        expect(capturedSelectionListPopoverProps).toBeNull();
    });

    it('opens the shared simple-options popover and anchors it to the delivery chip ref', async () => {
        capturedSelectionListPopoverProps = null;
        const { ExecutionRunDeliveryChip } = await import('./ExecutionRunDeliveryChip');
        const externalAnchorRef = { current: { id: 'composer-anchor' } };
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: externalAnchorRef,
        } as const;

        const screen = await renderScreen(<ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'execution_run', runId: 'run_1' }}
                    delivery="interrupt"
                    onDeliveryChange={() => {}}
                />);

        expect(asSelectionListPopoverProps(capturedSelectionListPopoverProps)?.open).toBe(false);

        await screen.pressByTestIdAsync('agent-input-delivery-chip');

        const pickerProps = asSelectionListPopoverProps(capturedSelectionListPopoverProps);
        expect(pickerProps?.open).toBe(true);
        expect(pickerProps?.rootStep?.title).toBe('runs.delivery.title');
        expect(pickerProps?.selectedOptionId).toBe('interrupt');
        expect(pickerProps?.anchorRef).not.toBe(externalAnchorRef);
        expect(((pickerProps?.rootStep?.sections?.[0]?.options) ?? []).map((option: { id: string }) => option.id)).toEqual([
            'prompt',
            'steer_if_supported',
            'interrupt',
        ]);
    });

    /**
     * FR4-W1-CHIP: the wrapper `AgentInputSelectionListPopover` is the SINGLE
     * close-after-select owner. The inline delivery chip's wrapper-level
     * `onSelect` must NOT close the popover synchronously — closing
     * synchronously on web lets the click event fall through to the underlying
     * chip anchor. The chip relies on the wrapper to defer `onRequestClose`,
     * which is wired to `setOpen(false)`.
     */
    it('wrapper-level onSelect does NOT close the popover synchronously (close happens only via onRequestClose)', async () => {
        capturedSelectionListPopoverProps = null;
        const { ExecutionRunDeliveryChip } = await import('./ExecutionRunDeliveryChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        } as const;

        const screen = await renderScreen(<ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'execution_run', runId: 'run_1' }}
                    delivery="steer_if_supported"
                    onDeliveryChange={() => {}}
                />);

        // Open the popover via the trigger.
        await screen.pressByTestIdAsync('agent-input-delivery-chip');
        const openedProps = asSelectionListPopoverProps(capturedSelectionListPopoverProps);
        expect(openedProps?.open).toBe(true);

        const { act } = await import('react-test-renderer');
        const wrapperOnSelect = openedProps.onSelect as (id: string) => void;
        expect(typeof wrapperOnSelect).toBe('function');

        act(() => {
            wrapperOnSelect('prompt');
        });

        // Popover should still be open — the wrapper owns the close path.
        expect(asSelectionListPopoverProps(capturedSelectionListPopoverProps)?.open).toBe(true);

        // onRequestClose is the canonical close path.
        act(() => {
            (asSelectionListPopoverProps(capturedSelectionListPopoverProps).onRequestClose as () => void)();
        });

        expect(asSelectionListPopoverProps(capturedSelectionListPopoverProps)?.open).toBe(false);
    });

    it('forwards all shared picker selection changes to onDeliveryChange via per-option onSelect (RV-1 F1)', async () => {
        capturedSelectionListPopoverProps = null;
        const { ExecutionRunDeliveryChip } = await import('./ExecutionRunDeliveryChip');
        const onDeliveryChange = vi.fn();
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        } as const;

        await renderScreen(<ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'execution_run', runId: 'run_1' }}
                    delivery="steer_if_supported"
                    onDeliveryChange={onDeliveryChange}
                />);

        // Per-option onSelect (set inside `buildExecutionRunDeliveryRootStep`)
        // carries the mutation. The popover-level onSelect is close-only.
        const props = asSelectionListPopoverProps(capturedSelectionListPopoverProps);
        const promptOption = props?.rootStep?.sections?.[0]?.options?.find(
            (option: { id: string }) => option.id === 'prompt',
        );
        expect(typeof promptOption?.onSelect).toBe('function');
        promptOption!.onSelect!();

        expect(onDeliveryChange).toHaveBeenCalledWith('prompt');
    });
});
