import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import { Typography } from '@/constants/Typography';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import {
  selectScmChangedFiles,
  type ScmFileStatus,
} from '@/scm/scmStatusFiles';
import { useWorkspaceScmSnapshot } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import { useQuickOpenEmptyState } from './useQuickOpenEmptyState';

const STATUS_LETTER: Readonly<Record<ScmFileStatus['status'], string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
};

type FileRow = Readonly<{
  fullPath: string;
  fileName: string;
  filePath: string;
  change?: ScmFileStatus;
}>;

/**
 * The editor column with nothing open (lab ade-shell EM1), for a Session and for a Project: one
 * invitation (Open file…, the files search, with its shortcut), then what changed here and what was
 * read lately, so the next file is one press away. The lists are quick open's own sources
 * (`useQuickOpenEmptyState`), so this page and quick open never disagree. In Editor first the column
 * is permanent, so this is what the centre shows until a file opens.
 */
export const EmptyEditorPage = React.memo(function EmptyEditorPage(
  props: Readonly<{
    scope: WorkspaceScopeBase | null;
    /** Narrows Changed to the files this session touched; absent for a Project. */
    sessionId?: string | null;
    title: string;
    reason: string;
    changedTitle: string;
    onOpenFile: (path: string) => void;
    /** Reading every change at once; offered while the working tree has changes. */
    onReview?: () => void;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const bottomClearance = useFloatingChromeClearance();
  const sources = useQuickOpenEmptyState({
    scope: props.scope,
    sessionId: props.sessionId ?? null,
  });
  const shortcut = useKeyboardShortcutLabel('search.files');
  // Open file… is quick open; where Search is not mounted the page offers only its lists.
  const searchAvailable = useOptionalUniversalSearchRuntime() !== null;
  // The one change-count truth (the rail badge, the Git header and quick open read it too).
  const snapshot = useWorkspaceScmSnapshot(props.scope);
  const reviewCount =
    snapshot?.repo.isRepo === true ? selectScmChangedFiles(snapshot).length : 0;
  const changed = React.useMemo<FileRow[]>(
    () =>
      sources.changed.map((file) => ({
        fullPath: file.fullPath,
        fileName: file.fileName,
        filePath: file.filePath,
        change: file,
      })),
    [sources.changed],
  );
  const recent = React.useMemo<FileRow[]>(() => {
    const listed = new Set(changed.map((file) => file.fullPath));
    return sources.recent.filter((file) => !listed.has(file.fullPath));
  }, [changed, sources.recent]);
  const onOpenFile = props.onOpenFile;

  const renderRow = (file: FileRow) => (
    <HappierPressable
      key={file.fullPath}
      testID={`pane-empty-editor-file-${file.fullPath}`}
      accessibilityRole="button"
      accessibilityLabel={t('panes.emptyEditor.openChangedFileA11y', {
        name: file.fileName,
      })}
      onPress={() => onOpenFile(file.fullPath)}
      style={({ hovered, pressed }) => [
        styles.row,
        hovered || pressed
          ? { backgroundColor: theme.colors.surface.selected }
          : null,
      ]}
    >
      {/* The status column stays reserved so names align across both lists; only an added file takes the add colour (lab DIRECTION). */}
      <Text
        style={[
          styles.letter,
          file.change?.status === 'added'
            ? { color: theme.colors.diff.success }
            : null,
        ]}
      >
        {file.change ? STATUS_LETTER[file.change.status] : ''}
      </Text>
      <Text numberOfLines={1} style={styles.name}>
        {file.fileName}
      </Text>
      <Text numberOfLines={1} ellipsizeMode="middle" style={styles.dir}>
        {file.filePath.replace(/\/$/, '')}
      </Text>
      <View style={styles.grow} />
      {file.change ? (
        <DiffStat
          added={file.change.linesAdded}
          removed={file.change.linesRemoved}
        />
      ) : null}
    </HappierPressable>
  );
  const renderList = (
    title: string,
    files: readonly FileRow[],
    testID: string,
  ) =>
    files.length > 0 ? (
      <View testID={testID} style={styles.list}>
        <View style={styles.listHeader}>
          <Text style={styles.listTitle}>{title}</Text>
          <Text style={styles.listCount}>{files.length}</Text>
        </View>
        {files.map(renderRow)}
      </View>
    ) : null;

  return (
    <ScrollView
      testID={props.testID ?? 'pane-details-empty-state'}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingBottom: theme.space.s32 + bottomClearance }]}
    >
      <EmptyState
        testID="pane-empty-editor"
        layout="centered"
        size="details"
        scene="exploring"
        iconName="file"
        title={props.title}
        subtitle={props.reason}
        primaryAction={
          searchAvailable
            ? {
                label: t('panes.emptyEditor.openFile'),
                onPress: sources.openFiles,
                testID: 'pane-empty-editor-open-file',
                shortcut,
              }
            : undefined
        }
        secondaryAction={
          props.onReview && reviewCount > 0
            ? {
                label: t('detailsSurface.chrome.reviewChanges', {
                  count: reviewCount,
                }),
                onPress: props.onReview,
                testID: 'pane-empty-editor-review',
              }
            : undefined
        }
      />
      {renderList(props.changedTitle, changed, 'pane-empty-editor-changed')}
      {renderList(
        t('panes.emptyEditor.recent'),
        recent,
        'pane-empty-editor-recent',
      )}
    </ScrollView>
  );
});

/** The lists keep a reading measure under the centred state, like the lab's. */
const LIST_MAX_WIDTH_PX = 560;

const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: theme.space.s32,
    paddingHorizontal: theme.space.s16,
  },
  list: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: LIST_MAX_WIDTH_PX,
    marginTop: theme.space.s32,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s8,
    marginBottom: theme.space.s6,
  },
  listTitle: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  listCount: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minHeight: 36,
    paddingHorizontal: theme.space.s8,
    borderRadius: theme.space.s8,
  },
  letter: {
    ...Typography.mono(),
    ...Typography.variant('micro'),
    width: 12,
    color: theme.colors.text.secondary,
  },
  name: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 0,
    maxWidth: '50%',
  },
  dir: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
    minWidth: 0,
  },
  grow: { flex: 1 },
}));
