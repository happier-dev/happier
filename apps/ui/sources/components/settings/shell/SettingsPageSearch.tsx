import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { PaneHeaderScrollScope, PaneHeaderShade } from '@/components/appShell/panes/paneHeaderScroll';
import { t } from '@/text';
import { SettingsQueryResults, useSettingsSearch } from '@/components/settings/shell/SettingsSearchResults';
import { useSettingsPageSearchQuery } from './SettingsPageSearchContext';
import { SettingsPageHeader } from './SettingsPageHeader';
import { CollectionSearchToggle } from '@/components/ui/lists/collection/CollectionList';
import { useMainScreenSearch } from '@/components/navigation/shell/MainScreenHeader';
import { NavigationTitleChromeProvider } from '@/components/ui/layout/navigationTitleChrome';
import { NavigationBackChromeProvider, useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PhonePageBackLine, usePhoneDestinationBack } from '@/components/ui/layout/usePageBackControl';
import { useDeviceType } from '@/utils/platform/responsive';

/**
 * Settings where there is no rail (phones, or the rail turned off): a main screen like the others (owner 11-10). Its
 * own title row, the title on the left and the search magnifier on the right, stands in for the native bar; opening
 * the magnifier puts the search field beneath it, and while the field holds a query the results take the place of the
 * page below. Same catalog search and result list as the rail. A query keeps the field open; closing it clears it.
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
    // The magnifier's open/close rule is the main-screen head's (one owner for every main screen's search).
    const searchPlaceholder = t('settingsSearch.placeholder');
    const field = useMainScreenSearch(React.useMemo(() => ({
        value: search.query, onChangeText: search.setQuery, placeholder: searchPlaceholder, testID: 'settings-page-search',
    }), [search.query, search.setQuery, searchPlaceholder]));
    const phone = useDeviceType() === 'phone';
    const phoneBack = usePhoneDestinationBack('settings:back');
    const inheritedBack = useNavigationBackControl();
    // The title row is fixed above the page body, the bottom of the page's header: the body's scroll shades its lower
    // edge (the pane header's shade), rather than rows sliding under it bare. A live query swaps the body for the
    // windowed results list. The page draws its own title, so no bar above it does.
    return (
        <NavigationTitleChromeProvider showsTitle={false}>
        <PaneHeaderScrollScope>
        <View style={styles.page}>
            <View style={styles.searchBand}>
                <PhonePageBackLine control={null} page />
                <NavigationBackChromeProvider control={phone ? phoneBack : inheritedBack}>
                    <SettingsPageHeader
                        testID="settings-page-header"
                        actionsPlacement="page"
                        actionsLayout="inline"
                        actions={(
                            <CollectionSearchToggle
                                testID="settings-page-search-toggle"
                                open={field.open}
                                onPress={field.toggle}
                                accessibilityLabel={t('settingsSearch.placeholder')}
                            />
                        )}
                    />
                </NavigationBackChromeProvider>
                {field.open ? (
                    <CompactSearchField
                        testID="settings-page-search"
                        placement="page"
                        value={search.query}
                        onChangeText={search.setQuery}
                        placeholder={t('settingsSearch.placeholder')}
                        autoFocus={field.focusOnOpen}
                    />
                ) : null}
                <PaneHeaderShade />
            </View>
            {search.active ? (
                <SettingsQueryResults
                    presentation="page"
                    query={search.normalizedQuery}
                    testIDPrefix="settings-page-search.result"
                    emptyTestID="settings-page-search.empty"
                    onOpen={search.openRoute}
                />
            ) : <ItemList testID="settings-page-body" style={styles.body}>{props.children}</ItemList>}
        </View>
        </PaneHeaderScrollScope>
        </NavigationTitleChromeProvider>
    );
});

const styles = StyleSheet.create({
    page: { flex: 1, minHeight: 0 },
    // The shade hangs below the band, over the body that follows it.
    searchBand: { zIndex: 1 },
    body: { paddingTop: 0 },
});
