import * as React from 'react';
import {
  HAPPIER_COLLECTION_SPACES_STRIP_METRICS,
  HappierCollectionSpacesStrip,
  type HappierCollectionSpacesStripEdgeMask,
  type HappierCollectionSpacesStripTabsInput,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  CollectionEntityKindV1,
  CollectionSpaceIconV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { t } from '@/text';
import { ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import {
  EntityFlatReorderList,
  EntityFlatReorderRow,
} from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHorizontalScrollEdgeMask } from '@/components/ui/scroll/useHorizontalScrollEdgeMask';

import { CollectionSpaceIcon } from './CollectionSpaceIcon';

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

/** A space's glyph name for name-only slots; draw marks with `CollectionSpaceIcon`, which shows a Project space's held favicon. */
export function resolveCollectionSpaceIconName(
  icon: CollectionSpaceIconV1,
): IconName {
  return icon.kind === 'icon'
    ? resolvePluginUiIconName(icon.name)
    : 'folder';
}

const rejectReorder = async () => false;

/** An overflowing strip fades the tabs at the edge that hides more (the composer chip rail's mask), so a cut-off space reads as more, not as the end. */
const STRIP_FADE_PX = HAPPIER_COLLECTION_SPACES_STRIP_METRICS.fadePx;

/** The + hit area stays out of the list title above it (`top: 0`), splits the strip's 2 px gap to the last tab (`leading: 1`) and ends at its drawn edge below (`bottom: 0`: the group label's own controls under the strip already reach up to it). */
const ADD_BUTTON_EDGES_PX = { leading: 1, trailing: 8, top: 0, bottom: 0 } as const;

const stylesheet = StyleSheet.create(() => ({
  tabs: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  },
}));

/** The strip's fades: the mask fades the tabs themselves, so it reads on every surface the strip sits on (column chrome, page, glass). */
export function useCollectionSpacesStripEdgeMask(): HappierCollectionSpacesStripEdgeMask {
  return useHorizontalScrollEdgeMask({ fadePx: STRIP_FADE_PX, style: stylesheet.tabs });
}

/** The host's tab bar on a strip: the sliding ink selection fill, its glyphs named for hover and assistive technology. */
export function renderCollectionSpacesStripTabs(
  input: HappierCollectionSpacesStripTabsInput,
  onTabContextMenu?: React.ComponentProps<typeof SegmentedTabBar>['onTabContextMenu'],
): React.ReactNode {
  return (
    <SegmentedTabBar
      // A reorder moves equal-width tabs without resizing them, so the web reports no new layout and the thumb and
      // reveal would keep the old slots: a new order measures afresh.
      key={input.items.map((item) => item.id).join('\u0000')}
      presentation="plain"
      labels="none"
      compact
      segmentSizing="content"
      role="tablist"
      accessibilityLabel={input.accessibilityLabel}
      tabs={input.items.map((item) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        disabled: item.disabled,
        testID: `${input.testIDPrefix}:${item.id}`,
      }))}
      activeTabId={input.selectedId}
      wrapTab={input.wrapTab}
      onTabLayout={input.onTabLayout}
      onSelectTab={input.onSelect}
      {...(onTabContextMenu ? { onTabContextMenu } : {})}
    />
  );
}

const EDIT_ITEM = 'edit';

/**
 * Core's spaces strip (lab `clspaces`): plugin-ui's strip with one glyph per saved space on the ink selection fill,
 * then + New space. The list title names the selected space, so the strip carries no words. With a pointer a tab
 * drags sideways to a new place (the shared flat reorder, horizontal); on touch and from the keyboard the same
 * reorder lives in Manage spaces.
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
    /** A tab's context menu / long-press (lab `NOTE_SAVE`): Edit opens the list's own space form for that space. */
    onEditSpace?: (spaceId: string) => void;
    /** Wraps one space's tab as something else's drop target (Sessions: a carried Session is added to that space). */
    wrapTabTarget?: (spaceId: string, tab: React.ReactElement) => React.ReactElement;
  }>,
) {
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
  const reorderTestID = `${props.testIDPrefix}-reorder`;
  const wrapList = React.useCallback((tabs: React.ReactNode) => (
    <EntityFlatReorderList binding={binding} axis="horizontal" testID={reorderTestID}>{tabs}</EntityFlatReorderList>
  ), [binding, reorderTestID]);
  // The whole tab is the drag body and the drop place; selection, focus and keys stay the tab bar's.
  const { wrapTabTarget } = props;
  const wrapTab = React.useCallback(
    (tabId: string, tab: React.ReactElement) => (
      <EntityFlatReorderRow id={tabId}>{() => (wrapTabTarget ? wrapTabTarget(tabId, tab) : tab)}</EntityFlatReorderRow>
    ),
    [wrapTabTarget],
  );
  const reducedMotion = useReducedMotionPreference();
  const items = React.useMemo(
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
      })),
    [iconColor, props.items],
  );
  const menuAnchorRef = React.useRef<unknown>(null);
  // The menu may report its choice after it has closed, so the chosen space is kept beside its anchor.
  const menuSpaceRef = React.useRef<string | null>(null);
  const [menuSpaceId, setMenuSpaceId] = React.useState<string | null>(null);
  const { onEditSpace } = props;
  const renderTabs = React.useMemo(() => {
    if (!onEditSpace) return renderCollectionSpacesStripTabs;
    const openMenu = (spaceId: string, anchor: unknown) => {
      menuAnchorRef.current = anchor;
      menuSpaceRef.current = spaceId;
      setMenuSpaceId(spaceId);
    };
    return (input: HappierCollectionSpacesStripTabsInput) => renderCollectionSpacesStripTabs(input, openMenu);
  }, [onEditSpace]);
  const menuItems = React.useMemo(() => [{
    id: EDIT_ITEM,
    testID: `${props.testIDPrefix}-menu-edit`,
    title: t('sessionsList.spacesEdit'),
  }], [props.testIDPrefix]);
  const closeMenu = React.useCallback((open: boolean) => {
    if (!open) setMenuSpaceId(null);
  }, []);
  const selectMenuItem = React.useCallback((itemId: string) => {
    const spaceId = menuSpaceRef.current;
    setMenuSpaceId(null);
    if (itemId === EDIT_ITEM && spaceId !== null) onEditSpace?.(spaceId);
  }, [onEditSpace]);
  return (
    <>
    <HappierCollectionSpacesStrip
      testIDPrefix={props.testIDPrefix}
      accessibilityLabel={props.accessibilityLabel}
      items={items}
      selectedId={props.selectedId}
      onSelect={props.onSelect}
      renderTabs={renderTabs}
      useEdgeMask={useCollectionSpacesStripEdgeMask}
      reducedMotion={reducedMotion}
      wrapList={wrapList}
      wrapTab={wrapTab}
      add={props.onAdd ? (
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
    />
    {onEditSpace ? (
      <ContextMenu
        testID={`${props.testIDPrefix}-menu`}
        anchorRef={menuAnchorRef}
        open={menuSpaceId !== null}
        onOpenChange={closeMenu}
        items={menuItems}
        onSelect={selectMenuItem}
      />
    ) : null}
    </>
  );
});
