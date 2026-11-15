import * as React from 'react';
import type {
  ScmFileViewedFile,
  ScmFileViewedSource,
} from '@happier-dev/plugin-sdk/scm';
import {
  List,
  LoadingState,
  Stack,
  Text,
  formatHappierDiffStat,
  usePluginHostApi,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import type { TriageChangedFileV1 } from './changeSummary.js';

/**
 * A source's Viewed marks for its files (GitHub's per-head marks), with the words that say where a mark is saved.
 * A source without a Viewed concept passes none, and its rows offer no mark.
 */
export type TriageChangedFilesViewedV1 = Readonly<{
  source: ScmFileViewedSource;
  labels: Readonly<{
    viewed: string;
    notSaved: string;
    markViewed: string;
    markUnviewed: string;
  }>;
}>;

/** One band of files (GitHub's Source and Generated). A lone band is untitled. */
export type TriageChangedFilesSectionV1<TRow extends TriageChangedFileV1> =
  Readonly<{
    key: string;
    title: string;
    data: readonly TRow[];
  }>;

const NO_SUBSCRIPTION = () => () => {};
const NO_FILE = () => null;
const NO_COUNT = () => null;

/** Path-scoped subscription to the host's one Viewed owner, without another map. Null when the source has none. */
function useFileViewed(
  source: ScmFileViewedSource | null,
  path: string,
): ScmFileViewedFile | null {
  const subscribe = React.useCallback(
    (notify: () => void) =>
      source === null ? NO_SUBSCRIPTION() : source.subscribeFile(path, notify),
    [source, path],
  );
  const snapshot = React.useCallback(
    () => (source === null ? NO_FILE() : source.getFile(path)),
    [source, path],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * How many files the source has as viewed, once its Viewed owner has answered: the reader's progress through the
 * files, the one fact a Files panel adds above its rows (the tab already counts the files).
 */
export function useTriageViewedFileCount(
  source: ScmFileViewedSource | null,
): number | null {
  const subscribe = React.useCallback(
    (notify: () => void) => {
      if (source === null) return NO_SUBSCRIPTION();
      const offStatus = source.subscribeStatus(notify);
      const offChanges = source.subscribeChanges(() => notify());
      return () => {
        offStatus();
        offChanges();
      };
    },
    [source],
  );
  const snapshot = React.useCallback(
    () =>
      source === null || source.getSnapshot().status !== 'ready'
        ? NO_COUNT()
        : source.getViewedPaths().size,
    [source],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The progress line above the files ("2 of 6 viewed"). `null` while the Viewed owner has not answered: the line keeps
 * its height empty, so the rows do not move when the count lands.
 */
export function TriageChangedFilesProgress({
  value,
}: Readonly<{ value: string | null }>): React.ReactElement {
  return <Text variant="micro" tone="secondary" value={value ?? ' '} />;
}

/**
 * The Files panel while its first page is read: the progress line's place (when the source keeps Viewed marks), then
 * compact rows of the files' own shape, so the files replace placeholders of their size.
 */
export function TriageChangedFilesLoading({
  title,
  titleKey,
  progress,
}: Readonly<{
  title: string;
  titleKey: string;
  /** The source keeps Viewed marks, so a progress line will stand above the files. */
  progress: boolean;
}>): React.ReactElement {
  const rows = (
    <LoadingState
      title={title}
      titleKey={titleKey}
      rows={6}
      rowShape="compact"
    />
  );
  if (!progress) return rows;
  return (
    <Stack gap="small">
      <TriageChangedFilesProgress value={null} />
      {rows}
    </Stack>
  );
}

type FileRowProps<TRow extends TriageChangedFileV1> = Readonly<{
  row: TRow;
  expanded: boolean;
  active: boolean;
  onFocusPath: (path: string | null) => void;
  viewed: TriageChangedFilesViewedV1 | null;
  renderBody: (row: TRow) => React.ReactNode;
}>;

/**
 * One changed file: its path, what changed, and its Viewed mark, with Mark viewed, Copy and Open in the row's menu.
 * A file the source has a diff for opens in place; one with no diff has nothing to open, so it is a plain row.
 */
function FileRow<TRow extends TriageChangedFileV1>({
  row,
  expanded,
  active,
  onFocusPath,
  viewed,
  renderBody,
}: FileRowProps<TRow>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const file = useFileViewed(viewed?.source ?? null, row.path);
  const counts =
    row.lines === undefined
      ? null
      : formatHappierDiffStat(row.lines.additions, row.lines.deletions, {
          locale,
        });
  const isViewed = file?.state === 'viewed';
  // One word for the mark, whatever the source's refusal code was: the code is for logs, not for the reader.
  const mark =
    viewed === null
      ? undefined
      : file?.errorCode != null
        ? viewed.labels.notSaved
        : isViewed
          ? viewed.labels.viewed
          : undefined;
  const note = [row.note, mark].filter(Boolean).join(' · ') || undefined;
  // The mark is offered once the source has answered for this file; a pending write keeps it until it settles.
  const markAction =
    viewed === null || file === null || file.state === null
      ? []
      : [
          {
            id: 'viewed',
            label: isViewed
              ? viewed.labels.markUnviewed
              : viewed.labels.markViewed,
            disabled: file.pending,
          },
        ];
  const webUrl = row.webUrl;
  return (
    <List.Item
      title={row.path}
      titleEllipsizeMode="middle"
      density="compact"
      {...(isViewed ? { tone: 'secondary' as const } : {})}
      {...(note === undefined ? {} : { subtitle: note })}
      {...(counts === null
        ? {}
        : {
            detail: [counts.added, counts.removed]
              .filter((value) => value !== null)
              .join(' '),
          })}
      secondaryActions={[
        ...markAction,
        { id: 'copy', label: text('happier.plugin-ui.action.copy', 'Copy') },
        ...(webUrl === undefined
          ? []
          : [
              {
                id: 'open',
                label: text('happier.plugin-ui.action.open', 'Open'),
              },
            ]),
      ]}
      onSecondaryAction={(id) => {
        if (id === 'viewed' && viewed !== null)
          void viewed.source.setViewed(row.path, !isViewed);
        else if (id === 'copy') void host.writeClipboard(row.path);
        else if (id === 'open' && webUrl !== undefined)
          void host.openExternalLink(webUrl);
      }}
      {...(row.diffAvailable === true
        ? {
            // A panel that is not showing holds no open row (its focus clears as it leaves): the row never lifts around a
            // body it would not draw.
            expanded: expanded && active,
            onPress: () => onFocusPath(expanded ? null : row.path),
            // Always present on a file with a diff, so a collapsed row is announced as expandable and keeps its element
            // (and focus) when it opens. The disclosure mounts this body only while open (and through its closing
            // motion); that mount is what reads the diff, and its unmount cancels the read.
            expandedContent: (
              <React.Fragment key={row.path}>{renderBody(row)}</React.Fragment>
            ),
          }
        : {})}
    />
  );
}

/**
 * A change request's changed files, the one Files frame every forge source draws: flush compact rows with the path,
 * the source's note, +/− in the right column and a ⋯ menu; a file with a diff opens it in place, one at a time.
 * The source supplies its facts (bands, notes, counts, Viewed marks) and the body that reads one file's diff.
 */
export function TriageChangedFilesList<TRow extends TriageChangedFileV1>(
  props: Readonly<{
    accessibilityLabel: string;
    accessibilityLabelKey: string;
    sections: readonly TriageChangedFilesSectionV1<TRow>[];
    /** The one open file: the reader's pick or an agent's open intent. */
    focusPath: string | null;
    onFocusPath: (path: string | null) => void;
    /** False while the panel is hidden: no row holds open. */
    active: boolean;
    viewed: TriageChangedFilesViewedV1 | null;
    /** The disclosed body of a file with a diff; mounted only while that row is open. */
    renderBody: (row: TRow) => React.ReactNode;
    header: React.ReactNode;
    /** Trailing content that scrolls with the rows (the paging control), never a fixed band under the scroller. */
    endContent?: React.ReactNode;
  }>,
): React.ReactElement {
  // A band title names one band among others; a lone band is untitled (List draws no band for it), so the
  // collection keeps one sectioned shape, and its rows their state, when a later page adds a second band.
  const sections = React.useMemo(
    () =>
      props.sections.map((section) => ({
        key: section.key,
        title: props.sections.length < 2 ? '' : section.title,
        data: section.data,
      })),
    [props.sections],
  );
  const revealRequest = React.useMemo(
    () => (props.focusPath === null ? undefined : { key: props.focusPath }),
    [props.focusPath],
  );
  // Single-line file rows stack flush, as an index does; the open row lifts out of them on its own margin.
  return (
    <List
      accessibilityLabel={props.accessibilityLabel}
      accessibilityLabelKey={props.accessibilityLabelKey}
      density="flush"
      sections={sections}
      keyForItem={(row) => row.path}
      header={props.header}
      endContent={props.endContent}
      {...(revealRequest === undefined ? {} : { revealRequest })}
      renderItem={(row) => (
        <FileRow
          row={row}
          expanded={props.focusPath === row.path}
          active={props.active}
          onFocusPath={props.onFocusPath}
          viewed={props.viewed}
          renderBody={props.renderBody}
        />
      )}
    />
  );
}
