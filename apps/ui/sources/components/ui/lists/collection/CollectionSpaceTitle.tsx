import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { CollectionEntityKindV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { useCollectionSavedViewsSelection } from '@happier-dev/plugin-ui/components';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { collectionSpacesManageHref } from '@/components/settings/session/collectionSpaceSettings';

import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SelectionListFilter } from '@/components/ui/selectionList';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { type CollectionSpacesStripItem } from './CollectionSpacesStrip';
import { CollectionSpaceIcon } from './CollectionSpaceIcon';
import { CollectionTitleButton } from './CollectionTitleButton';

const FILTER_ITEM = 'filter';
const SAVE_AS_ITEM = 'save-as';
const SAVE_CHANGES_ITEM = 'save-changes';
const EDIT_ITEM = 'edit';
const MANAGE_ITEM = 'manage';
const SHOW_SPACES_ITEM = 'show-spaces';
const FACET_ITEM_PREFIX = 'facet:';

/** A list's filters shown as the title menu's Filter submenu. */
export type CollectionSpaceTitleFilter = Readonly<{
  /** Conditions on beyond the space's own (the token count). */
  count: number;
  maxWidth: number;
  maxHeight: number;
  /**
   * The filter editor; `done` closes the whole menu. On a phone the menu covers the list, so the editor ends
   * with Show N results (`endsWithDone`).
   */
  render: (layout: Readonly<{ maxHeight: number; endsWithDone: boolean; done: () => void }>) => React.ReactNode;
}>;

type ShortcutId = keyof React.ContextType<typeof KeyboardShortcutLabelsContext>;

/**
 * A saved-space list's title (Sessions, Workflows, Discussions — R9): it names the selected space and its
 * chevron opens one menu (lab `clfilter`, title chevron ruling; lab `spfield` facets): every space with its
 * shortcut, then the list's common filters, each one press to turn on or off with the menu staying open, then
 * Filter…, Save as space… or Edit space…, then Show spaces (this list's switch) and Manage spaces (that
 * entity's Settings → Spaces page). With spaces off the menu keeps the filters and the way back.
 */
