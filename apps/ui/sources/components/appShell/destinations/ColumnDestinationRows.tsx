import * as React from 'react';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useDestinationPathname } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Platform, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import {
    BROWSE_EXISTING_SESSIONS_DESTINATION_ID,
    SEARCH_DESTINATION_ID,
    isCompactAppDestinationVisible,
    isRailControlDestination,
    resolveCurrentAppDestination,
    selectAppDestinationsInPlacement,
    useActivateAppDestination,
    useCompactAppDestinations,
    type ActivateAppDestination,
    type CompactAppDestination,
    type PlaceableAppShellColumnId,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import type { UniversalSearchScopeSeed } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX } from '@/components/ui/lists/itemGroupSpacing';
import { TAB_TYPES } from '@/components/ui/navigation/tabTypes';
import {
    resolveSessionListDensityViewState,
    SESSION_LIST_ROW_SELECTION_RADIUS,
} from '@/components/sessions/shell/resolveSessionListDensityViewState';
import { sessionListStyles } from '@/components/sessions/shell/sessionListStyles';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { useIsTablet } from '@/utils/platform/responsive';

const stylesheet = StyleSheet.create(() => ({
    // Beside the rail the column's own entries keep a small gap under the title strip, on the same
    // plane the column paints (`appShellColumnSurface`), so the column reads as one surface.
    column: {
        // The column's header gap: the first entry stands one rail step under the title row (r2 item 3).
        marginTop: -(Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX) ?? 0) + HAPPIER_COLLECTION_LIST_METRICS.headerGap,
        // The column's own rows are a group: the list's first group label after them keeps its air under the
        // header and gains this, so it stands the same group pause below them as every other group (owner 11-11).
        marginBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingTop - HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop,
    },
}));

const ROW_FILL_SHAPE_STYLE = { borderRadius: SESSION_LIST_ROW_SELECTION_RADIUS } as const;
/** The phone's tab bar reaches these destinations itself, so its shortcuts menu does not repeat them. */
const PHONE_TAB_BAR_DESTINATION_IDS: ReadonlySet<string> = new Set(TAB_TYPES);

function selectPhoneLauncherDestinations(catalog: readonly CompactAppDestination[]): readonly CompactAppDestination[] {
    return catalog.filter((destination) => isCompactAppDestinationVisible(destination)
        && !isRailControlDestination(destination)
        && !PHONE_TAB_BAR_DESTINATION_IDS.has(destination.id));
}

const NO_LEADING_ROWS: readonly ColumnLeadingRow[] = Object.freeze([]);

/**
 * The destinations listed in one column (or, without `column`, the phone's shortcuts menu), the one
 * that is open, and the one way to open them. Every column draws these rows from here; a column only
 * chooses its row anatomy.
 */

export function useColumnDestinations(column: PlaceableAppShellColumnId | undefined): Readonly<{
    destinations: readonly CompactAppDestination[];
    currentId: string | null;
    activate: ActivateAppDestination;
}> {
    const activate = useActivateAppDestination();
    return { ...useColumnDestinationEntries(column), activate };
}

/**
 * The column's placed destinations and which one is current, without the activation owner: a memoized column body
 * reads these and takes `activate` from its route-reading parent, so route publications do not redraw its rows.
 */
export function useColumnDestinationEntries(column: PlaceableAppShellColumnId | undefined): Readonly<{
    destinations: readonly CompactAppDestination[];
    currentId: string | null;
}> {
    const pathname = useDestinationPathname();
    const catalog = useCompactAppDestinations();
    const destinations = React.useMemo(
        () => (column === undefined
            ? selectPhoneLauncherDestinations(catalog)
            : selectAppDestinationsInPlacement(catalog, { kind: 'column', column })),
        [catalog, column],
    );
    const currentId = React.useMemo(
        () => resolveCurrentAppDestination(catalog, pathname)?.id ?? null,
        [catalog, pathname],
    );
    return { destinations, currentId };
}

export function destinationRowTestId(destination: CompactAppDestination): string {
    // Stable selectors the end-to-end suites already use for these two built-ins.
    if (destination.id === SEARCH_DESTINATION_ID) return 'sessions-search-all-button';
    if (destination.id === BROWSE_EXISTING_SESSIONS_DESTINATION_ID) return 'external-sessions-browse-button';
    return `compact-app-destination:${destination.id}`;
}

