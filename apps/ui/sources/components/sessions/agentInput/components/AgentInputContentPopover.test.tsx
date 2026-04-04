import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const windowWidthState = vi.hoisted(() => ({ value: 480 }));
const capturedSelectionPopoverProps = vi.hoisted(() => ({
    current: null as null | Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (value: any) => value.web ?? value.default ?? null,
        },
        useWindowDimensions: () => ({
            width: windowWidthState.value,
            height: 800,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('@/components/sessions/agentInput/selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: Record<string, unknown> & { children?: (args: { maxHeight: number }) => React.ReactNode }) => {
        capturedSelectionPopoverProps.current = props;
        return React.createElement(React.Fragment, null, props.children?.({ maxHeight: 320 }) ?? null);
    },
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('AgentInputPopoverSurface', props, props.children),
}));

describe('AgentInputContentPopover', () => {
    it('expands the default max width cap to the mobile web viewport width', async () => {
        const { AgentInputContentPopover } = await import('./AgentInputContentPopover');

        await renderScreen(
            <AgentInputContentPopover
                open
                anchorRef={{ current: null } as any}
                content={<React.Fragment />}
                onRequestClose={() => {}}
            />,
        );

        expect(capturedSelectionPopoverProps.current?.maxWidthCap).toBe(456);
        expect(capturedSelectionPopoverProps.current?.portalTopBottomLayout).toBe('boundary');
    });

    it('keeps the configured max width cap on desktop web layouts', async () => {
        windowWidthState.value = 1024;
        const { AgentInputContentPopover } = await import('./AgentInputContentPopover');

        await renderScreen(
            <AgentInputContentPopover
                open
                anchorRef={{ current: null } as any}
                content={<React.Fragment />}
                onRequestClose={() => {}}
            />,
        );

        expect(capturedSelectionPopoverProps.current?.maxWidthCap).toBe(420);
        expect(capturedSelectionPopoverProps.current?.portalTopBottomLayout).toBeUndefined();

        windowWidthState.value = 480;
    });

    it('preserves explicit wider max width caps', async () => {
        const { AgentInputContentPopover } = await import('./AgentInputContentPopover');

        await renderScreen(
            <AgentInputContentPopover
                open
                anchorRef={{ current: null } as any}
                content={<React.Fragment />}
                onRequestClose={() => {}}
                maxWidthCap={620}
            />,
        );

        expect(capturedSelectionPopoverProps.current?.maxWidthCap).toBe(620);
    });
});
