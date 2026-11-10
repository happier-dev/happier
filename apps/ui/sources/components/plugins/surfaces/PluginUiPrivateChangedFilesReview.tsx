import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type {
  HappierChangedFile,
  HappierChangedFilesReviewRequest,
} from '@happier-dev/plugin-ui/presentation';

import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import type { ScmReviewUnifiedDiffFetcher } from '@/components/workspaces/scm/review/scmReviewDiffFetcher';
import { ChangedFilesLayoutSwitch } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { useScmComparisonLayout } from '@/components/projects/scm/useScmComparisonLayout';
import {
  projectChangedFilesAsScmSnapshot,
  type ScmFileStatus,
} from '@/scm/scmStatusFiles';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useScmReviewLimits } from '@/scm/review/useScmReviewLimits';

type ReviewProps = React.ComponentProps<typeof ChangedFilesReview>;
const NO_ATTRIBUTED_FILES: ReviewProps['sessionAttributedFiles'] = [];
const NO_FILES: ReviewProps['repositoryOnlyFiles'] = [];
const doNotOpenWorkingFile = () => {};
const FILL_STYLE = Object.freeze({ flex: 1, minHeight: 0 });
const GROW_STYLE = Object.freeze({ flex: 1 });

function toScmFileStatus(file: HappierChangedFile): ScmFileStatus {
  const segments = file.path.split('/');
  return {
    fileName: segments.at(-1) ?? file.path,
    filePath: segments.slice(0, -1).join('/'),
    fullPath: file.path,
    status: file.status,
    isIncluded: false,
    linesAdded: Math.max(0, file.additions ?? 0),
    linesRemoved: Math.max(0, file.deletions ?? 0),
    ...(file.previousPath ? { oldPath: file.previousPath } : {}),
    ...(file.binary === undefined ? {} : { isBinary: file.binary }),
    isComplete:
      file.diffUnavailableReason === undefined && file.binary !== true,
  };
}

/**
 * A plugin's changed files in the product's one changed-files review. The plugin lists its files and
 * answers one file's diff; Review decides which diffs to read (the prefetch window) and owns the index,
 * tree/list modes, continuous scroll, find and the source's Viewed marks. Read-only: no Keep/Discard.
 */
export function PluginUiPrivateChangedFilesReview(
  props: HappierChangedFilesReviewRequest,
): React.ReactElement {
  const { theme } = useUnistyles();
  const layout = useScmComparisonLayout();
  const { maxFiles, maxChangedLines } = useScmReviewLimits();
  const previous = React.useRef<{
    files: ScmFileStatus[];
    snapshot: ReturnType<typeof projectChangedFilesAsScmSnapshot>;
  } | null>(null);
  const projected = React.useMemo(() => {
    const files = retainDeep(
      previous.current?.files,
      props.files.map(toScmFileStatus),
    );
    const snapshot = retainDeep(
      previous.current?.snapshot,
      projectChangedFilesAsScmSnapshot(files, {
        projectKey: props.identity,
        rootPath: null,
      }),
    );
    return (previous.current = { files, snapshot });
  }, [props.files, props.identity]);
  const latest = React.useRef(props);
  latest.current = props;
  // A shortened diff says so beside it; the source's sentence arrives with the diff.
  const [truncated, setTruncated] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  React.useEffect(() => setTruncated(new Map()), [props.identity]);
  const fetchDiff = React.useCallback<ScmReviewUnifiedDiffFetcher>(
    async ({ path, signal }) => {
      const { files, loadDiff, identity } = latest.current;
      const file = files.find((entry) => entry.path === path);
      if (file?.diffUnavailableReason !== undefined)
        return {
          success: false,
          errorCode: 'result_unavailable',
          error: file.diffUnavailableReason,
        };
      const result = await loadDiff(
        path,
        signal ?? new AbortController().signal,
      );
      if (result.state === 'unavailable')
        return {
          success: false,
          errorCode: 'result_unavailable',
          error: result.reason,
        };
      if (
        result.state === 'truncated' &&
        latest.current.identity === identity
      ) {
        setTruncated((current) =>
          current.get(path) === result.reason
            ? current
            : new Map(current).set(path, result.reason),
        );
      }
      return { success: true, diff: result.unifiedDiff };
    },
    [],
  );
  const renderFileNotes = React.useCallback(
    (path: string) => {
      const reason = truncated.get(path);
      return reason ? (
        <Text
          testID={`plugin-changed-file-truncated-${path}`}
          style={{
            color: theme.colors.text.secondary,
            ...Typography.default(),
            padding: theme.space.s12,
          }}
        >
          {reason}
        </Text>
      ) : null;
    },
    [truncated, theme.colors.text.secondary, theme.space.s12],
  );
  const { indexPlacement } = layout;
  const leading = props.leadingContent;
  // On the index caption's inset, so the Viewed fact lines up with "Changed files" below it.
  const headerRowStyle = React.useMemo(() => ({
    flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.space.s8,
    paddingTop: theme.space.s6, paddingHorizontal: theme.space.s8 + theme.space.s12,
  }), [theme.space.s6, theme.space.s8, theme.space.s12]);
  const chrome = React.useMemo<NonNullable<ReviewProps['comparisonChrome']>>(
    () => ({
      renderBarLeading: () => null,
      // The file count is the review index's own caption (as in the Session review), so the header
      // adds no second one: only the source's Viewed fact, the list | tree switch and its notices.
      // The rail and the stream's floating file widget draw their own switch; only the phone's file
      // control has none, so there the header carries it.
      renderHeader: (_coverage, facts) => {
        const viewed = facts?.viewed ?? null;
        const layoutSwitch = indexPlacement === 'phone';
        const facts_row = viewed !== null || layoutSwitch ? (
          <View style={headerRowStyle}>
            {viewed}
            <View style={GROW_STYLE} />
            {layoutSwitch ? <ChangedFilesLayoutSwitch testIDPrefix="plugin-changed-files-layout" /> : null}
          </View>
        ) : null;
        return facts_row === null && (leading ?? null) === null ? null : <>{facts_row}{leading ?? null}</>;
      },
      indexPlacement,
      rootPath: null,
      renderFileNotes,
    }),
    [leading, indexPlacement, renderFileNotes, headerRowStyle],
  );
  const activeReviewFile = React.useMemo(
    () => ({ key: `plugin-review:${props.identity}`, presented: props.active }),
    [props.identity, props.active],
  );
  return (
    <View
      testID={props.testID}
      accessibilityLabel={props.label} style={FILL_STYLE} onLayout={layout.onLayout}>
      <ChangedFilesReview
        theme={theme}
        reviewScopeKey={`plugin-review:${props.identity}`}
        fetchUnifiedDiffForPath={fetchDiff}
        snapshot={projected.snapshot}
        changedFilesViewMode="repository"
        allRepositoryChangedFiles={projected.files}
        sessionAttributedFiles={NO_ATTRIBUTED_FILES}
        repositoryOnlyFiles={NO_FILES}
        maxFiles={maxFiles}
        maxChangedLines={maxChangedLines}
        onFilePress={doNotOpenWorkingFile}
        evidenceOnly
        comparisonChrome={chrome}
        activeReviewFile={activeReviewFile}
        {...(props.fileViewed === undefined
          ? {}
          : { fileViewed: props.fileViewed })}
        focusPath={props.focusPath ?? null}
        rowDensity="compact"
      />
      {props.trailingContent ?? null}
    </View>
  );
}