/**
 * A row the column shows before its destinations with the same anatomy (a board pinned in the
 * Sessions column, INT §5.1). The column's owner supplies it; selection and press stay with it.
 */
export type ColumnLeadingRow = Readonly<{
    id: string;
    href?: string;
    testID: string;
    title: string;
    icon: IconName;
    /** A quiet live value at the row's end (a pinned board's needs-you count). */
    rightElement?: React.ReactNode;
    selected: boolean;
    onPress: () => void;
}>;

/**
 * The destinations a column lists under its header (user ruling U1: "Browse external sessions" in the
 * Sessions column, a plugin page placed in any column). Rows, selection and activation come from the one
 * catalog; the column decides only where they stand. The phone reaches the same catalog through its
 * shortcuts menu (`PhoneDestinationsMenu`).
 */
export const ColumnDestinationRows = React.memo(function ColumnDestinationRows(props: Readonly<{
    /** The column whose entries these are. */
    column: PlaceableAppShellColumnId;
    universalSearchScope?: UniversalSearchScopeSeed;
    leadingRows?: readonly ColumnLeadingRow[];
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // These rows are the first entries of the column's list, not a separate control strip, so they
    // take the session row's height from the same owner the session list reads, on every platform.
    // A finger reaches past the row through the shared hit area; the row itself stays at the design.
    const sessionListDensity = useSetting('sessionListDensity');
    const uiFontScale = useLocalSetting('uiFontScale');
    const isTablet = useIsTablet();
    const { width: windowWidth } = useWindowDimensions();
    const densityRowHeight = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
        windowWidth,
        uiFontScale,
    }).rowHeight;
    const rowHeight = densityRowHeight;
    const rowHeightStyle = React.useMemo(
        () => ({ height: rowHeight, minHeight: rowHeight }),
        [rowHeight],
    );
    const { destinations, currentId, activate } = useColumnDestinations(props.column);
    const leadingRows = props.leadingRows ?? NO_LEADING_ROWS;
    if (destinations.length === 0 && leadingRows.length === 0) return null;

    return (
        <ItemGroup
            style={styles.column}
            // Columns keep their own plane.
            surface="none"
            constrainToContentWidth={false}
            // The column's sheet edge (the shared column frame), where the session sheets start.
            containerStyle={sessionListStyles.groupSheetInset}
        >
            {leadingRows.map((row) => (
                <WorkspaceDestinationRow key={row.id} href={row.href ?? null}><Item
                    testID={row.testID}
                    title={row.title}
                    icon={<Icon name={row.icon} color={theme.colors.text.secondary} />}
                    rightElement={row.rightElement}
                    density="tight"
                    showChevron={false}
                    showDivider={false}
                    style={rowHeightStyle}
                    pressableStyle={ROW_FILL_SHAPE_STYLE}
                    selected={row.selected}
                    onPress={row.onPress}
                /></WorkspaceDestinationRow>
            ))}
            {destinations.map((destination) => (
                <WorkspaceDestinationRow key={destination.id}
                    href={destination.activation === 'navigate' && destination.availability === 'available' ? destination.routePath : null}><Item
                    testID={destinationRowTestId(destination)}
                    title={destination.title}
                    subtitle={destination.kind === 'plugin' && destination.availability === 'unavailable'
                        ? resolveReasonCopy({
                            reasonCode: destination.unavailableReason,
                            kind: 'pluginRuntime',
                        }).message
                        : undefined}
                    // `icon`, not `leftElement`: only `icon` is resized to the density's glyph scale.
                    icon={<Icon name={destination.icon} color={theme.colors.text.secondary} />}
                    rightElement={destination.kind === 'plugin' && destination.badge ? (
                        <CompactAppDestinationBadge destination={destination} />
                    ) : undefined}
                    density="tight"
                    showChevron={false}
                    showDivider={false}
                    // `style` lands last on the row CONTAINER, so it beats the density minimum and
                    // the Pressable hugs it exactly; `pressableStyle` would leave dead space.
                    style={rowHeightStyle}
                    pressableStyle={ROW_FILL_SHAPE_STYLE}
                    disabled={destination.availability !== 'available'}
                    selected={destination.id === currentId}
                    onPress={destination.availability === 'available'
                        ? () => activate(destination, { searchScope: props.universalSearchScope })
                        : undefined}
                /></WorkspaceDestinationRow>
            ))}
        </ItemGroup>
    );
});
