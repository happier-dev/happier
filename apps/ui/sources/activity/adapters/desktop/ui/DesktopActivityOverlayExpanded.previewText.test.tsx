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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('DesktopActivityOverlayExpanded', () => {
    it('renders preview text in expanded desktop overlay rows when enabled', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={{
                    visible: true,
                    isExpanded: true,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [
                            {
                                sessionId: 'session-1',
                                title: 'Primary session',
                                subtitle: 'Agent on machine',
                                statusText: 'Needs attention',
                                previewText: 'Need your approval',
                            },
                        ],
                    },
                    window: {
                        collapsed: { width: 340, height: 72 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Need your approval');
    });

    it('renders the notch-integrated chrome surface when the visual mode is notch integrated', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={{
                    visible: true,
                    isExpanded: true,
                    generatedAt: 1,
                    collapsed: {
                        title: 'Primary session',
                        statusText: 'Needs attention',
                        defaultTarget: 'open-primary-session',
                        sessionCount: 1,
                    },
                    expanded: {
                        title: 'Sessions',
                        rows: [
                            {
                                sessionId: 'session-1',
                                title: 'Primary session',
                                subtitle: 'Agent on machine',
                                statusText: 'Needs attention',
                                previewText: 'Need your approval',
                            },
                        ],
                    },
                    window: {
                        collapsed: { width: 340, height: 72 },
                        expanded: { width: 420, height: 220 },
                    },
                }}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-expanded-notch')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-expanded-action-open-inbox')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-expanded-action-collapse')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('common.close');
        expect(screen.getTextContent()).not.toContain('common.open tabs.inbox');
    });
});
