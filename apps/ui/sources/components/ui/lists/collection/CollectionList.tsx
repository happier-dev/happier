import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_ROW_STYLE,
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_COLLECTION_LIST_TEXT,
    resolveHappierCollectionListRowPadding,
    HappierCollectionList,
    HappierCollectionListGroupLabel,
    useHappierCollectionDraftRowTitle,
    type HappierCollectionDraftTitleStore,
    type HappierCollectionListHost,
    type HappierCollectionListProps,
} from '@happier-dev/plugin-ui/presentation';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Happier core's binding of the Collection `list` presentation: the app's own text, grouped list
 * surface, compact search field and theme tokens. The anatomy, its geometry and its rules live in
 * `@happier-dev/plugin-ui` (`HappierCollectionList`); this file only supplies host primitives.
 */
/** A list text step in core's own family for its weight. */
function listText(role: keyof typeof HAPPIER_COLLECTION_LIST_TEXT) {
    const step = HAPPIER_COLLECTION_LIST_TEXT[role];
    return {
        ...Typography.default(step.weight),
        fontSize: step.fontSize,
        lineHeight: step.lineHeight,
    };
}

const styles = StyleSheet.create((theme) => ({
    surface: {
        backgroundColor: theme.colors.surface.base,
    },
    // A navigation column beside the page (the app shell's column) lies on the column's plane
    // (`appShellColumnSurface`): the list draws no ground of its own there.
    plane: {
        backgroundColor: 'transparent',
    },
    title: {
        ...listText('title'),
        color: theme.colors.text.primary,
    },
    count: {
        ...listText('count'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    groupTitle: {
        ...listText('groupTitle'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    // A group label inside a page section's sheet: the group's sub-heading, in the text tone.
    groupHeading: {
        ...listText('groupHeading'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    groupCount: {
        ...listText('groupCount'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    dimmedTitle: {
        color: theme.colors.text.secondary,
    },
    // A path under a row's title (the open checkout's folder): mono, at the subtitle's size.
    monoSubtitle: {
        ...Typography.mono(),
    },
    troubleDot: {
        width: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize,
        height: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize,
        borderRadius: HAPPIER_COLLECTION_LIST_METRICS.troubleDotSize / 2,
        backgroundColor: theme.colors.state.warning.foreground,
    },
    // The plane's selected chip: `Item`'s own `surface.selected` is the plane's colour, so an open
    // navigation row lifts to the elevated surface (the plugin realm's `navigationSelected`).
    navigationRowSelected: {
        backgroundColor: theme.colors.surface.elevated,
    },
    // The chip is ~1.06:1 against the plane, below WCAG 1.4.11's 3:1, so the title's weight carries
    // the state as well.
    navigationRowTitleSelected: {
        ...listText('rowTitleSelected'),
    },
}));

const textRoleStyles = {
    title: styles.title,
    count: styles.count,
    groupTitle: styles.groupTitle,
    groupHeading: styles.groupHeading,
    groupCount: styles.groupCount,
} as const;

const collectionListHost: HappierCollectionListHost = {
    Text: (props) => (
        <Text
            style={textRoleStyles[props.role]}
            {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
            {...(props.accessibilityRole === undefined ? {} : { accessibilityRole: props.accessibilityRole })}
        >
            {props.children}
        </Text>
    ),
    Scroller: (props) => <ItemList presentation="grouped" style={props.style as StyleProp<ViewStyle>}>{props.children}</ItemList>,
    SearchField: (props) => (
        <CompactSearchField
            value={props.value}
            onChangeText={props.onChangeText}
            placeholder={props.placeholder}
            style={props.style as StyleProp<ViewStyle>}
            {...(props.testID === undefined ? {} : { testID: props.testID })}
        />
    ),
    surfaceStyle: styles.surface,
};

const collectionListPlaneHost: HappierCollectionListHost = { ...collectionListHost, surfaceStyle: styles.plane };

/**
 * The list pane of a list + detail collection. Rows are compact `Item`s with `collectionListStyles.row`.
 * `surface="plane"` is the list as a navigation column on the shell's plane; its rows are
 * {@link CollectionNavigationRow}s (the plane's selected chip).
 */
export const CollectionList = React.memo(function CollectionList(props: Omit<HappierCollectionListProps, 'host'> & Readonly<{
    surface?: 'page' | 'plane';
}>) {
    const { surface, ...listProps } = props;
    return <HappierCollectionList host={surface === 'plane' ? collectionListPlaneHost : collectionListHost} {...listProps} />;
});

/** A group heading inside a collection list: what the rows share, and how many there are. */
export function CollectionListGroupLabel(props: Readonly<{
    title: string;
    count?: number;
    first?: boolean;
    /** A 16px glyph before the title (the event a group of triggers answers). */
    mark?: React.ReactNode;
    /** One small control or state at the label's end (a group's "+"). */
    trailing?: React.ReactNode;
    testID?: string;
}>) {
    const { testID, ...label } = props;
    if (testID === undefined) return <HappierCollectionListGroupLabel host={collectionListHost} {...label} />;
    return <View testID={testID}><HappierCollectionListGroupLabel host={collectionListHost} {...label} /></View>;
}

/**
 * One navigation row in a column (Settings, Plugins, a Home console, settings search results): core's
 * binding of the list anatomy's row — the same gutter, content inset, chip and heavier open title a
 * plugin's `NavigationList.Row` draws through `HappierListItem`. `leftElement` replaces the icon where
 * the row discloses children.
 */
export const CollectionNavigationRow = React.memo(function CollectionNavigationRow(props: Readonly<{
    /** A navigable destination: workspace menu, pointer and drag intent share the workspace owner. */
    href?: string | null;
    testID: string;
    title: string;
    subtitle?: string;
    /** An inline mark before the subtitle: the collection's trouble dot when the row needs the person. */
    subtitleLeading?: React.ReactNode;
    /** A quiet qualifier on the title's line, after the title (a project's Team, a folded machine). */
    titleAccessory?: React.ReactNode;
    /** The subtitle is a path: drawn in the mono face. */
    subtitleMono?: boolean;
    /** A row that is there but not active (an offline machine's last-known checkout, a saved source not open). */
    dimmed?: boolean;
    /** A tree item's semantics and roving focus, from the shared tree interaction owner (a column tree). */
    treeItem?: Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'accessibilityExpanded' | 'pressableRef' | 'onFocus' | 'onKeyDown'>;
    icon?: React.ReactNode;
    leftElement?: React.ReactNode;
    leftElementWhenHovered?: React.ReactNode;
    /** A quiet value at the row's end (a count). */
    detail?: string;
    selected: boolean;
    /** A disclosed level's indent, added to the content inset. */
    indentPx?: number;
    accessibilityLabel?: string;
    /** The row's own menu, at its end, outside the row's press (a project's rename, pin, remove). */
    rightElement?: React.ReactNode;
    onPress: () => void;
}>) {
    const row = (
        <Item
            testID={props.testID}
            {...(props.rightElement ? { rightElement: props.rightElement, rightElementOutsidePressable: true } : {})}
            title={props.title}
            subtitle={props.subtitle}
            subtitleLeading={props.subtitleLeading}
            titleAccessory={props.titleAccessory}
            {...props.treeItem}
            subtitleStyle={props.subtitleMono ? styles.monoSubtitle : undefined}
            {...(props.leftElement
                ? { leftElement: props.leftElement, leftElementWhenHovered: props.leftElementWhenHovered }
                : { icon: props.icon })}
            accessibilityLabel={props.accessibilityLabel}
            detail={props.detail}
            density="compact"
            selected={props.selected}
            showChevron={false}
            pressableStyle={props.selected ? [HAPPIER_COLLECTION_LIST_ROW_STYLE, styles.navigationRowSelected] : HAPPIER_COLLECTION_LIST_ROW_STYLE}
            titleStyle={props.selected ? styles.navigationRowTitleSelected : props.dimmed ? styles.dimmedTitle : undefined}
            style={resolveHappierCollectionListRowPadding(props.indentPx ?? 0)}
            onPress={props.onPress}
        />
    );
    return props.href ? <WorkspaceDestinationRow href={props.href}>{row}</WorkspaceDestinationRow> : row;
});

/** Host styles for rows inside a collection list. */
export const collectionListStyles = {
    /** A row's pressable: inset from the list's edges, with a soft rounded selection. */
    row: HAPPIER_COLLECTION_LIST_ROW_STYLE,
    dimmedTitle: styles.dimmedTitle,
    /** Only trouble gets a dot (needs sign-in, not running, failed). */
    troubleDot: styles.troubleDot,
} as const;

function keepDraftOpen() {}

/**
 * The item being added, at the top of the list and selected while its editor is open in the detail.
 * It shows the name as it is typed, or the placeholder until then.
 */
export const CollectionDraftRow = React.memo(function CollectionDraftRow(props: Readonly<{
    testID?: string;
    titles: HappierCollectionDraftTitleStore;
    placeholder: string;
    mark: React.ReactNode;
}>) {
    const draft = useHappierCollectionDraftRowTitle(props.titles, props.placeholder);
    return (
        <Item
            testID={props.testID}
            title={draft.title}
            titleStyle={draft.untitled ? styles.dimmedTitle : undefined}
            // Says what the row is: an item being added that is not saved yet.
            subtitle={t('common.draft')}
            icon={props.mark}
            selected
            density="compact"
            showChevron={false}
            pressableStyle={HAPPIER_COLLECTION_LIST_ROW_STYLE}
            // The draft is already the open detail; a press has nothing left to open, but the row stays a
            // row (Item draws the selection only on pressable rows).
            onPress={keepDraftOpen}
        />
    );
});
