import * as React from 'react';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { t } from '@/text';
import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import { SettingsSearchResults, useSettingsSearch } from '@/components/settings/shell/SettingsSearchResults';
import { useSettingsPageSearchQuery } from './SettingsPageSearchContext';

/**
 * Settings search where there is no rail (phones, or the rail turned off): a search field at the top
 * of the Settings page; while it holds a query, the results take the place of the page below it.
 * Same catalog search and result list as the rail.
 */
export const SettingsPageSearch = React.memo(function SettingsPageSearch(props: Readonly<{
    children: React.ReactNode;
}>) {
    const catalog = useResolvedSettingsPageCatalog();
    // The query stays when a result opens, so coming back returns to the results.
    const search = useSettingsSearch(catalog, {
        clearOnOpen: false,
        queryState: useSettingsPageSearchQuery(),
        tag: 'SettingsPageSearch.open',
    });
    return (
        <>
            <CompactSearchField
                testID="settings-page-search"
                placement="page"
                value={search.query}
                onChangeText={search.setQuery}
                placeholder={t('settingsSearch.placeholder')}
            />
            {search.active ? (
                <SettingsSearchResults
                    presentation="page"
                    results={search.results}
                    tree={catalog.tree}
                    testIDPrefix="settings-page-search.result"
                    emptyTestID="settings-page-search.empty"
                    onOpen={search.openRoute}
                />
            ) : props.children}
        </>
    );
});
