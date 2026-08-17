import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => ({
        tree: [{
            id: 'settings',
            title: 'Settings',
            route: '/settings',
            keywords: [],
            children: [{
                id: 'groupSystem',
                title: 'System',
                keywords: [],
                children: [{
                    id: 'servers',
                    title: 'settings.servers',
                    route: '/settings/servers',
                    keywords: [],
                }, {
                    id: 'desktop',
                    title: 'settingsDesktop.title',
                    route: '/settings/desktop',
                    keywords: [],
                }, {
                    id: 'reportIssue',
                    title: 'settings.reportIssue',
                    route: '/settings/report-issue',
                    keywords: [],
                }],
            }],
        }],
        activePageId: null,
        search: () => [],
    }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, ...props }: { children?: React.ReactNode }) => React.createElement('ItemGroup', props, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

describe('SettingsSystemSection catalog projection', () => {
    it('keeps Report Issue as a catalog page while delegating its external host behavior', async () => {
        const push = vi.fn();
        const handleReportIssue = vi.fn();
        const { SettingsSystemSection } = await import('./SettingsSystemSection');
        const screen = await renderScreen(
            <SettingsSystemSection
                handleReportIssue={handleReportIssue}
                router={{ push } as never}
                theme={{ colors: { text: { secondary: '#777' } } } as never}
            />,
        );

        const reportIssue = screen.findAllByProps({ title: 'settings.reportIssue' })[0];
        reportIssue?.props.onPress();
        expect(handleReportIssue).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();

        const servers = screen.findAllByProps({ title: 'settings.servers' })[0];
        servers?.props.onPress();
        expect(push).toHaveBeenCalledWith('/settings/servers');

        const desktop = screen.findAllByProps({ testID: 'settings-desktop-entry' })[0];
        expect(desktop?.props.title).toBe('settingsDesktop.title');
        desktop?.props.onPress();
        expect(push).toHaveBeenCalledWith('/settings/desktop');
    });
});
