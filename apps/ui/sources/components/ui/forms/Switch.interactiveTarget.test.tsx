import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HAPPIER_SWITCH_METRICS } from '@happier-dev/plugin-ui/presentation';
import { resolveHappierMinimumInteractiveTargetSize } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: <T,>(options: { android?: T; default?: T; native?: T; ios?: T; web?: T }) =>
                options.android ?? options.default ?? options.native ?? options.ios ?? options.web,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (typeof style === 'function') {
        return flattenStyle(style({ pressed: false }));
    }
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('Switch interactive target', () => {
    it('lays the web switch out at its drawn track while its hit region keeps the full target', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(
            <Switch value={false} onValueChange={() => {}} testID="web-switch" />,
        );

        const interactionNode = screen.findByTestId('web-switch');
        expect(interactionNode?.props.accessibilityRole).toBe('switch');
        expect(typeof interactionNode?.props.onPress).toBe('function');
        const style = flattenStyle(interactionNode?.props.style);
        const { trackWidth, trackHeight } = HAPPIER_SWITCH_METRICS.default;
        // Layout footprint: exactly the drawn track, so a row never grows around the switch.
        expect(style.width).toBe(trackWidth);
        expect(style.height).toBe(trackHeight);
        // Hit area: the full target, from the shared hit-area owner.
        const area = readHitArea(interactionNode!);
        expect(area.width).toBe(HAPPIER_SWITCH_METRICS.webTargetPx);
        expect(area.height).toBe(HAPPIER_SWITCH_METRICS.webTargetPx);
    });

    it('lets a host keep the switch from reaching into a neighbour that owns the space above it', async () => {
        const { Switch } = await import('./Switch.web');
        const screen = await renderScreen(
            <Switch value={false} onValueChange={() => {}} hitReach={{ top: 0 }} testID="web-switch" />,
        );
        const area = readHitArea(screen.findByTestId('web-switch')!);
        expect(area.insets.top).toBe(0);
        expect(area.insets.bottom).toBe((HAPPIER_SWITCH_METRICS.webTargetPx - HAPPIER_SWITCH_METRICS.default.trackHeight) / 2);
    });

    it('never inflates the native switch interaction nodes to the touch target (their wrapper pressable owns the reach)', async () => {
        const { Switch } = await import('./Switch');
        const screen = await renderScreen(
            <>
                <Switch
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-default"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
                <Switch
                    compact
                    value={false}
                    onValueChange={() => {}}
                    testID="native-switch-compact"
                    style={{ minWidth: 1, minHeight: 1 }}
                />
            </>,
        );
        const minimumTargetSize = resolveHappierMinimumInteractiveTargetSize('android');

        const targetSizes = ['native-switch-default', 'native-switch-compact'].map((testID) => {
            const interactionNode = screen.findByTestId(testID);
            expect(typeof interactionNode?.props.onValueChange).toBe('function');
            const targetStyle = flattenStyle(interactionNode?.props.style);
            return {
                minWidth: targetStyle.minWidth,
                minHeight: targetStyle.minHeight,
            };
        });
        expect(minimumTargetSize).toBe(48);
        // The platform switch keeps the size its caller declared; a target is a hit area, not a drawn size.
        expect(targetSizes).toEqual([
            { minWidth: 1, minHeight: 1 },
            { minWidth: 1, minHeight: 1 },
        ]);
    });
});
