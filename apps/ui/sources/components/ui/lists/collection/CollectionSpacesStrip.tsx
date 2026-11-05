import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  CollectionEntityKindV1,
  CollectionSpaceIconV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CollectionSpaceIcon } from './CollectionSpaceIcon';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';

import {
  useCollectionSpaceReorderBinding,
  type CollectionSpaceReorderMutation,
} from './collectionSpaceReorder';

export type CollectionSpacesStripItem = Readonly<{
  id: string;
  name: string;
  icon: CollectionSpaceIconV1;
  /** The platform shortcut for this ordinal ("⌃2"), when one is bound. */
  shortcut?: string;
}>;

/** A space's glyph: its icon token, or the project mark until the project's favicon owner serves spaces. */
export function resolveCollectionSpaceIconName(
  icon: CollectionSpaceIconV1,
): IconName {
  return icon.kind === 'icon'
    ? resolvePluginUiIconName(icon.name)
    : 'folder';
}

const rejectReorder = async () => false;

/** The + hit area stays out of the list title above it (`top: 0`), splits the strip's 2 px gap to the last tab (`leading: 1`) and ends at its drawn edge below (`bottom: 0`: the group label's own controls under the strip already reach up to it). */
const ADD_BUTTON_EDGES_PX = { leading: 1, trailing: 8, top: 0, bottom: 0 } as const;

const stylesheet = StyleSheet.create((theme) => ({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    minHeight: 36,
  },
  tabs: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  },
}));

/**
 * The spaces strip (lab `clspaces`): one glyph per saved space on the ink selection fill, then + New
 * space. The list title names the selected space, so the strip carries no words; each glyph is named
 * (with its shortcut) for hover and assistive technology. Selection, focus and arrow keys are the
 * shared tab bar's; when spaces outgrow the column the strip scrolls sideways, + staying in reach. With a pointer
 * a tab drags sideways to a new place (the shared flat reorder, horizontal); on touch and from the keyboard the
 * same reorder lives in Manage spaces.
 */
export const CollectionSpacesStrip = React.memo(function CollectionSpacesStrip(
  props: Readonly<{
    testIDPrefix: string;
    accessibilityLabel: string;
    items: readonly CollectionSpacesStripItem[];
    selectedId: string;
    onSelect: (spaceId: string) => void;
    addLabel: string;
    onAdd?: () => void;
    /** The list's space writer; dragging a tab submits the same reorder intent as Manage spaces. */
    reorder?: Readonly<{
      entityKind: CollectionEntityKindV1;
      invoke: (mutation: CollectionSpaceReorderMutation) => Promise<boolean>;
    }>;
  }>,
) {
  const styles = stylesheet;
  const { theme } = useUnistyles();
  const iconColor = theme.colors.text.secondary;
  const pointer = useHoverCapablePrimaryPointer();
  const binding = useCollectionSpaceReorderBinding({
    entityKind: props.reorder?.entityKind ?? 'sessionWork',
    spaces: props.items,
    invoke: props.reorder?.invoke ?? rejectReorder,
    enabled: props.reorder !== undefined && pointer && props.items.length > 1,
    axis: 'horizontal',
  });
  // The whole tab is the drag body and the drop place; selection, focus and keys stay the tab bar's.
  const wrapTab = React.useCallback(
    (tabId: string, tab: React.ReactElement) => (
      <EntityFlatReorderRow id={tabId}>{() => tab}</EntityFlatReorderRow>
    ),
    [],
  );
  const tabs = React.useMemo(
    () =>
      props.items.map((item) => ({
        id: item.id,
        label: item.shortcut ? `${item.name} · ${item.shortcut}` : item.name,
        icon: (
          <CollectionSpaceIcon
            icon={item.icon}
            size={ICON_SIZE.sm}
            color={iconColor}
          />
        ),
        testID: `${props.testIDPrefix}:${item.id}`,
      })),
    [iconColor, props.items, props.testIDPrefix],
  );
  return (
    <View testID={props.testIDPrefix} style={styles.strip}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
        <EntityFlatReorderList binding={binding} axis="horizontal" testID={`${props.testIDPrefix}-reorder`}>
        <SegmentedTabBar
          presentation="plain"
          labels="none"
          compact
          segmentSizing="content"
          role="tablist"
          accessibilityLabel={props.accessibilityLabel}
          tabs={tabs}
          activeTabId={props.selectedId}
          wrapTab={wrapTab}
          onSelectTab={props.onSelect}
        />
        </EntityFlatReorderList>
      </ScrollView>
      {props.onAdd ? (
        <IconButton
          testID={`${props.testIDPrefix}-add`}
          accessibilityLabel={props.addLabel}
          tooltip={props.addLabel}
          variant="plain"
          size={28}
          iconSize={ICON_SIZE.xs}
          // The title above reaches the strip's 4 px inset itself; the + takes half the gap to the last tab
          // and the free space beside it.
          interactiveTargetEdgesPx={ADD_BUTTON_EDGES_PX}
          iconName="plus"
          onPress={props.onAdd}
        />
      ) : null}
    </View>
  );
});
