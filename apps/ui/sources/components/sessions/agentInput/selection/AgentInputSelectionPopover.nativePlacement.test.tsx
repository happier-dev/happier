import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

let mockKeyboardHeight = 0;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (value: any) => value.ios ?? value.default ?? null,
        },
    });
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => mockKeyboardHeight,
}));

type CapturedPopoverProps = Record<string, unknown> & { placement?: string };
const capturedPopoverProps: { current: CapturedPopoverProps | null } = { current: null };

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        capturedPopoverProps.current = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: 312 })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, renderedChildren);
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

describe('AgentInputSelectionPopover (native placement)', () => {
    beforeEach(() => {
        mockKeyboardHeight = 0;
        capturedPopoverProps.current = null;
    });

    it('uses placement=top when the keyboard is not visible', async () => {
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.placement).toBe('top');
    });

    it('uses placement=auto when the keyboard is visible', async () => {
        mockKeyboardHeight = 320;
        const { AgentInputSelectionPopover } = await import('./AgentInputSelectionPopover');
        const anchorRef = { current: { nodeType: 'View' } } as any;

        await renderScreen(
            <AgentInputSelectionPopover open anchorRef={anchorRef} onRequestClose={() => {}}>
                {() => <React.Fragment />}
            </AgentInputSelectionPopover>,
        );

        expect(capturedPopoverProps.current?.placement).toBe('auto');
    });
});
