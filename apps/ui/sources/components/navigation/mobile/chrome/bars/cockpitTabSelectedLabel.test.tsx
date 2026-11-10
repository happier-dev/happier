import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';

import { CockpitTabBarView } from './CockpitTabBar';
import { detailNavigationTab } from './detailPhoneNavigation';

/**
 * Owner decision 11-06 (phone detail bars): the selected tab always says its name, and a tab's status rides on it as
 * a badge ("Checks · 2 failing"), even when the person keeps tab labels off.
 */
describe('the phone detail bar', () => {
    it('labels the selected tab when labels are off, and carries each tab status as a badge with its full words', async () => {
        const tabs = [
            detailNavigationTab({ id: 'overview', title: 'Overview', icon: 'info', disabledReason: null }),
            detailNavigationTab({ id: 'checks', title: 'Checks', icon: 'check', disabledReason: null, count: '2 failing' }),
        ];
        const screen = await renderScreen(<CockpitTabBarView tabs={tabs} activeSurface="overview" onSurfacePress={() => {}}
            barTestId="bar" tabTestIdPrefix="tab-" layout="fit" bottomInset={0} metrics={resolveTabBarMetrics('regular', false)} />);
        try {
            const text = screen.getTextContent();
            expect(text).toContain('Overview');
            expect(text).not.toContain('Checks');
            expect(screen.findHostByTestId('tab-checks-badge')).not.toBeNull();
            expect(text).toContain('2');
            expect(screen.findHostByTestId('tab-checks')?.props.accessibilityLabel).toBe('Checks, 2 failing');
        } finally { await screen.unmount(); }
    });

    it('keeps the main and Session bars icon-only: their selected tab shows no label while labels are off (R1)', async () => {
        const tabs = [
            { id: 'sessions', label: 'Sessions', icon: 'chats-circle' as const },
            { id: 'projects', label: 'Projects', icon: 'folder' as const },
        ];
        const screen = await renderScreen(<CockpitTabBarView tabs={tabs} activeSurface="sessions" onSurfacePress={() => {}}
            barTestId="bar" tabTestIdPrefix="tab-" layout="fit" bottomInset={0} metrics={resolveTabBarMetrics('regular', false)} />);
        try {
            expect(screen.getTextContent()).not.toContain('Sessions');
            expect(screen.findHostByTestId('tab-sessions')?.props.accessibilityLabel).toBe('Sessions');
        } finally { await screen.unmount(); }
    });
});
