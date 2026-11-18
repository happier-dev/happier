import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { MachineScopeNamedByPageContext } from '@/components/settings/machines/MachineAdministrationTargetSelector';
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
    /**
     * A page scoped to one Machine: its purpose line, naming the chosen Machine ("The coding agents on Studio Mac.").
     * Given, the header's Machine chip reads "Machine", so the title line keeps its room on a phone (owner
     * 2026-11-17, lab phone-system p4-provB).
     */
    machineDescription?: string;
    children: React.ReactNode;
}>) {
    return (
        <ItemList testID={props.testID}>
            <MachineScopeNamedByPageContext.Provider value={props.machineDescription !== undefined}>
                <SettingsPageHeader
                    testID={props.headerTestID}
                    alwaysShowTitle
                    titleAccessory={props.count !== null && props.count > 0 ? <TitleCount count={props.count} /> : undefined}
                    actionsPlacement="page"
                    // The title, the Machine chooser, filters and "+" share one line; a Machine chip reads "Machine" (R8, p4-provB).
                    actionsLayout="shrink"
                    actions={props.actions}
                    description={props.machineDescription}
                />
            </MachineScopeNamedByPageContext.Provider>
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
