import * as React from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import { Button, DiffViewer, List, LoadingState, Stack, Text, formatHappierDiffStat,
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
 * deleted or renamed file, or one GitHub sent no diff for, says so.
 */
function fileNote(text: PluginTranslate, row: GithubChangedFileViewV1): string | undefined {
  const status = row.status === 'renamed' && row.previousPath !== undefined
    ? text('plugins.github.ui.fileRenamedFrom', 'Renamed from {previous}', { previous: row.previousPath })
    : GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status] === undefined ? undefined
      : text(githubChangedFileStatusKey(row.status), GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status]!);
  const noDiff = row.diffAvailable ? undefined : text('plugins.github.ui.fileDiffNone', 'GitHub has no diff for this file.');
  return [status, noDiff].filter(Boolean).join(' · ') || undefined;
}

/** Path-scoped subscription to the existing host Viewed owner, without another map. */
function Viewed({ source, path }: Readonly<{ source: ScmFileViewedSource; path: string }>) {
  const subscribe = React.useCallback((notify: () => void) => source.subscribeFile(path, notify), [source, path]);
  const snapshot = React.useCallback(() => source.getFile(path), [source, path]);
  const file = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  return <Stack gap="small">
    <Button title={file.state === 'viewed' ? 'Mark unviewed' : 'Mark viewed'} variant="secondary"
      busy={file.pending} onPress={() => { void source.setViewed(path, file.state !== 'viewed'); }} />
    {file.errorCode === null ? null : <Text value={file.errorCode} />}
  </Stack>;
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
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { locale } = useSurfaceContext();
  // A band title names one band among others; a lone band is untitled (List draws no band for it), so the
  // collection keeps one sectioned shape, and its rows their state, when a later page adds a second band.
  const sections = React.useMemo(() => {
    const groups = groupGithubChangedFiles(orderGithubChangedFiles(props.rows));
    return groups.map(section => ({ key: section.band, title: groups.length < 2 ? '' : section.title, data: section.rows }));
  }, [props.rows]);
  const revealRequest = React.useMemo(() => props.focusPath === null ? undefined : { key: props.focusPath }, [props.focusPath]);
  return <List accessibilityLabel="Files this pull request changes" accessibilityLabelKey="plugins.github.ui.filesLabel"
    sections={sections} keyForItem={row => row.path} header={props.header} endContent={props.endContent}
    revealRequest={revealRequest}
    renderItem={row => {
      const counts = formatHappierDiffStat(row.additions, row.deletions, { locale });
      const expanded = props.focusPath === row.path;
      const note = fileNote(text, row);
      return <List.Item title={row.path} titleEllipsizeMode="middle"
        {...(note === undefined ? {} : { subtitle: note })}
        detail={[counts.added, counts.removed].filter(value => value !== null).join(' ')}
        expanded={expanded} onPress={() => props.onFocusPath(expanded ? null : row.path)}
        secondaryActions={[{ id: 'copy', label: text('happier.plugin-ui.action.copy', 'Copy') },
          ...(row.webUrl === undefined ? [] : [{ id: 'open', label: text('happier.plugin-ui.action.open', 'Open') }])]}
        onSecondaryAction={id => { if (id === 'copy') void host.writeClipboard(row.path);
          else if (id === 'open' && row.webUrl !== undefined) void host.openExternalLink(row.webUrl); }}
        // Always present, so a collapsed row is announced as expandable and keeps its element (and focus) when it
        // opens. The disclosure mounts this body only while open (and through its closing motion); that mount is
        // what reads the diff, and its unmount cancels the read.
        expandedContent={<Stack gap="small">
          {props.viewed === null ? null : <Viewed source={props.viewed} path={row.path} />}
          {props.active && row.diffAvailable ? <FileBody key={row.path} row={row} input={props.input} /> : null}
        </Stack>} />;
    }} />;
}
