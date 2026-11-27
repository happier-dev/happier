import * as React from 'react';
import { usePaneContentInsetPx } from '@/components/ui/lists/listPresentation';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyboardCommandHint, useKeyboardCommandHintLabel } from '@/components/ui/keyboard/KeyHint';
import {
  SEGMENTED_TAB_ICON_SIZE_PX,
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

type TreeShow = 'all' | 'changed' | 'media';
type TreeView = 'list' | 'gallery';

/** A digit-wide blank (U+2007 FIGURE SPACE) standing in for a count that has not arrived. */
const PENDING_COUNT_SLOT = '\u2007';

export type RepositoryTreeToolbarProps = Readonly<{
  /** Prefix of every control's testID (`repository-tree`, `workspace-repository-tree`). */
  testIDPrefix: string;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  /** Code owns Go to file above the table; keep only the shared View and creation controls. */
  showSearch?: boolean;
  /** The tree is pruned to the changed files (lab FB1c). */
  changedOnly: boolean;
  /**
   * The one changed-file count (`selectScmChangedFiles(snapshot).length`): null while unknown (the
   * Changed option stays, without a count); `'none'` when the snapshot says nothing changed or the
   * folder is not a repository, which hides the All | Changed control (lab FB1z).
   */
  changedCount: number | null | 'none';
  onChangedOnlyChange: (next: boolean) => void;
  /** Quick open (⌘P, Files in this workspace) for what the field holds; the field's key hint opens it. */
  onQuickOpen?: ((query: string) => void) | null;
  detailsMode: boolean;
  onDetailsModeChange: (next: boolean) => void;
  /** Collapse all is offered only while a folder is open. */
  onCollapseAll: (() => void) | null;
  onRefresh: () => void;
  /** The tree root is loading: the View menu's trigger shows it. */
  refreshing: boolean;
  /** A host that has no pane header (the projects pane) keeps its + menu here. */
  trailing?: React.ReactNode;
  onRequestClose?: () => void;
  /**
   * `inline`: only the View menu and trailing controls, without the row's insets, for a host that
   * places them in its own bar (the Code page puts them beside Go to file).
   */
  layout?: 'row' | 'inline';
  /** Project view | All files, as the View menu's first choice (lab FB1v); offered only when ignore rules exist. */
  visibility?: Readonly<{
    mode: 'project' | 'all';
    available?: boolean;
    onChange: (mode: 'project' | 'all') => void;
  }> | null;
  /**
   * A Session's own media as the segment's last option, always shown and never counted (lab pr974 SM1: a count
   * would arrive late and widen the segment).
   */
  media?: Readonly<{ selected: boolean; onSelect: () => void }> | null;
  /** List | Gallery for the folder in view (lab SG1): drawn only while All shows the files. */
  galleryView?: Readonly<{ mode: TreeView; onChange: (mode: TreeView) => void }> | null;
  /** Media shows its gallery beside, in the Details pane (lab SG2f), in the slot List | Gallery leaves. */
  onOpenMediaBeside?: ((event?: unknown) => void) | null;
}>;

/**
 * The Files tree's one toolbar (lab FB1): Go to file (the tree's own filter, with ⌘P beside it for quick
 * open) · All | Changed N · one View menu. The segment hides when nothing changed; the field then takes
 * its width and nothing else moves.
 */
export const RepositoryTreeToolbar = React.memo(function RepositoryTreeToolbar(
  props: RepositoryTreeToolbarProps,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  // The field starts on the pane's text edge; the trailing ⋯ ends where the pane header's ⋯ does.
  const contentInsetPx = usePaneContentInsetPx();
  const [viewMenuOpen, setViewMenuOpen] = React.useState(false);
  const [searchOpened, setSearchOpened] = React.useState(false);
  const iconColor = theme.colors.text.secondary;
  const prefix = props.testIDPrefix;
  // The gap the toolbar leaves between its controls (the stylesheet's `row` and `inline` gaps): each
  // control's hit area takes half of it.
  const controlGap = props.layout === 'inline' ? theme.space.s4 : theme.space.s6;
  const {
    onChangedOnlyChange,
    onDetailsModeChange,
    onCollapseAll,
    onRefresh,
    detailsMode,
    visibility,
    onQuickOpen,
    searchValue,
  } = props;
  // Three options and the view toggle need the field's width: Go to file moves into the View menu until chosen
  // (lab pr974 SG1 draws it as a glyph; the shared segmented control is wider than the lab's, so the glyph would
  // push the menu onto a second line in the Files pane), and folds back when it is left empty.
  const searchCollapsed = props.media != null && props.showSearch !== false && searchValue.length === 0 && !searchOpened;
  // The ⌘P control is its keycaps: where they are not drawn (a finger, no key bound) nothing is pressable.
  const quickOpenHintDrawn = useKeyboardCommandHintLabel('search.files') !== null;
  const projectViewAvailable = visibility?.available === true;
  const showAllFiles = visibility
    ? !projectViewAvailable || visibility.mode === 'all'
    : false;

  const viewItems = React.useMemo((): readonly DropdownMenuItem[] => {
    const items: DropdownMenuItem[] = [];
    if (searchCollapsed) {
      items.push({
        id: `${prefix}-go-to-file`,
        testID: `${prefix}-go-to-file`,
        title: t('projects.code.goToFile'),
        icon: <Icon name="magnifying-glass" size={16} color={iconColor} />,
      });
    }
    // Without ignore rules there is nothing to hide: the choice only exists when it can change the list.
    if (visibility && projectViewAvailable) {
      items.push(
        {
          id: `${prefix}-project-files`,
          testID: `${prefix}-project-files`,
          title: t('files.toolbar.projectFiles'),
          checked: !showAllFiles,
        },
        {
          id: `${prefix}-all-files`,
          testID: `${prefix}-all-files`,
          title: t('files.toolbar.allFiles'),
          checked: showAllFiles,
        },
      );
    }
    items.push({
      id: `${prefix}-toggle-details`,
      testID: `${prefix}-toggle-details`,
      title: t('files.pane.sizeAndDate'),
      checked: detailsMode,
    });
    if (onCollapseAll) {
      items.push({
        id: `${prefix}-collapse-all`,
        testID: `${prefix}-collapse-all`,
        title: t('files.repositoryCollapseAll'),
        icon: <Icon name="arrows-in" size={16} color={iconColor} />,
      });
    }
    items.push({
      id: `${prefix}-refresh`,
      testID: `${prefix}-refresh`,
      title: t('common.refresh'),
      icon: <Icon name="arrows-clockwise" size={16} color={iconColor} />,
    });
    return items;
  }, [
    detailsMode,
    iconColor,
    onCollapseAll,
    prefix,
    projectViewAvailable,
    searchCollapsed,
    showAllFiles,
    visibility,
  ]);

  const selectViewItem = React.useCallback(
    (itemId: string) => {
      setViewMenuOpen(false);
      if (itemId === `${prefix}-go-to-file`) setSearchOpened(true);
      else if (itemId === `${prefix}-project-files`) visibility?.onChange('project');
      else if (itemId === `${prefix}-all-files`) visibility?.onChange('all');
      else if (itemId === `${prefix}-toggle-details`)
        onDetailsModeChange(!detailsMode);
      else if (itemId === `${prefix}-collapse-all`) onCollapseAll?.();
      else if (itemId === `${prefix}-refresh`) onRefresh();
    },
    [
      detailsMode,
      onCollapseAll,
      onDetailsModeChange,
      onRefresh,
      prefix,
      visibility,
    ],
  );

  const viewMenu = (
    <DropdownMenu
      testID={`${prefix}-view-menu`}
      open={viewMenuOpen}
      onOpenChange={setViewMenuOpen}
      items={viewItems}
      onSelect={selectViewItem}
      matchTriggerWidth={false}
      placement="bottom"
      trigger={({ open, toggle }) => (
        <IconButton
          testID={`${prefix}-view`}
          variant="plain"
          size={32}
          interactiveTargetGapPx={controlGap}
          {...(props.refreshing
            ? {
                icon: (
                  <ActivitySpinner
                    testID={`${prefix}-refresh-loading`}
                    size="small"
                    color={iconColor}
                  />
                ),
              }
            : { iconName: 'dots-three' as const })}
          selected={open}
          expanded={open}
          hasPopup="menu"
          accessibilityLabel={t('files.pane.viewOptions')}
          tooltip={t('files.pane.viewOptions')}
          onPress={toggle}
        />
      )}
    />
  );

  const close = props.onRequestClose ? (
    <IconButton
      testID={`${prefix}-close`}
      variant="plain"
      size={32}
      interactiveTargetGapPx={controlGap}
      iconName="x"
      accessibilityLabel={t('common.close')}
      onPress={props.onRequestClose}
    />
  ) : null;

  // Two options, both always visible: a segmented view switch (lab FB1 "All | Changed 4"), at the
  // toolbar's one control height so it stands level with Go to file and the View menu.
  const changedCount = props.changedCount;
  const media = props.media ?? null;
  const mediaOffered = media !== null;
  const showTabs = React.useMemo(
    (): ReadonlyArray<SegmentedTab<TreeShow>> | null => {
      const changed: SegmentedTab<TreeShow> | null = changedCount === 'none' ? null : {
        id: 'changed',
        label: t('files.pane.showChanged'),
        testID: `${prefix}-show-changed`,
        // Unknown: a one-digit slot (a figure space) holds the count's room, so the count fills it
        // instead of widening the segment when the snapshot answers.
        count: changedCount === null ? PENDING_COUNT_SLOT : formatExactCount(changedCount),
      };
      if (!changed && !mediaOffered) return null;
      return [
        { id: 'all', label: t('files.pane.showAll'), testID: `${prefix}-show-all` },
        ...(changed ? [changed] : []),
        ...(mediaOffered ? [{ id: 'media' as const, label: t('files.pane.gallery.media'), testID: `${prefix}-show-media` }] : []),
      ];
    },
    [changedCount, mediaOffered, prefix],
  );
  const selectMedia = media?.onSelect;
  const selectShow = React.useCallback(
    (next: TreeShow) => (next === 'media' ? selectMedia?.() : onChangedOnlyChange(next === 'changed')),
    [onChangedOnlyChange, selectMedia],
  );
  const activeShow: TreeShow = media?.selected ? 'media' : props.changedOnly ? 'changed' : 'all';
  const galleryView = activeShow === 'all' ? props.galleryView ?? null : null;
  const changeGalleryView = galleryView?.onChange;
  const viewTabs = React.useMemo((): ReadonlyArray<SegmentedTab<TreeView>> => [
    { id: 'list', label: t('files.pane.gallery.list'), testID: `${prefix}-view-list`,
      icon: <Icon name="list-bullets" size={SEGMENTED_TAB_ICON_SIZE_PX} color={iconColor} /> },
    { id: 'gallery', label: t('files.pane.gallery.gallery'), testID: `${prefix}-view-gallery`,
      icon: <Icon name="squares-four" size={SEGMENTED_TAB_ICON_SIZE_PX} color={iconColor} /> },
  ], [iconColor, prefix]);
  const viewToggle = galleryView && changeGalleryView ? (
    <SegmentedTabBar<TreeView>
      tabs={viewTabs}
      activeTabId={galleryView.mode}
      onSelectTab={changeGalleryView}
      segmentSizing="content"
      accessibilityLabel={t('files.pane.gallery.viewLabel')}
      testIDPrefix={`${prefix}-view-mode`}
    />
  ) : activeShow === 'media' && props.onOpenMediaBeside ? (
    <IconButton
      testID={`${prefix}-media-beside`}
      variant="plain"
      size={32}
      interactiveTargetGapPx={controlGap}
      iconName="square-split-horizontal"
      accessibilityLabel={t('files.pane.gallery.openBeside')}
      tooltip={t('files.pane.gallery.openBeside')}
      onPress={props.onOpenMediaBeside}
    />
  ) : null;
  const segment = showTabs ? (
    <SegmentedTabBar<TreeShow>
      tabs={showTabs}
      activeTabId={activeShow}
      onSelectTab={selectShow}
      segmentSizing="content"
      accessibilityLabel={t('files.pane.showLabel')}
      testIDPrefix={`${prefix}-show`}
    />
  ) : null;

  if (props.showSearch === false) {
    return (
      <View
        testID={`${prefix}-toolbar`}
        style={props.layout === 'inline' ? styles.inline : styles.row}
      >
        {props.layout === 'inline' ? null : <View style={styles.spacer} />}
        {viewMenu}
        {props.trailing}
        {close}
      </View>
    );
  }

  // Typed: the field's own clear. Empty: the ⌘P keycaps, which open quick open (lab FB1 `.wt-search kbd`).
  const fieldTrailing =
    searchValue.length > 0 ? (
      <IconButton
        testID={`${prefix}-clear-search`}
        variant="plain"
        size={20}
        iconName="x"
        accessibilityLabel={t('files.clearSearchA11y')}
        onPress={() => props.onSearchValueChange('')}
      />
    ) : onQuickOpen && Platform.OS === 'web' && quickOpenHintDrawn ? (
      <HappierPressable
        testID={`${prefix}-quick-open`}
        accessibilityRole="button"
        accessibilityLabel={t('universalSearch.quickOpen.openFile')}
        onPress={() => onQuickOpen(searchValue)}
      >
        <KeyboardCommandHint commandId="search.files" />
      </HappierPressable>
    ) : null;

  return (
    <View testID={`${prefix}-toolbar`} style={[styles.row, { paddingLeft: contentInsetPx, paddingRight: contentInsetPx / 2 }]}>
      {searchCollapsed ? null : (
        <View style={styles.field}>
          <CompactSearchField
            testID={`${prefix}-search`}
            value={searchValue}
            onChangeText={props.onSearchValueChange}
            placeholder={t('projects.code.goToFile')}
            trailing={fieldTrailing}
            autoFocus={mediaOffered && searchOpened}
            onBlur={mediaOffered ? () => setSearchOpened(false) : undefined}
          />
        </View>
      )}
      {segment}
      {viewToggle}
      {viewMenu}
      {props.trailing}
      {close}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  // The toolbar sits on the pane without a rule under it; the tree follows (lab FB1 `.fl-ftool`).
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingVertical: theme.space.s8,
  },
  field: {
    flex: 1,
    // Let the other controls wrap before they consume the query's entire width at large text sizes. At a
    // phone's 390 px the segment and View menu leave the field 184 px: a half-row basis (183) sat on the wrap
    // edge and dropped the View menu alone onto a second line.
    flexBasis: '40%',
    minWidth: 0,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  spacer: {
    flex: 1,
  },
}));
