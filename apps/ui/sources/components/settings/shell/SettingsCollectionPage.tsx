import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { CollectionPageToolsInsetContext } from '@/components/ui/lists/collection/CollectionList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';

/**
 * A settings collection where no rail shows (phones, lab `sfcols:*P`): the collection's own list under a
 * large title with its quiet count and the page's actions. The list passes its rows as `scrollContent`,
 * so the header, search, view switch and rows scroll as one page.
 */
export const SettingsCollectionPage = React.memo(function SettingsCollectionPage(props: Readonly<{
    testID: string;
    headerTestID: string;
    /** The collection's size beside the title; nothing while it is empty or unknown. */
    count: number | null;
    actions?: React.ReactNode;
    children: React.ReactNode;
}>) {
    return (
        <ItemList testID={props.testID}>
            <SettingsPageHeader
                testID={props.headerTestID}
                alwaysShowTitle
                titleAccessory={props.count !== null && props.count > 0 ? <TitleCount count={props.count} /> : undefined}
                actionsPlacement="page"
                actions={props.actions}
            />
            <CollectionPageToolsInsetContext.Provider value={HAPPIER_PAGE_METRICS.sheetInsetPx}>
                {props.children}
            </CollectionPageToolsInsetContext.Provider>
        </ItemList>
    );
});

/** The page title's count, quiet and tabular like the rail's. */
function TitleCount(props: Readonly<{ count: number }>) {
    const { theme } = useUnistyles();
    return <Text variant="heading" style={{ color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] }}>{String(props.count)}</Text>;
}
