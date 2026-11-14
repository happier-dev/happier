import * as React from 'react';
import type { ScmFileViewedFile, ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import { DiffViewer, List, LoadingState, Stack, Text, formatHappierDiffStat,
  usePluginHostApi, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { groupGithubChangedFiles, orderGithubChangedFiles } from '../../triage/detail/files/orderChangedFiles.js';
import { useGithubChangedFileDiffLoader, type GithubChangedFileViewV1, type GithubChangedFileDiffV1 } from './panelReaders.js';
import { GithubReadFailure } from './readFailure.js';
import { GITHUB_CHANGED_FILE_STATUS_LABELS_V1, githubChangedFileStatusKey } from './vocabulary.js';
import type { PluginTranslate } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

/** Only the disclosed row loads a body; switching rows or hiding Files cancels that read. */
function FileBody({ row, input }: Readonly<{ row: GithubChangedFileViewV1; input: TriageDetailSurfaceInputV1 }>) {
  const read = useGithubChangedFileDiffLoader(input);
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof read>> | null>(null);
  React.useEffect(() => {
    const abort = new AbortController();
    void read(row, abort.signal).then(value => { if (!abort.signal.aborted) setResult(value); });
    return () => abort.abort();
  }, [read, row]);
  if (result === null) return <LoadingState title="Reading file diff" />;
  if (result.kind === 'failed') return <GithubReadFailure title="File diff unavailable" failures={[result.failure]} />;
  return <FileDiff row={row} diff={result.value} />;
}

function FileDiff({ row, diff }: Readonly<{ row: GithubChangedFileViewV1; diff: GithubChangedFileDiffV1 }>) {
  const text = usePluginTranslation();
  return <Stack gap="small">
    {diff.evidence.state === 'truncated' ? <Text value={text('plugins.github.ui.fileDiffTruncated', 'GitHub shortened this diff. The rest is on GitHub.')} /> : null}
    {diff.unifiedDiff === null
      ? <Text value={text('plugins.github.ui.fileDiffNone', 'GitHub has no diff for this file.')} />
      : <DiffViewer unifiedDiff={diff.unifiedDiff} filePath={row.path} label={row.path} />}
  </Stack>;
}

/**
 * The row's second line speaks only when it says something: a plain modification is one line, while an added,
 * deleted or renamed file, one GitHub sent no diff for, or one the reader marked viewed says so.
 */
function fileNote(text: PluginTranslate, row: GithubChangedFileViewV1, viewed: ScmFileViewedFile | null): string | undefined {
  const status = row.status === 'renamed' && row.previousPath !== undefined
    ? text('plugins.github.ui.fileRenamedFrom', 'Renamed from {previous}', { previous: row.previousPath })
    : GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status] === undefined ? undefined
      : text(githubChangedFileStatusKey(row.status), GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status]!);
  const noDiff = row.diffAvailable ? undefined : text('plugins.github.ui.fileDiffNone', 'GitHub has no diff for this file.');
  // One word for the mark, whatever GitHub's refusal code was: the code is for logs, not for the reader.
  const mark = viewed?.errorCode != null ? text('plugins.github.ui.fileViewedNotSaved', 'Not saved to GitHub')
    : viewed?.state === 'viewed' ? text('plugins.github.ui.fileViewed', 'Viewed') : undefined;
  return [status, noDiff, mark].filter(Boolean).join(' · ') || undefined;
}

const NO_VIEWED_SUBSCRIPTION = () => () => {};
const NO_VIEWED_FILE = () => null;

