import { useCallback, useMemo, type ReactElement, type ReactNode } from 'react';

import {
  HappierCollectionSpacesStrip,
  neighbourHappierCollectionSpaceId,
  type HappierCollectionSpacesStripItem,
  type HappierCollectionSpacesStripTabsInput,
} from '../presentation/collection/CollectionSpacesStrip.js';
import { HappierTabs } from '../presentation/navigation/Tabs.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { IconButton } from './Button.js';
import { useCollectionSavedViewsSelection, type CollectionSavedViewItem, type CollectionSavedViewsSelectionProps } from './CollectionSavedViews.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** A saved view on the strip; give every view an `icon` for the glyph strip, or none for labelled tabs. */
export type CollectionSavedViewStripItem = CollectionSavedViewItem & Readonly<{ icon?: IconName }>;

export type CollectionSavedViewsStripProps<T extends CollectionSavedViewStripItem> = Omit<CollectionSavedViewsSelectionProps<T>, 'labels'> & Readonly<{
  labels: CollectionSavedViewsSelectionProps<T>['labels'] & Readonly<{ add?: string }>;
  /** The add control after the tabs; it needs `labels.add`. */
  onAdd?: () => void;
  /**
   * Dragging a tab with a pointer moves the view before `beforeId` (null: to the end). Resolve true only when the
   * caller's authoritative write accepted it. The caller still owns the order and offers a menu path for touch.
   */
  onReorder?: (id: string, beforeId: string | null) => Promise<boolean>;
  /** The desktop digit shortcuts (⌃1–⌃9 on a Mac) choose the first nine tabs while this surface is presented. */
  shortcuts?: boolean;
  testID?: string;
}>;

function renderPublicTabs(input: HappierCollectionSpacesStripTabsInput, theme: ReturnType<typeof usePluginTheme>): ReactNode {
  return (
    <HappierTabs
      theme={theme}
      testID={input.testIDPrefix}
      strip="page"
      labels="none"
      sharedPanel={null}
      ariaLabel={input.accessibilityLabel}
      value={input.selectedId}
      onValueChange={input.onSelect}
      onTabLayout={input.onTabLayout}
    >
      {input.items.map((item) => <HappierTabsTrigger key={item.id} value={item.id} title={item.label}
        {...(item.icon === undefined ? {} : { icon: item.icon })} {...(item.disabled ? { disabled: true } : {})} />)}
    </HappierTabs>
  );
}

/** `HappierTabs` reads each child's props as its descriptor and never renders the element itself. */
function HappierTabsTrigger(_props: Readonly<{ value: string; title: string; icon?: ReactNode; disabled?: boolean }>): null {
  return null;
}

/**
 * The spaces strip for a saved-view collection, as Happier's own lists draw it: one tab per view (its glyph when
 * every view has one), the add control, drag to reorder with a pointer, digit shortcuts, and a swipe between views on
 * a phone. Same-realm surfaces get the host's own tab bar and gestures; a hosted-web surface draws the public page
 * tabs and keeps selection, keys and add (its realm has no host drag, swipe or shortcut owner to reach).
 * Selection, catalog and persistence stay with the caller, exactly as for the `useCollectionSavedViews*` hooks.
 */
export function CollectionSavedViewsStrip<T extends CollectionSavedViewStripItem>(props: CollectionSavedViewsStripProps<T>): ReactElement {
  const { items, labels, onAdd, onReorder, shortcuts, testID = 'collection-saved-views-strip' } = props;
  const theme = usePluginTheme();
  const host = useOptionalPluginUiPresentationHost()?.collectionSpacesStrip;
  const selection = useCollectionSavedViewsSelection<T>({ ...props, labels: { title: labels.title, ...(labels.unselected === undefined ? {} : { unselected: labels.unselected }) } });
  const selectedTab = selection.radioGroups[0]?.selectedId ?? '';
  const reducedMotion = host?.useReducedMotion?.() ?? false;
  const shortcutLabel = host?.useOrdinalLabel?.();
  // The unselected choice, when there is one, leads the selection owner's items; the views follow in their order.
  const viewOffset = selection.items.length - items.length;
  const stripItems = useMemo(() => selection.items.map((menuItem, index): HappierCollectionSpacesStripItem => {
    const view = items[index - viewOffset];
    const shortcut = index < 9 ? shortcutLabel?.(index + 1) : undefined;
    return {
      id: menuItem.id,
      label: shortcut ? `${menuItem.label} · ${shortcut}` : menuItem.label,
      ...(view?.icon === undefined ? {} : { icon: <Icon name={view.icon} size="small" tone="secondary" /> }),
      ...(menuItem.disabled ? { disabled: true } : {}),
    };
  }), [items, selection.items, shortcutLabel, viewOffset]);
  const renderHostedTabs = useCallback((input: HappierCollectionSpacesStripTabsInput) => renderPublicTabs(input, theme), [theme]);
  const select = selection.selectItem;
  const selectTab = useCallback((id: string) => { select(id); }, [select]);
  const selectOrdinal = useCallback((ordinal: number) => {
    const tab = stripItems[ordinal - 1];
    if (tab === undefined || tab.disabled) return false;
    select(tab.id);
    return true;
  }, [select, stripItems]);
  host?.useOrdinalCommands?.({ enabled: shortcuts === true, selectOrdinal });
  // A view's own id, without the selection owner's prefix; only views move, never the unselected choice.
  const reorderItems = useMemo(() => items.map((item) => ({ id: item.id, name: item.label })), [items]);
  const reorder = host?.useReorder?.({
    testID: `${testID}-reorder`,
    items: reorderItems,
    ...(onReorder === undefined ? {} : { onReorder }),
  });
  const wrapTab = useMemo(() => reorder && (
    (tabId: string, tab: ReactElement) => {
      const view = items[stripItems.findIndex((item) => item.id === tabId) - viewOffset];
      return view === undefined ? tab : reorder.wrapTab(view.id, tab);
    }
  ), [items, reorder, stripItems, viewOffset]);
  const neighbour = (direction: -1 | 1) => neighbourHappierCollectionSpaceId(stripItems, selectedTab, direction);
  const strip = (
    <HappierCollectionSpacesStrip
      testIDPrefix={testID}
      accessibilityLabel={labels.title}
      items={stripItems}
      selectedId={selectedTab}
      onSelect={selectTab}
      renderTabs={host?.renderTabs ?? renderHostedTabs}
      {...(host?.useEdgeMask === undefined ? {} : { useEdgeMask: host.useEdgeMask })}
      reducedMotion={reducedMotion}
      {...(reorder === undefined ? {} : { wrapList: reorder.wrapList })}
      {...(wrapTab === undefined ? {} : { wrapTab })}
      add={onAdd === undefined || labels.add === undefined ? null : (
        <IconButton testID={`${testID}-add`} accessibilityLabel={labels.add} icon={<Icon name="add" size="small" />} onPress={onAdd} />
      )}
    />
  );
  const Swipe = host?.SwipeZone;
  if (Swipe === undefined) return strip;
  return (
    <Swipe testID={`${testID}-swipe`} canPrevious={neighbour(-1) !== null} canNext={neighbour(1) !== null}
      onCommit={(direction) => { const id = neighbour(direction); if (id !== null) select(id); }}>
      {strip}
    </Swipe>
  );
}
