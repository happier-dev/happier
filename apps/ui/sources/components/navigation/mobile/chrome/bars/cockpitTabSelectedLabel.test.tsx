import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';

import { CockpitTabBarView } from './CockpitTabBar';
import { detailNavigationTab } from './detailPhoneNavigation';

/**
 * Owner 11-15 (MOBILE-FIX-1115 H1, superseding 11-06's "the selected detail tab names itself"): every floating bar reads
 * the one tab-labels setting. A tab's status still rides on it as a badge, its full words in the accessible name.
 */
describe('the phone detail bar', () => {
    const tabs = [
        detailNavigationTab({ id: 'overview', title: 'Overview', icon: 'info', disabledReason: null }),
        detailNavigationTab({ id: 'checks', title: 'Checks', icon: 'check', disabledReason: null, count: '2 failing' }),
    ];
    const render = (showLabels: boolean) => renderScreen(<CockpitTabBarView tabs={tabs} activeSurface="overview" onSurfacePress={() => {}}
        barTestId="bar" tabTestIdPrefix="tab-" layout="fit" bottomInset={0} metrics={resolveTabBarMetrics('regular', showLabels)} />);

    it('shows no tab name, the selected one included, while labels are off, and carries each status as a badge', async () => {
        const screen = await render(false);
        try {
            const text = screen.getTextContent();
            expect(text).not.toContain('Overview');
            expect(text).not.toContain('Checks');
            expect(screen.findHostByTestId('tab-checks-badge')).not.toBeNull();
            expect(screen.findHostByTestId('tab-overview')?.props.accessibilityLabel).toBe('Overview');
            expect(screen.findHostByTestId('tab-checks')?.props.accessibilityLabel).toBe('Checks, 2 failing');
        } finally { await screen.unmount(); }
    });

    it('names every tab while labels are on', async () => {
        const screen = await render(true);
        try {
            const text = screen.getTextContent();
            expect(text).toContain('Overview');
            expect(text).toContain('Checks');
        } finally { await screen.unmount(); }
    });
});
