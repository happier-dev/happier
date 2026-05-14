import { afterEach, describe, expect, it, vi } from 'vitest';

import { setPreferredLanguageFromSettings, t } from '@/text';

import { resolveProjectGroupHeaderMenuItems } from './resolveProjectGroupHeaderMenuItems';
import { resolveSessionsListHeaderMenuItems } from './resolveSessionsListHeaderMenuItems';
import { resolveSessionViewHeaderActionItems } from './view/resolveSessionViewHeaderActionItems';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/icons/DependabotIcon', () => ({
    DependabotIcon: 'DependabotIcon',
}));

describe('session header menu item translation caching', () => {
    afterEach(() => {
        setPreferredLanguageFromSettings(null);
    });

    it('refreshes sessions list header labels after the preferred language changes', () => {
        setPreferredLanguageFromSettings('en');
        const englishCustomTitle = t('settingsSession.sessionList.orderingOptions.custom');
        const englishSortByTitle = t('settingsSession.sessionList.menuSections.sortBy');
        const english = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            actionIconColor: '#000',
        });

        setPreferredLanguageFromSettings('es');
        const spanishCustomTitle = t('settingsSession.sessionList.orderingOptions.custom');
        const spanishSortByTitle = t('settingsSession.sessionList.menuSections.sortBy');
        const spanish = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            actionIconColor: '#000',
        });

        expect(english.find((item) => item.id === 'custom')?.title).toBe(englishCustomTitle);
        expect(english.find((item) => item.id === 'custom')?.category).toBe(englishSortByTitle);
        expect(spanish.find((item) => item.id === 'custom')?.title).toBe(spanishCustomTitle);
        expect(spanish.find((item) => item.id === 'custom')?.category).toBe(spanishSortByTitle);
        expect(spanish.find((item) => item.id === 'custom')?.title).not.toBe(englishCustomTitle);
        expect(spanish.find((item) => item.id === 'custom')?.category).not.toBe(englishSortByTitle);
    });

    it('refreshes project group header labels after the preferred language changes', () => {
        setPreferredLanguageFromSettings('en');
        const englishOpenProjectTitle = t('sessionsList.openProject');
        const english = resolveProjectGroupHeaderMenuItems({
            menuEnabled: true,
            canOpenProject: true,
            canAddFolder: false,
            hasCustomLabel: true,
            actionIconColor: '#000',
        });

        setPreferredLanguageFromSettings('es');
        const spanishOpenProjectTitle = t('sessionsList.openProject');
        const spanish = resolveProjectGroupHeaderMenuItems({
            menuEnabled: true,
            canOpenProject: true,
            canAddFolder: false,
            hasCustomLabel: true,
            actionIconColor: '#000',
        });

        expect(english.find((item) => item.id === 'openProject')?.title).toBe(englishOpenProjectTitle);
        expect(spanish.find((item) => item.id === 'openProject')?.title).toBe(spanishOpenProjectTitle);
        expect(spanish.find((item) => item.id === 'openProject')?.title).not.toBe(englishOpenProjectTitle);
    });

    it('refreshes session view header action labels after the preferred language changes', () => {
        setPreferredLanguageFromSettings('en');
        const englishOpenRunsTitle = t('session.openRuns');
        const english = resolveSessionViewHeaderActionItems({
            shouldFoldHeaderIconActions: true,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            sessionExecutionRunsSupported: true,
            showAutomations: false,
            actionIconColor: '#000',
        });

        setPreferredLanguageFromSettings('es');
        const spanishOpenRunsTitle = t('session.openRuns');
        const spanish = resolveSessionViewHeaderActionItems({
            shouldFoldHeaderIconActions: true,
            shouldShowSubagentsButton: false,
            subagentActiveCount: 0,
            sessionExecutionRunsSupported: true,
            showAutomations: false,
            actionIconColor: '#000',
        });

        expect(english.find((item) => item.id === 'header.openRuns')?.title).toBe(englishOpenRunsTitle);
        expect(spanish.find((item) => item.id === 'header.openRuns')?.title).toBe(spanishOpenRunsTitle);
        expect(spanish.find((item) => item.id === 'header.openRuns')?.title).not.toBe(englishOpenRunsTitle);
    });
});
