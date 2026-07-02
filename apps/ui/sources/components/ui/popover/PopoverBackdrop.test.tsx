import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (value: any) => value.ios ?? value.native ?? value.default ?? null,
        },
        Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, props.children),
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('PopoverBackdrop', () => {
    it('can intercept only the area above the anchor so lower controls remain tappable', async () => {
        const { PopoverBackdrop } = await import('./backdrop');
        const onRequestClose = vi.fn();

        const screen = await renderScreen(
            <PopoverBackdrop
                backdrop={{ enabled: true }}
                backdropBlocksOutsidePointerEvents
                backdropOutsidePointerEventsMode="above-anchor"
                backdropEffect="none"
                backdropBlurOnWeb={undefined}
                backdropSpotlight={false}
                backdropAnchorOverlay={undefined}
                backdropStyle={undefined}
                closeOnBackdropPan={false}
                onRequestClose={onRequestClose}
                shouldPortal
                shouldPortalWeb={false}
                portal={{ native: true }}
                portalOpacity={1}
                portalPositionOnWeb="absolute"
                fixedPositionOnWeb="absolute"
                portalZ={1000}
                anchorRect={{ x: 20, y: 560, width: 120, height: 40 }}
                windowWidth={390}
                windowHeight={844}
                webPortalOffsetX={0}
                webPortalOffsetY={0}
            />,
        );

        const pressable = screen.tree.root.findByType('Pressable' as never);
        const style = flattenStyle(pressable.props.style);

        expect(style.top).toBe(0);
        expect(style.bottom).toBe(284);
        expect(pressable.props.onPress).toBe(onRequestClose);
    });
});
