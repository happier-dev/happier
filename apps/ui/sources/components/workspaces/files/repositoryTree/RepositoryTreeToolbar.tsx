import * as React from 'react';
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
import { KeyboardCommandHint } from '@/components/ui/keyboard/KeyHint';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';

type TreeShow = 'all' | 'changed';

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
  const [viewMenuOpen, setViewMenuOpen] = React.useState(false);
  const iconColor = theme.colors.text.secondary;
  const prefix = props.testIDPrefix;
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
  const projectViewAvailable = visibility?.available === true;
  const showAllFiles = visibility
    ? !projectViewAvailable || visibility.mode === 'all'
    : false;

  const viewItems = React.useMemo((): readonly DropdownMenuItem[] => {
    const items: DropdownMenuItem[] = [];
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
    showAllFiles,
    visibility,
  ]);

  const selectViewItem = React.useCallback(
    (itemId: string) => {
      setViewMenuOpen(false);
      if (itemId === `${prefix}-project-files`) visibility?.onChange('project');
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
      iconName="x"
      accessibilityLabel={t('common.close')}
      onPress={props.onRequestClose}
    />
  ) : null;

  // Two options, both always visible: a segmented view switch (lab FB1 "All | Changed 4").
  const changedCount = props.changedCount;
  const showTabs = React.useMemo(
    (): ReadonlyArray<SegmentedTab<TreeShow>> | null =>
      changedCount === 'none'
        ? null
        : [
            {
              id: 'all',
              label: t('files.pane.showAll'),
              testID: `${prefix}-show-all`,
            },
            {
              id: 'changed',
              label: t('files.pane.showChanged'),
              testID: `${prefix}-show-changed`,
              ...(changedCount === null
                ? {}
                : { count: formatExactCount(changedCount) }),
            },
          ],
    [changedCount, prefix],
  );
  const selectShow = React.useCallback(
    (next: TreeShow) => onChangedOnlyChange(next === 'changed'),
    [onChangedOnlyChange],
  );
  const segment = showTabs ? (
    <SegmentedTabBar<TreeShow>
      tabs={showTabs}
      activeTabId={props.changedOnly ? 'changed' : 'all'}
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
    ) : onQuickOpen && Platform.OS === 'web' ? (
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
    <View testID={`${prefix}-toolbar`} style={styles.row}>
      <View style={styles.field}>
        <CompactSearchField
          testID={`${prefix}-search`}
          value={searchValue}
          onChangeText={props.onSearchValueChange}
          placeholder={t('projects.code.goToFile')}
          trailing={fieldTrailing}
        />
      </View>
      {segment}
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
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  field: {
    flex: 1,
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
