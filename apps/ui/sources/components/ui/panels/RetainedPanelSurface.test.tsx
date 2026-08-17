import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { RetainedPanelSurface } from './RetainedPanelSurface';


declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('RetainedPanelSurface', () => {
    it('keeps an inactive web surface mounted but inert until it becomes active again', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const tracker = createMountTracker();
        try {
            const tree = (await renderScreen(
                <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                    <Tracked tracker={tracker} />
                    <FocusEligibilityProbe />
                </RetainedPanelSurface>,
            )).tree;

            expect(tracker.mounts).toBe(1);
            expect(tree.findByType(FocusEligibilityProbe).props.eligible).toBe(true);

            act(() => {
                tree.update(
                    <RetainedPanelSurface isActive={false} mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
                );
            });

            const inactiveSurface = tree.findByTestId('retained-panel-under-test');
            if (!inactiveSurface) throw new Error('Expected the retained panel surface');
            expect(inactiveSurface.props.pointerEvents).toBe('none');
            expect(inactiveSurface.props.inert).toBe(true);
            expect(inactiveSurface.props['aria-hidden']).toBe(true);
            expect(tracker.unmounts).toBe(0);
            expect(tree.findByType(FocusEligibilityProbe).props.eligible).toBe(false);

            act(() => {
                tree.update(
                    <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
                );
            });

            const activeSurface = tree.findByTestId('retained-panel-under-test');
            if (!activeSurface) throw new Error('Expected the retained panel surface');
            expect(activeSurface.props).toMatchObject({
                pointerEvents: 'auto',
                inert: undefined,
                'aria-hidden': undefined,
            });
            expect(tracker.mounts).toBe(1);
            expect(tracker.unmounts).toBe(0);
            expect(tree.findByType(FocusEligibilityProbe).props.eligible).toBe(true);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('hides inactive native surface descendants from accessibility and pointer interaction', async () => {
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const tracker = createMountTracker();
        try {
            const tree = (await renderScreen(
                <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                    <Tracked tracker={tracker} />
                    <FocusEligibilityProbe />
                </RetainedPanelSurface>,
            )).tree;

            act(() => {
                tree.update(
                    <RetainedPanelSurface isActive={false} mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
                );
            });

            const inactiveSurface = tree.findByTestId('retained-panel-under-test');
            if (!inactiveSurface) throw new Error('Expected the retained panel surface');
            expect(inactiveSurface.props).toMatchObject({
                inert: undefined,
                'aria-hidden': undefined,
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
                pointerEvents: 'none',
            });

            act(() => {
                tree.update(
                    <RetainedPanelSurface isActive mode="absolute-overlay" testID="retained-panel-under-test">
                        <Tracked tracker={tracker} />
                        <FocusEligibilityProbe />
                    </RetainedPanelSurface>,
                );
            });

            const activeSurface = tree.findByTestId('retained-panel-under-test');
            if (!activeSurface) throw new Error('Expected the retained panel surface');
            expect(activeSurface.props).toMatchObject({
                accessibilityElementsHidden: false,
                importantForAccessibility: 'auto',
                pointerEvents: 'auto',
            });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});

type MountTracker = {
    mounts: number;
    unmounts: number;
};

function createMountTracker(): MountTracker {
    return { mounts: 0, unmounts: 0 };
}

function Tracked(props: Readonly<{ tracker: MountTracker }>) {
    React.useEffect(() => {
        props.tracker.mounts += 1;
        return () => {
            props.tracker.unmounts += 1;
        };
    }, [props.tracker]);
    return React.createElement('Tracked');
}

function FocusEligibilityProbe(): React.ReactElement {
    return React.createElement('FocusEligibilityProbe', {
        eligible: usePluginSurfaceFocusEligibility(),
    });
}
