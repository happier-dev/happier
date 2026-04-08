import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
}));

describe('DesktopActivityOverlayCollapsed', () => {
    it('keeps the floating collapsed surface informative and pressable', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');
        const onPress = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={{
                    visible: true,
                    isExpanded: false,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 3,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                    },
                    window: {
                        collapsed: { width: 340, height: 72 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                visualMode="floating_overlay"
                interactive
                dragHandlers={{}}
                onPress={onPress}
            />,
        );

        expect(screen.getTextContent()).toContain('Primary session');
        expect(screen.getTextContent()).toContain('Needs attention');
        expect(screen.getTextContent()).toContain('3');
        expect(screen.findByTestId('desktop-activity-overlay-collapsed-brand-mark')).toBeTruthy();

        screen.pressByTestId('desktop-activity-overlay-collapsed');

        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('keeps the notch-integrated collapsed surface dense while preserving the brand mark and count', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={{
                    visible: true,
                    isExpanded: false,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 3,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                    },
                    window: {
                        collapsed: { width: 240, height: 42 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                visualMode="notch_integrated"
                interactive
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-brand-mark')).toBeTruthy();
        expect(screen.getTextContent()).toContain('3');
        expect(screen.getTextContent()).not.toContain('Primary session');
        expect(screen.getTextContent()).not.toContain('Needs attention');
    });

    it('renders the notch-integrated chrome surface when visual mode is notch integrated', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={{
                    visible: true,
                    isExpanded: false,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 3,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                    },
                    window: {
                        collapsed: { width: 340, height: 72 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                visualMode="notch_integrated"
                interactive
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-notch')).toBeTruthy();
    });

    it('renders the floating chrome surface when visual mode is floating overlay', async () => {
        const { DesktopActivityOverlayCollapsed } = await import('./DesktopActivityOverlayCollapsed');

        const screen = await renderScreen(
            <DesktopActivityOverlayCollapsed
                model={{
                    visible: true,
                    isExpanded: false,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 3,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                    },
                    window: {
                        collapsed: { width: 388, height: 76 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                visualMode="floating_overlay"
                interactive
                dragHandlers={{}}
                onPress={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-collapsed-floating')).toBeTruthy();
    });
});
