import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { HAPPIER_SEARCH_FIELD_METRICS, HAPPIER_TREE_ROW_METRICS, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { resolveScmChangeCompactRowHeight } from '@/components/workspaces/scm/changes/ScmChangeRow';
import { SCM_COMPARISON_RAIL_CAPTION_MIN_HEIGHT_PX } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ChangedFilesReviewIndex } from './ChangedFilesReviewIndex';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';

/**
 * The stream comparison's file navigation (owner 2026-11-10, Codex reference): the diff stream is the
 * list, so its files are not repeated above it. A compact panel floats top-right over the diffs with a
 * filter, the list | tree index and the review's view options, and folds to one small trigger.
 * It shares the rail's index and the floating material; only its placement is its own.
 */
export const ChangedFilesReviewFileWidget = React.memo(
  function ChangedFilesReviewFileWidget(
    props: Readonly<{
      files: readonly ScmFileStatus[];
      totalFiles: number;
      /** The rail's width: the widget is never wider than the rail it stands in for. */
      maxWidthPx: number;
      findModel?: ChangedFilesReviewFindModel;
      activeReviewFileKey: string | null;
      commentCountByPath: ReadonlyMap<string, number>;
      onFocusPath: (path: string) => void;
      renderCommitToggle: ((file: ScmFileStatus) => React.ReactNode) | null;
      renderRowAccessory: ((path: string) => React.ReactNode) | null;
      rootPath: string | null;
      listFooter?: React.ReactElement | null;
      /** Review's own Find and display menu, when no bar above the stream carries them. */
      menu?: React.ReactNode;
    }>,
  ) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const display = useGitDisplaySettings();
    const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
    const [expanded, setExpanded] = React.useState(true);
    const [query, setQuery] = React.useState('');
    const [area, setArea] = React.useState<Readonly<{
      width: number;
      height: number;
    }> | null>(null);
    const onAreaLayout = React.useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setArea((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    }, []);

    const needle = query.trim().toLowerCase();
    const files = React.useMemo(
      () =>
        needle === ''
          ? props.files
          : props.files.filter((file) =>
              file.fullPath.toLowerCase().includes(needle),
            ),
      [needle, props.files],
    );

    // The diffs stay the lead: the widget takes at most half the stream's width and half its height.
    const width = area
      ? Math.min(props.maxWidthPx, Math.floor(area.width / 2))
      : props.maxWidthPx;
    const maxBodyHeight = area ? Math.floor(area.height / 2) : 0;
    const rowHeight =
      display.changesLayout === 'tree'
        ? touchPrimaryPointer
          ? HAPPIER_TREE_ROW_METRICS.minHeightPx.touch
          : HAPPIER_TREE_ROW_METRICS.minHeightPx.precise
        : resolveScmChangeCompactRowHeight(touchPrimaryPointer);
    const rowCount =
      display.changesLayout === 'tree'
        ? files.length + countDirectories(files)
        : files.length;
    // The index's caption and its closing inset, around the rows (the rail's own measures).
    const indexChromeHeight = SCM_COMPARISON_RAIL_CAPTION_MIN_HEIGHT_PX + theme.space.s6 + theme.space.s12;
    const bodyHeight = Math.min(
      maxBodyHeight,
      indexChromeHeight + Math.max(1, rowCount) * rowHeight,
    );

    const collapse = React.useCallback(() => setExpanded(false), []);
    const expand = React.useCallback(() => setExpanded(true), []);

    return (
      <View
        testID="scm-review-file-widget-area"
        pointerEvents="box-none"
        style={styles.area}
        onLayout={onAreaLayout}
      >
        {!expanded ? (
          <View testID="scm-review-file-widget" style={styles.anchor}>
            <FloatingOverlay surfaceChrome="theme" scrollEnabled={false}>
              <HappierPressable
                testID="scm-review-file-widget-expand"
                accessibilityRole="button"
                accessibilityLabel={t('detailsSurface.review.showFileList')}
                onPress={expand}
                style={(state) => [
                  styles.trigger,
                  focusRingStyle({
                    focused: state.focused,
                    color: theme.colors.border.focus,
                  }),
                ]}
              >
                <Icon
                  name={
                    display.changesLayout === 'tree' ? 'tree-structure' : 'list'
                  }
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
                <Text style={styles.triggerLabel}>
                  {t('detailsSurface.review.files', {
                    count: props.totalFiles,
                  })}
                </Text>
                <Icon
                  name="caret-down"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
              </HappierPressable>
            </FloatingOverlay>
          </View>
        ) : area ? (
          <View
            testID="scm-review-file-widget"
            style={[styles.anchor, { width }]}
          >
            <FloatingOverlay
              surfaceChrome="theme"
              scrollEnabled={false}
              maxHeight={bodyHeight}
              header={
                <View style={styles.header}>
                  <CompactSearchField
                    testID="scm-review-file-filter"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('files.reviewFilterPlaceholder')}
                    style={styles.field}
                  />
                  {props.menu ?? null}
                  <IconButton
                    testID="scm-review-file-widget-collapse"
                    variant="plain"
                    size={28}
                    icon={
                      <Icon
                        name="caret-up"
                        size={ICON_SIZE.xs}
                        color={theme.colors.text.secondary}
                      />
                    }
                    accessibilityLabel={t('detailsSurface.review.hideFileList')}
                    tooltip={t('detailsSurface.review.hideFileList')}
                    expanded
                    onPress={collapse}
                  />
                </View>
              }
            >
              <View style={{ height: bodyHeight }}>
                {files.length === 0 ? (
                  <Text style={styles.empty}>{t('files.reviewNoMatches')}</Text>
                ) : (
                  <ChangedFilesReviewIndex
                    placement="floating"
                    files={files}
                    totalFiles={
                      needle === '' ? props.totalFiles : props.files.length
                    }
                    findModel={props.findModel}
                    activePath={null}
                    commentCountByPath={props.commentCountByPath}
                    onFocusPath={props.onFocusPath}
                    activeReviewFileKey={props.activeReviewFileKey}
                    renderCommitToggle={props.renderCommitToggle}
                    renderRowAccessory={props.renderRowAccessory}
                    rootPath={props.rootPath}
                    listFooter={needle === '' ? props.listFooter : null}
                  />
                )}
              </View>
            </FloatingOverlay>
          </View>
        ) : null}
      </View>
    );
  },
);

/** The folders a tree of these files draws, one row each, for the panel's height. */
function countDirectories(files: readonly ScmFileStatus[]): number {
  const directories = new Set<string>();
  for (const file of files) {
    let end = file.fullPath.lastIndexOf('/');
    while (end > 0) {
      const directory = file.fullPath.slice(0, end);
      if (directories.has(directory)) break;
      directories.add(directory);
      end = directory.lastIndexOf('/');
    }
  }
  return directories.size;
}

const stylesheet = StyleSheet.create((theme) => ({
  // The stream's whole viewport, so the panel can measure the room it floats in; touches pass through.
  area: {
    position: 'absolute',
    top: theme.space.s8,
    right: theme.space.s12,
    bottom: theme.space.s8,
    left: theme.space.s12,
    zIndex: 1,
    alignItems: 'flex-end',
  },
  anchor: {
    maxWidth: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s6,
    paddingHorizontal: theme.space.s8,
  },
  field: {
    flex: 1,
    minWidth: 0,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: HAPPIER_SEARCH_FIELD_METRICS.heightPx,
    paddingHorizontal: theme.space.s12,
  },
  triggerLabel: {
    ...Typography.variant('meta', 'medium'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  empty: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
}));
