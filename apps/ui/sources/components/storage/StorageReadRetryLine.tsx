import * as React from 'react';

import type { ArtifactActionFailure } from '@/components/artifacts/artifactActionsClient';
import { presentArtifactActionFailure } from '@/components/artifacts/artifactActionFailure';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { showActionFailureDetails } from '@/utils/errors/alertActionFailure';

/**
 * A Storage read that failed while what was already read stays listed (the next page, a page's file names): the
 * shared stale-content line says what could not be read, with its one Retry, and keeps the refusal's typed cause one
 * press away under Technical details, as Artifact history does. Retry is the caller's same read; nothing retries on its
 * own. The sentence names the read, not the cause: a cause's generic copy ("Unavailable") would blur into the rows'
 * own "Not available to you".
 */
export function StorageReadRetryLine(
  props: Readonly<{
    testID: string;
    /** What could not be read ("The rest couldn’t be read."). */
    reason: string;
    failure: ArtifactActionFailure;
    onRetry: () => void;
    /** The same read is asked again: the line keeps its words and shows the ring. */
    busy?: boolean;
  }>,
): React.ReactElement {
  const { failure, onRetry } = props;
  const actions = React.useMemo(
    () => [
      {
        label: t('common.retry'),
        onPress: onRetry,
        testID: `${props.testID}:retry`,
      },
      {
        label: t('approvals.technicalDetails'),
        onPress: () =>
          showActionFailureDetails(presentArtifactActionFailure(failure, '')),
        testID: `${props.testID}:details`,
      },
    ],
    [failure, onRetry, props.testID],
  );
  return (
    <SurfaceFreshnessLine
      testID={props.testID}
      reason={props.reason}
      tone="warning"
      busy={props.busy === true}
      actions={actions}
    />
  );
}
