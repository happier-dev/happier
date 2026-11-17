import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Translation and locale subscription stay real; native UI and device storage use the shared boundaries.
installSettingsViewCommonModuleMocks({ storage: 'real', text: () => vi.importActual('@/text') });
const { TeamRow } = await import('./TeamRow');
const { Item } = await import('@/components/ui/lists/Item');
const { preloadTranslations, getPreferredLanguage } = await import('@/text');
const { commitPreferredLanguage } = await import('@/text/preferredLanguage');

afterEach(() => standardCleanup());

describe('TeamRow locale', () => {
    it.each(['page', 'rail'] as const)('translates a retained %s row and accessibility label when a loaded locale becomes active', async variant => {
        await preloadTranslations('en');
        await preloadTranslations('fr');
        const previous = getPreferredLanguage();
        await act(async () => { commitPreferredLanguage('en'); });
        const team = teamSummaryFixture({ id: 'design', name: 'Design', viewerRole: 'member' });
        const row = { address: { serverId: 'home', teamId: team.id }, team, homeName: 'Studio' };
        const onPress = vi.fn();
        const screen = await renderScreen(<TeamRow row={row} showHome variant={variant} onPress={onPress} />);
        const props = () => screen.tree.findByType(Item).props;
        const english = props();
        try {
            await act(async () => { commitPreferredLanguage('fr'); });
            expect(props().subtitle).not.toBe(english.subtitle);
            expect(props().accessibilityLabel).not.toBe(english.accessibilityLabel);
            expect(screen.tree.findByType(TeamRow).props.row).toBe(row);
            await screen.pressByTestIdAsync('teams-row:home:design');
            expect(onPress).toHaveBeenCalledWith(row.address);
        } finally {
            await act(async () => { commitPreferredLanguage(previous); });
        }
    });
});
