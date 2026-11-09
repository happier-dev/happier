import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { t } from '@/text';
import { SettingsQueryResults, useSettingsSearch } from '@/components/settings/shell/SettingsSearchResults';
import { useSettingsPageSearchQuery } from './SettingsPageSearchContext';

/**
 * Settings search where there is no rail (phones, or the rail turned off): a search field at the top
 * of the Settings page; while it holds a query, the results take the place of the page below it.
 * Same catalog search and result list as the rail.
 */
export const SettingsPageSearch = React.memo(function SettingsPageSearch(props: Readonly<{
    children: React.ReactNode;
}>) {
    // The query stays when a result opens, so coming back returns to the results.
    const search = useSettingsSearch({
        clearOnOpen: false,
        queryState: useSettingsPageSearchQuery(),
        tag: 'SettingsPageSearch.open',
    });
    // The header is fixed above the page body; a live query swaps the body for the windowed results list.
    return (
        <View style={styles.page}>
            <CompactSearchField
                testID="settings-page-search"
                placement="page"
                value={search.query}
                onChangeText={search.setQuery}
                placeholder={t('settingsSearch.placeholder')}
            />
            {search.active ? (
                <SettingsQueryResults
                    presentation="page"
                    query={search.normalizedQuery}
                    testIDPrefix="settings-page-search.result"
                    emptyTestID="settings-page-search.empty"
                    onOpen={search.openRoute}
                />
            ) : <ItemList style={styles.body}>{props.children}</ItemList>}
        </View>
    );
});

const styles = StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
    body: { paddingTop: 0 },
});
