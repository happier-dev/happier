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
            sectionMode: 'activity',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            showFolderViewMode: true,
            folderViewMode: 'tree',
            folderSortMode: 'foldersFirst',
            showStorageFilter: true,
            storageFilter: 'all',
            actionIconColor: '#000',
        });

        setPreferredLanguageFromSettings('es');
        const spanishCustomTitle = t('settingsSession.sessionList.orderingOptions.custom');
        const spanishSortByTitle = t('settingsSession.sessionList.menuSections.sortBy');
        const spanish = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            sectionMode: 'activity',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            showFolderViewMode: true,
            folderViewMode: 'tree',
            folderSortMode: 'foldersFirst',
            showStorageFilter: true,
            storageFilter: 'all',
            actionIconColor: '#000',
        });

        expect(english.find((item) => item.id === 'custom')?.title).toBe(englishCustomTitle);
        expect(english.find((item) => item.id === 'custom')?.category).toBe(englishSortByTitle);
        expect(spanish.find((item) => item.id === 'custom')?.title).toBe(spanishCustomTitle);
        expect(spanish.find((item) => item.id === 'custom')?.category).toBe(spanishSortByTitle);
        expect(spanish.find((item) => item.id === 'custom')?.title).not.toBe(englishCustomTitle);
        expect(spanish.find((item) => item.id === 'custom')?.category).not.toBe(englishSortByTitle);
    });

    it('exposes stable session ordering mode selectors', () => {
        const items = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            sectionMode: 'activity',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            showFolderViewMode: true,
            folderViewMode: 'tree',
            folderSortMode: 'foldersFirst',
            showStorageFilter: true,
            storageFilter: 'all',
            actionIconColor: '#000',
        });

        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'custom', testID: 'session-list-ordering-mode-custom' }),
            expect.objectContaining({ id: 'created', testID: 'session-list-ordering-mode-created' }),
            expect.objectContaining({ id: 'updated', testID: 'session-list-ordering-mode-updated' }),
        ]));
    });

    it('exposes stable folder sort selectors', () => {
        const items = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            sectionMode: 'activity',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            showFolderViewMode: true,
            folderViewMode: 'tree',
            folderSortMode: 'foldersFirst',
            showStorageFilter: true,
            storageFilter: 'all',
            actionIconColor: '#000',
        });

        expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'sessionListFolderSortModeFoldersFirst',
                testID: 'session-folder-sort-mode-folders-first',
            }),
            expect.objectContaining({
                id: 'sessionListFolderSortModeMixed',
                testID: 'session-folder-sort-mode-mixed',
            }),
        ]));
    });

    it('exposes the unified All, Happier, and External filter in one category', () => {
        setPreferredLanguageFromSettings('en');
        const items = resolveSessionsListHeaderMenuItems({
            orderingMode: 'custom',
            sectionMode: 'activity',
            activeGrouping: 'project',
            inactiveGrouping: 'date',
            isHideInactiveSessionsEnabled: false,
            showFolderViewMode: true,
            folderViewMode: 'tree',
            folderSortMode: 'foldersFirst',
            showStorageFilter: true,
            storageFilter: 'direct',
            actionIconColor: '#000',
        });
        const filters = items.filter((item) => item.id.startsWith('sessionListStorageFilter'));

        expect(filters.map((item) => item.id)).toEqual([
            'sessionListStorageFilterAll',
            'sessionListStorageFilterPersisted',
            'sessionListStorageFilterDirect',
        ]);
        expect(filters.map((item) => item.title)).toEqual(['All', 'Happier', 'External']);
        expect(new Set(filters.map((item) => item.category))).toHaveLength(1);
        expect(filters.find((item) => item.id === 'sessionListStorageFilterDirect')?.rightElement).toBeTruthy();
        expect(filters.find((item) => item.id === 'sessionListStorageFilterAll')?.rightElement).toBeUndefined();
    });

    it('refreshes project group header labels after the preferred language changes', () => {
        setPreferredLanguageFromSettings('en');
        const englishAddFolderTitle = t('sessionsList.addFolder');
        const english = resolveProjectGroupHeaderMenuItems({
            menuEnabled: true,
            canOpenProject: false,
            canAddFolder: true,
            hasCustomLabel: true,
            actionIconColor: '#000',
        });

        setPreferredLanguageFromSettings('es');
        const spanishAddFolderTitle = t('sessionsList.addFolder');
        const spanish = resolveProjectGroupHeaderMenuItems({
            menuEnabled: true,
            canOpenProject: false,
            canAddFolder: true,
            hasCustomLabel: true,
            actionIconColor: '#000',
        });

        expect(english.find((item) => item.id === 'addFolder')?.title).toBe(englishAddFolderTitle);
        expect(spanish.find((item) => item.id === 'addFolder')?.title).toBe(spanishAddFolderTitle);
        expect(spanish.find((item) => item.id === 'addFolder')?.title).not.toBe(englishAddFolderTitle);
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
