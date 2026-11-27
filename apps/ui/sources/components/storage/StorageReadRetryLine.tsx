import * as React from 'react';

import type { ArtifactActionFailure } from '@/components/artifacts/artifactActionsClient';
import { presentArtifactActionFailure } from '@/components/artifacts/artifactActionFailure';
import { StorageSaySection } from '@/components/storage/StorageSayLine';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { showActionFailureDetails } from '@/utils/errors/alertActionFailure';

export function StorageFirstReadFailureSection(props: Readonly<{
  testID: string;
  failure?: ArtifactActionFailure | null;
  onRetry: () => void;
}>) {
  const { testID, failure, onRetry } = props;
  return (
    <StorageSaySection
      testID={`${testID}:say`}
      lead={t('artifacts.browser.storageView.say.failed')}
      text={t('artifacts.browser.storageView.say.failedBody')}
      trailing={<>
        <TextLinkButton testID={`${testID}:retry`} tone="strong" label={t('common.retry')} onPress={onRetry} />
        {failure ? <> <TextLinkButton
          testID={`${testID}:first-failed:details`}
          label={t('approvals.technicalDetails')}
          onPress={() => showActionFailureDetails(presentArtifactActionFailure(failure, ''))}
        /></> : null}
      </>}
    />
  );
}

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
