import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let capturedSimpleOptionsPopoverProps: unknown = null;

vi.mock('react-native', () => ({
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
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/text', () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
        if (vars && typeof vars.label === 'string') return `${key}:${vars.label}`;
        return key;
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSimpleOptionsPopover', () => ({
    AgentInputSimpleOptionsPopover: (props: unknown) => {
        capturedSimpleOptionsPopoverProps = props;
        return React.createElement('AgentInputSimpleOptionsPopover', props as any);
    },
}));

function asSimpleOptionsPopoverProps(value: unknown): any {
    return value as any;
}

describe('ExecutionRunDeliveryChip', () => {
    it('does not render when recipient is not an execution_run', async () => {
        capturedSimpleOptionsPopoverProps = null;
        const { ExecutionRunDeliveryChip } = await import('./ExecutionRunDeliveryChip');
        const ctx = {
            chipStyle: () => ({ padding: 4 }),
            iconColor: '#000',
            showLabel: true,
            textStyle: {},
            countTextStyle: {},
            popoverAnchorRef: { current: null },
        } as const;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'agent_team_broadcast', teamId: 'probe' }}
                    delivery="steer_if_supported"
                    onDeliveryChange={() => {}}
                />,
            );
        });

        expect(tree!.toJSON()).toBeNull();
        expect(capturedSimpleOptionsPopoverProps).toBeNull();
    });

    it('opens the shared simple-options popover and anchors it to the delivery chip ref', async () => {
        capturedSimpleOptionsPopoverProps = null;
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

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'execution_run', runId: 'run_1' }}
                    delivery="interrupt"
                    onDeliveryChange={() => {}}
                />,
            );
        });

        expect(asSimpleOptionsPopoverProps(capturedSimpleOptionsPopoverProps)?.open).toBe(false);

        act(() => {
            tree!.root.findByProps({ testID: 'agent-input-delivery-chip' }).props.onPress();
        });

        const pickerProps = asSimpleOptionsPopoverProps(capturedSimpleOptionsPopoverProps);
        expect(pickerProps?.open).toBe(true);
        expect(pickerProps?.title).toBe('runs.delivery.title');
        expect(pickerProps?.selectedOptionId).toBe('interrupt');
        expect(pickerProps?.anchorRef).not.toBe(externalAnchorRef);
        expect((pickerProps?.options ?? []).map((option: { id: string }) => option.id)).toEqual([
            'prompt',
            'steer_if_supported',
            'interrupt',
        ]);
    });

    it('forwards all shared picker selection changes to onDeliveryChange', async () => {
        capturedSimpleOptionsPopoverProps = null;
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

        act(() => {
            renderer.create(
                <ExecutionRunDeliveryChip
                    ctx={ctx}
                    recipient={{ kind: 'execution_run', runId: 'run_1' }}
                    delivery="steer_if_supported"
                    onDeliveryChange={onDeliveryChange}
                />,
            );
        });

        act(() => {
            asSimpleOptionsPopoverProps(capturedSimpleOptionsPopoverProps)?.onSelect('prompt');
        });

        expect(onDeliveryChange).toHaveBeenCalledWith('prompt');
    });
});