/** Path-scoped subscription to the host's one Viewed owner, without another map. Null when the host has none. */
function useFileViewed(source: ScmFileViewedSource | null, path: string): ScmFileViewedFile | null {
  const subscribe = React.useCallback(
    (notify: () => void) => source === null ? NO_VIEWED_SUBSCRIPTION() : source.subscribeFile(path, notify), [source, path]);
  const snapshot = React.useCallback(() => source === null ? NO_VIEWED_FILE() : source.getFile(path), [source, path]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

const NO_VIEWED_COUNT = () => null;

/**
 * How many files GitHub has as viewed for this PR head, once the Viewed source has answered: the reader's progress
 * through the files, the one fact the Files panel adds above its rows (the tab already counts the files).
 */
export function useViewedFileCount(source: ScmFileViewedSource | null): number | null {
  const subscribe = React.useCallback((notify: () => void) => {
    if (source === null) return NO_VIEWED_SUBSCRIPTION();
    const offStatus = source.subscribeStatus(notify);
    const offChanges = source.subscribeChanges(() => notify());
    return () => { offStatus(); offChanges(); };
  }, [source]);
  const snapshot = React.useCallback(() => source === null || source.getSnapshot().status !== 'ready'
    ? NO_VIEWED_COUNT() : source.getViewedPaths().size, [source]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

type FileRowProps = Readonly<{
  row: GithubChangedFileViewV1;
  input: TriageDetailSurfaceInputV1;
  expanded: boolean;
  onFocusPath: (path: string | null) => void;
  active: boolean;
  viewed: ScmFileViewedSource | null;
  showDivider?: boolean;
}>;

/**
 * One changed file: its path, what changed, and its Viewed mark, with Copy, Open and Mark viewed in the row's menu.
 * A file GitHub has a diff for opens in place; one with no diff has nothing to open, so it is a plain row.
 */
function FileRow({ row, input, expanded, onFocusPath, active, viewed, showDivider }: FileRowProps): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  const file = useFileViewed(viewed, row.path);
  const counts = formatHappierDiffStat(row.additions, row.deletions, { locale });
  const note = fileNote(text, row, file);
  const isViewed = file?.state === 'viewed';
  // The mark is offered once the source has answered for this file; a pending write keeps it until it settles.
  const markAction = viewed === null || file === null || file.state === null ? [] : [{
    id: 'viewed',
    label: isViewed ? text('plugins.github.ui.markUnviewed', 'Mark unviewed') : text('plugins.github.ui.markViewed', 'Mark viewed'),
    disabled: file.pending,
  }];
  return <List.Item title={row.path} titleEllipsizeMode="middle" density="compact"
    {...(showDivider === undefined ? {} : { showDivider })}
    {...(isViewed ? { tone: 'secondary' as const } : {})}
    {...(note === undefined ? {} : { subtitle: note })}
    detail={[counts.added, counts.removed].filter(value => value !== null).join(' ')}
    secondaryActions={[...markAction, { id: 'copy', label: text('happier.plugin-ui.action.copy', 'Copy') },
      ...(row.webUrl === undefined ? [] : [{ id: 'open', label: text('happier.plugin-ui.action.open', 'Open') }])]}
    onSecondaryAction={id => {
      if (id === 'viewed' && viewed !== null) void viewed.setViewed(row.path, !isViewed);
      else if (id === 'copy') void host.writeClipboard(row.path);
      else if (id === 'open' && row.webUrl !== undefined) void host.openExternalLink(row.webUrl); }}
    {...(row.diffAvailable ? {
      // A panel that is not showing holds no open row (its focus clears as it leaves): the row never lifts around a
      // body it would not draw.
      expanded: expanded && active,
      onPress: () => onFocusPath(expanded ? null : row.path),
      // Always present on a file with a diff, so a collapsed row is announced as expandable and keeps its element
      // (and focus) when it opens. The disclosure mounts this body only while open (and through its closing
      // motion); that mount is what reads the diff, and its unmount cancels the read.
      expandedContent: <FileBody key={row.path} row={row} input={input} />,
    } : {})} />;
}

/** GitHub facts feed the same public virtualized List family as GitLab. One path bounds disclosure. */
export function GithubFilesList(props: Readonly<{
  input: TriageDetailSurfaceInputV1;
  rows: readonly GithubChangedFileViewV1[];
  focusPath: string | null;
  onFocusPath: (path: string | null) => void;
  active: boolean;
  viewed: ScmFileViewedSource | null;
  header: React.ReactNode;
  /** Trailing content that scrolls with the rows (the paging control), never a fixed band under the scroller. */
  endContent?: React.ReactNode;
}>): React.ReactElement {
  // A band title names one band among others; a lone band is untitled (List draws no band for it), so the
  // collection keeps one sectioned shape, and its rows their state, when a later page adds a second band.
  const sections = React.useMemo(() => {
    const groups = groupGithubChangedFiles(orderGithubChangedFiles(props.rows));
    return groups.map(section => ({ key: section.band, title: groups.length < 2 ? '' : section.title, data: section.rows }));
  }, [props.rows]);
  const revealRequest = React.useMemo(() => props.focusPath === null ? undefined : { key: props.focusPath }, [props.focusPath]);
  // Single-line file rows stack flush, as an index does; the open row lifts out of them on its own margin.
  return <List accessibilityLabel="Files this pull request changes" accessibilityLabelKey="plugins.github.ui.filesLabel"
    density="flush" sections={sections} keyForItem={row => row.path} header={props.header} endContent={props.endContent}
    revealRequest={revealRequest}
    renderItem={row => <FileRow row={row} input={props.input} expanded={props.focusPath === row.path}
      onFocusPath={props.onFocusPath} active={props.active} viewed={props.viewed} />} />;
}
