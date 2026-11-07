import * as React from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';
import { useSurfaceContext } from '@happier-dev/plugin-ui';
import { useScmFileViewed } from '@happier-dev/plugin-ui/hostApi';
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
