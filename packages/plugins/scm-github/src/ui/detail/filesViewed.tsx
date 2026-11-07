import * as React from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import {
  Checkbox,
  Row,
  Text,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import {
  useScmFileViewed,
  useScmFileViewedFile,
  useScmFileViewedStatus,
} from '@happier-dev/plugin-ui/hostApi';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';

import { buildGithubPullRequestComparisonSourceV1 } from '../../triage/mapping/protocol.js';

/**
 * The PR's Viewed source for the native Files panel: the host's one Viewed owner for this Account, PR
 * and head, the same source core's PR Files joins. Null until it answers for the current head.
 */
export function useGithubFileViewedSource(
  input: TriageDetailSurfaceInputV1): ScmFileViewedSource | null {
  const surface = useSurfaceContext();
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = input.observation.locator.routingToken;
  const baseSha = input.observation.snapshot.reviewRevision?.baseSha;
  const headSha = input.observation.snapshot.reviewRevision?.headSha;
  const comparison = React.useMemo(() => {
    const revision =
      baseSha === undefined || headSha === undefined
        ? null
        : { baseSha, headSha };
    const source = buildGithubPullRequestComparisonSourceV1({
      instance,
      localRef,
      routingToken,
      revision,
    });
    return source === null || revision === null
      ? null
      : {
          source,
          freshness: 'current' as const,
          endpoints: { before: revision.baseSha, after: revision.headSha },
        };
  }, [instance, localRef, routingToken, baseSha, headSha]);
  const { target } = surface;
  const host =
    target.kind === 'session'
      ? { sessionId: target.sessionId }
      : target.kind === 'machine'
        ? { machineId: target.machineId }
        : null;
  const serverId =
    surface.accountScope?.serverId ??
    (target.kind === 'machine' ? target.serverId : null);
  return useScmFileViewed({ comparison, serverId, host });
}

/**
 * One file's Viewed mark, GitHub's labelled checkbox at the row's end: viewed is checked, unviewed is
 * unchecked, dismissed (changed after it was viewed) is unchecked with a quiet note. Until GitHub has
 * answered for this file the slot stays reserved and empty. A toggle shows its spinner in the box; a
 * refused write keeps the previous mark and says it was not saved.
 */
export const GithubFileViewedMark = React.memo(function GithubFileViewedMark({
  source,
  path,
}: Readonly<{
  source: ScmFileViewedSource;
  path: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const file = useScmFileViewedFile(source, path);
  const name = path.split('/').pop() ?? path;
  // One note at most: a refused write outranks "changed since viewed".
  const note =
    file.state === null
      ? null
      : file.errorCode !== null
        ? {
            tone: 'danger' as const,
            value: text(
              'plugins.github.ui.file.viewedNotSaved',
              'Not saved to GitHub',
            ),
          }
        : file.state === 'dismissed'
          ? {
              tone: 'muted' as const,
              value: text(
                'plugins.github.ui.file.viewedChanged',
                'Changed since viewed',
              ),
            }
          : null;
  return (
    <Row gap="small" align="center">
      {note === null ? null : (
        <Text
          variant="meta"
          tone={note.tone}
          numberOfLines={1}
          value={note.value}
        />
      )}
      <Checkbox
        testID={`github-file-viewed-${path}`}
        size="compact"
        checked={file.state === null ? null : file.state === 'viewed'}
        pending={file.pending}
        label={text('plugins.github.ui.file.viewed', 'Viewed')}
        accessibilityLabel={text(
          'plugins.github.ui.file.viewedA11y',
          '{name}, viewed on GitHub',
          { name },
        )}
        onChange={(viewed) => {
          void source.setViewed(path, viewed);
        }}
      />
    </Row>
  );
});

/**
 * The panel's coverage line ("3 of 9 viewed"): GitHub's own count, not the person's local marks. An
 * unavailable source says so once, here, instead of on every row.
 */
export function GithubFilesViewedFact({
  source,
  total,
}: Readonly<{
  source: ScmFileViewedSource;
  total: number;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const status = useScmFileViewedStatus(source);
  const count = React.useSyncExternalStore(
    React.useCallback(
      (listener: () => void) => source.subscribeChanges(() => listener()),
      [source],
    ),
    () => source.getViewedPaths().size,
    () => source.getViewedPaths().size,
  );
  if (status.status === 'error') {
    return (
      <Text
        testID="github-files-viewed-unavailable"
        variant="meta"
        tone="secondary"
        value={text(
          'plugins.github.ui.file.viewedUnavailable',
          'Viewed unavailable',
        )}
      />
    );
  }
  if (status.headOid === null) return null;
  return (
    <Text
      testID="github-files-viewed-count"
      variant="meta"
      tone={total > 0 && count >= total ? 'success' : 'secondary'}
      value={text(
        'plugins.github.ui.file.viewedCount',
        '{count} of {total} viewed',
        { count, total },
      )}
    />
  );
}
