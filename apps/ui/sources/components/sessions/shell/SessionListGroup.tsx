import * as React from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  HAPPIER_COLLECTION_LIST_ROW_STYLE,
  HappierItemGroupSelectionContext,
  resolveHappierCollectionListRowPadding,
} from '@happier-dev/plugin-ui/presentation';

import { Item } from '@/components/ui/lists/Item';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { useIsTablet } from '@/utils/platform/responsive';

import {
  resolveSessionListDensityViewState,
  resolveSessionListItemDensity,
  resolveSessionListRowIdentityMetrics,
  resolveSessionListRowTitleTextMetrics,
  type SessionListRowDensity,
} from './resolveSessionListDensityViewState';

/**
 * Whether a group label here opens the column: the first group sits just under the column's header, every
 * later one keeps the full group gap above it (lab `clspace`). The list provides it where its leading content
 * (Scheduled, Drafts, the virtualized groups) decides which group comes first.
 */
export const SessionListFirstGroupContext = React.createContext(false);

/**
 * A titled group of the session list that is not a project group (Drafts, Scheduled): the column's shared
 * group label ("Drafts 3") over flat rows on the plane (lab `clflat`), no sheet. Its rows take
 * {@link SESSION_LIST_GROUP_ROW_PROPS}, the navigation rows' gutter, shape and text edge.
 */
export const SessionListGroup = React.memo(function SessionListGroup(
  props: Readonly<{
    testID: string;
    headerTestID?: string;
    countTestID?: string;
    title: string;
    count: number;
    /** Rows the group counts for selection when its children are not plain items. */
    selectableItemCountOverride?: number;
    children: React.ReactNode;
    /** Below the rows: a group-level state line (a failed read). */
    footer?: React.ReactNode;
    /** The column's first group sits closer to the header. */
    first?: boolean;
  }>,
) {
  const firstGroup = React.useContext(SessionListFirstGroupContext);
  const selection = React.useMemo(() => ({
    selectableItemCount: props.selectableItemCountOverride ?? React.Children.count(props.children),
  }), [props.children, props.selectableItemCountOverride]);
  return (
    <View testID={props.testID} style={stylesheet.section}>
      <View testID={props.headerTestID} accessibilityLabel={`${props.title}, ${props.count}`}>
        <CollectionListGroupLabel
          title={props.title}
          count={props.count > 0 ? props.count : undefined}
          countPlacement="title"
          countTestID={props.countTestID}
          first={props.first ?? firstGroup}
        />
      </View>
      {React.Children.count(props.children) > 0 ? (
        <HappierItemGroupSelectionContext.Provider value={selection}>
          {props.children}
        </HappierItemGroupSelectionContext.Provider>
      ) : null}
      {props.footer}
    </View>
  );
});

/** A flat group row's press shape and text edge: the navigation rows' (`CollectionNavigationRow`). */
export const SESSION_LIST_GROUP_ROW_PROPS: Readonly<{
  pressableStyle: typeof HAPPIER_COLLECTION_LIST_ROW_STYLE;
  style: ReturnType<typeof resolveHappierCollectionListRowPadding>;
}> = Object.freeze({
  pressableStyle: HAPPIER_COLLECTION_LIST_ROW_STYLE,
  style: resolveHappierCollectionListRowPadding(0),
});

/** One geometry for every row of a session-list group's sheet: its rows and its "Show …" row. */
export function resolveSessionListGroupRowGeometry(
  density: SessionListRowDensity,
  window: Readonly<{ isTablet: boolean; windowWidth: number }>,
) {
  const itemDensity = resolveSessionListItemDensity(density);
  const densityViewState = resolveSessionListDensityViewState(
    density === 'minimal' ? 'narrow' : density === 'compact' ? 'cozy' : 'comfortable',
    { isTablet: window.isTablet, platform: Platform.OS, windowWidth: window.windowWidth },
  );
  const readableNativePhoneMinimal = density === 'minimal'
    && densityViewState.rowHeight !== resolveSessionListDensityViewState('narrow').rowHeight;
  const titleTextMetrics = resolveSessionListRowTitleTextMetrics({ density, readableNativePhoneMinimal });
  return { itemDensity, densityViewState, readableNativePhoneMinimal, titleTextMetrics };
}

/**
 * A group's last row when it lists only its first few (Drafts, Scheduled): a full-height row at the
 * list's density, quiet, on the rows' title edge, that reveals the rest.
 */
export const SessionListGroupMoreRow = React.memo(function SessionListGroupMoreRow(props: Readonly<{
  testID: string;
  title: string;
  density: SessionListRowDensity;
  onPress: () => void;
}>) {
  const { theme } = useUnistyles();
  const isTablet = useIsTablet();
  const { width: windowWidth } = useWindowDimensions();
  const { itemDensity, densityViewState, readableNativePhoneMinimal, titleTextMetrics } =
    resolveSessionListGroupRowGeometry(props.density, { isTablet, windowWidth });
  const identityMetrics = resolveSessionListRowIdentityMetrics({ density: props.density, readableNativePhoneMinimal });
  return (
    <Item
      testID={props.testID}
      title={props.title}
      density={itemDensity}
      pressableStyle={SESSION_LIST_GROUP_ROW_PROPS.pressableStyle}
      style={[SESSION_LIST_GROUP_ROW_PROPS.style, { height: densityViewState.rowHeight, minHeight: densityViewState.rowHeight, paddingVertical: 0 }]}
      titleStyle={[titleTextMetrics, { color: theme.colors.text.secondary }]}
      // Minimal rows lead with the agent mark; an empty slot of its size keeps this title on theirs.
      leftElement={props.density === 'minimal' ? (
        <View style={{ width: identityMetrics.slotSize, height: identityMetrics.slotSize }} />
      ) : undefined}
      iconBoxSize={props.density === 'minimal' ? identityMetrics.slotSize : undefined}
      showChevron={false}
      onPress={props.onPress}
    />
  );
});

const stylesheet = StyleSheet.create(() => ({
  // The next group's label brings its own gap above it (the shared list metrics).
  section: { width: '100%' },
}));
