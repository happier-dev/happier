import * as React from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import { DiffViewer, LoadingState, Stack, Text, usePluginTranslation } from '@happier-dev/plugin-ui';
import { TriageChangedFilesList, type TriageChangedFilesViewedV1 } from '@happier-dev/triage-sources/ui';
import type { TriageChangedFileV1 } from '@happier-dev/triage-sources/ui';
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
 * deleted or renamed file, or one GitHub sent no diff for, says so (the shared row adds the Viewed mark).
 */
function fileNote(text: PluginTranslate, row: GithubChangedFileViewV1): string | undefined {
  const status = row.status === 'renamed' && row.previousPath !== undefined
    ? text('plugins.github.ui.fileRenamedFrom', 'Renamed from {previous}', { previous: row.previousPath })
    : GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status] === undefined ? undefined
      : text(githubChangedFileStatusKey(row.status), GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status]!);
  const noDiff = row.diffAvailable ? undefined : text('plugins.github.ui.fileDiffNone', 'GitHub has no diff for this file.');
  return [status, noDiff].filter(Boolean).join(' · ') || undefined;
}

/** A GitHub file as the shared Files frame reads it, keeping the GitHub row its diff read needs. */
type GithubFilesRowV1 = TriageChangedFileV1 & Readonly<{ github: GithubChangedFileViewV1 }>;

function toFilesRow(text: PluginTranslate, row: GithubChangedFileViewV1): GithubFilesRowV1 {
  const note = fileNote(text, row);
  return {
    path: row.path,
    lines: { additions: row.additions, deletions: row.deletions },
    diffAvailable: row.diffAvailable,
    ...(note === undefined ? {} : { note }),
    ...(row.webUrl === undefined ? {} : { webUrl: row.webUrl }),
    github: row,
  };
}

/** GitHub facts feed the shared Files frame: its Source and Generated bands, its notes and its Viewed marks. */
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
  // One frame row per GitHub row, kept while that row is: a later page re-bands the files without re-keying the rows
  // already drawn.
  const framed = React.useMemo(() => new WeakMap<GithubChangedFileViewV1, GithubFilesRowV1>(), [text]);
  const sections = React.useMemo(() => groupGithubChangedFiles(orderGithubChangedFiles(props.rows)).map(section => ({
    key: section.band, title: section.title, data: section.rows.map(row => {
      const existing = framed.get(row);
      if (existing !== undefined) return existing;
      const next = toFilesRow(text, row);
      framed.set(row, next);
      return next;
    }),
  })), [props.rows, framed, text]);
  const viewed = React.useMemo<TriageChangedFilesViewedV1 | null>(() => props.viewed === null ? null : {
    source: props.viewed,
    labels: {
      viewed: text('plugins.github.ui.fileViewed', 'Viewed'),
      notSaved: text('plugins.github.ui.fileViewedNotSaved', 'Not saved to GitHub'),
    },
  }, [props.viewed, text]);
  const { input } = props;
  const renderBody = React.useCallback((row: GithubFilesRowV1) => <FileBody row={row.github} input={input} />, [input]);
  return <TriageChangedFilesList accessibilityLabel="Files this pull request changes" accessibilityLabelKey="plugins.github.ui.filesLabel"
    sections={sections} focusPath={props.focusPath} onFocusPath={props.onFocusPath} active={props.active}
    viewed={viewed} renderBody={renderBody} header={props.header} endContent={props.endContent} />;
}