export const CollectionSpaceTitle = React.memo(function CollectionSpaceTitle(
  props: Readonly<{
    /** Stable Account catalog authority, shared with the public saved-view picker. */
    scope: string | object;
    /** `<prefix>-title`, `<prefix>-menu:<space id>`, `<prefix>-menu-filter`, … */
    testIDPrefix: string;
    /** Whose spaces Manage spaces opens. */
    entityKind: CollectionEntityKindV1;
    label: string;
    /** Under a page's own title (the Workflows library home) the space title stays a heading on a phone. */
    titleScale?: 'page' | 'section';
    spaces: readonly CollectionSpacesStripItem[];
    /** The list's digit shortcuts, when it has them: `${prefix}${ordinal}` for the first nine spaces. */
    spaceShortcutPrefix?: string;
    /** The list's common filters (`useCollectionConditionHeader` `facetToggles`): one press each, in place. */
    facets?: readonly SelectionListFilter[];
    /** The list's Filter… shortcut, when it has one. */
    filterShortcutId?: ShortcutId;
    selectedSpaceId: string;
    /** This list's effective switch; null until the Account's settings are known (no switch is offered). */
    spacesEnabled: boolean | null;
    onSetSpacesEnabled: (next: boolean) => void;
    modified: boolean;
    onSelectSpace: (spaceId: string) => void;
    onOpenFilter: () => void;
    /**
     * The list's filters as a submenu of the Filter row (beside the menu; pushed inside the menu's sheet on a
     * phone). The row shows how many conditions are on. Without it, Filter… opens the list's own editor.
     */
    filter?: CollectionSpaceTitleFilter;
    onSaveAs: () => void;
    onSaveChanges: () => void;
    onEdit: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const admittedItems = React.useMemo(() => props.spaces.map((space) => ({ id: space.id, label: space.name })), [props.spaces]);
  const selectSpace = React.useCallback((id: string | null) => {
    if (id !== null) props.onSelectSpace(id);
  }, [props.onSelectSpace]);
  const selection = useCollectionSavedViewsSelection({
    scope: props.scope, items: admittedItems, selectedId: props.selectedSpaceId,
    labels: { title: t('sessionsList.spacesTitle') }, onSelect: selectSpace,
  });
  const router = useRouter();
  const shortcutLabels = React.useContext(KeyboardShortcutLabelsContext);
  const iconColor = theme.colors.text.secondary;
  // A saved view that now differs from its space (P6 §7.1); Save changes / Save as follow in the menu.
  const filtered = props.spacesEnabled === true && props.modified;
  const closeMenu = selection.onOpenChange;
  const phone = useDeviceType() === 'phone';
  const filterItem = React.useMemo((): DropdownMenuItem => {
    const filter = props.filter;
    const base = {
      id: FILTER_ITEM,
      testID: `${props.testIDPrefix}-menu-filter`,
      icon: <Icon name="funnel-simple" size={ICON_SIZE.sm} color={iconColor} />,
      shortcut: props.filterShortcutId ? shortcutLabels[props.filterShortcutId] : undefined,
      category: 'actions',
    };
    if (!filter) return { ...base, title: t('sessionsList.spacesFilter') };
    const name = t('sessionsList.conditionTitle');
    return {
      ...base,
      title: filter.count > 0 ? `${name} · ${filter.count}` : name,
      submenu: {
        items: [],
        title: name,
        // The editor draws its own header (Filter · Clear); a phone keeps only its Back above it.
        sheetHeader: 'none',
        maxWidthCap: filter.maxWidth,
        maxHeightCap: filter.maxHeight,
        renderContent: ({ maxHeight }) => filter.render({
          maxHeight,
          endsWithDone: phone,
          done: () => closeMenu(false),
        }),
      },
    };
  }, [closeMenu, iconColor, phone, props.filter, props.filterShortcutId, props.testIDPrefix, shortcutLabels]);
  const items = React.useMemo<readonly DropdownMenuItem[]>(
    () => [
      ...selection.items.map((item, index): DropdownMenuItem => {
        // This adapter adds host icon/shortcut presentation to the public selection model.
        const space = props.spaces[index]!;
        return {
          id: item.id,
          testID: `${props.testIDPrefix}-menu:${space.id}`,
          title: item.label,
          icon: <CollectionSpaceIcon icon={space.icon} size={ICON_SIZE.sm} color={iconColor} />,
          shortcut:
            props.spaceShortcutPrefix !== undefined && index < 9
              ? shortcutLabels[`${props.spaceShortcutPrefix}${index + 1}` as ShortcutId]
              : undefined,
          checked: selection.radioGroups.some((group) => group.selectedId === item.id),
          category: 'spaces',
        };
      }),
      ...(props.facets ?? []).map((facet): DropdownMenuItem => ({
        id: `${FACET_ITEM_PREFIX}${facet.id}`,
        testID: `${props.testIDPrefix}-menu-facet:${facet.id}`,
        title: facet.label,
        checked: facet.selected === true,
        // Each filter turns on and off by itself: Working and Failed can both be on.
        multiSelect: true,
        category: 'filters',
      })),
      filterItem,
      ...(!props.spacesEnabled ? [] : props.modified
        ? [
            {
              id: SAVE_CHANGES_ITEM,
              testID: `${props.testIDPrefix}-menu-save-changes`,
              title: t('sessionsList.spacesSaveChanges'),
              category: 'actions',
            },
            {
              id: SAVE_AS_ITEM,
              testID: `${props.testIDPrefix}-menu-save-as`,
              title: t('sessionsList.spacesSaveAs'),
              category: 'actions',
            },
          ]
        : [
            {
              id: EDIT_ITEM,
              testID: `${props.testIDPrefix}-menu-edit`,
              title: t('sessionsList.spacesEdit'),
              category: 'actions',
            },
          ]),
      ...(props.spacesEnabled === null ? [] : [{
        id: SHOW_SPACES_ITEM,
        testID: `${props.testIDPrefix}-menu-show-spaces`,
        title: t('sessionsList.spacesShow'),
        checked: props.spacesEnabled,
        category: 'settings',
      }]),
      ...(props.spacesEnabled ? [{
        id: MANAGE_ITEM,
        testID: `${props.testIDPrefix}-menu-manage`,
        title: t('sessionsList.spacesManage'),
        category: 'settings',
      }] : []),
    ],
    [
      iconColor,
      props.facets,
      filterItem,
      props.modified,
      props.spacesEnabled,
      selection.items,
      selection.radioGroups,
      props.spaceShortcutPrefix,
      props.spaces,
      props.testIDPrefix,
      shortcutLabels,
    ],
  );
  const handleSelect = React.useCallback(
    (itemId: string) => {
      if (selection.selectItem(itemId)) return;
      if (itemId.startsWith(FACET_ITEM_PREFIX)) {
        props.facets?.find((facet) => `${FACET_ITEM_PREFIX}${facet.id}` === itemId)?.onToggle?.();
        return;
      }
      selection.onOpenChange(false);
      if (itemId === FILTER_ITEM) props.onOpenFilter();
      else if (itemId === SAVE_AS_ITEM) props.onSaveAs();
      else if (itemId === SAVE_CHANGES_ITEM) props.onSaveChanges();
      else if (itemId === EDIT_ITEM) props.onEdit();
      else if (itemId === SHOW_SPACES_ITEM) props.onSetSpacesEnabled(!props.spacesEnabled);
      else if (itemId === MANAGE_ITEM)
        router.push(collectionSpacesManageHref(props.entityKind));
    },
    [props, router, selection.onOpenChange, selection.selectItem],
  );
  return (
    <DropdownMenu
      open={selection.open}
      onOpenChange={selection.onOpenChange}
      items={items}
      onSelect={handleSelect}
      // A filter toggles in place, so a second one is one more press, not a reopened menu; every other choice
      // closes the menu itself in `handleSelect` (a space through the saved-view selection).
      closeOnSelect={false}
      variant="slim"
      search={false}
      separateCategories
      matchTriggerWidth={false}
      maxWidthCap={280}
      popoverPortalWebTarget="body"
      placement="bottom"
      popoverAnchorAlign="start"
      popoverAccessibilityLabel={t('sessionsList.spacesTitle')}
      trigger={({ toggle }) => (
        <CollectionTitleButton
          testID={`${props.testIDPrefix}-title`}
          label={props.label}
          accessibilityLabel={t('sessionsList.spacesTitleMenu', {
            name: filtered ? `${props.label}, ${t('sessionsList.spacesFiltered')}` : props.label,
          })}
          {...(filtered ? { trailing: (
            <Text testID={`${props.testIDPrefix}-title-filtered`} numberOfLines={1}
              style={{ ...Typography.variant('meta'), color: theme.colors.text.tertiary, marginLeft: theme.space.s6 }}>
              {t('sessionsList.spacesFiltered')}
            </Text>
          ) } : {})}
          expanded={selection.open}
          hasPopup="menu"
          onPress={toggle}
          {...(props.titleScale ? { scale: props.titleScale } : {})}
        />
      )}
    />
  );
});
