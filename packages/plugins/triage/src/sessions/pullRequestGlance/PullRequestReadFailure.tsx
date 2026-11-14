import * as React from 'react';
import { ActionFailureDetails } from '../../ui/ActionFailureDetails.js';
import { readPluginErrorRequestIdV1 } from '@happier-dev/plugin-sdk';
import { ErrorState, Stack, usePluginTranslation } from '@happier-dev/plugin-ui';

import type { TriageSessionPullRequestProjectionSnapshotV1 } from '../sessionPullRequestStatus.js';

/** Both PR surfaces consume the shared Resource's refusal, including its diagnostic codes. */
export function PullRequestReadFailure(props: Readonly<{
  snapshot: TriageSessionPullRequestProjectionSnapshotV1;
  refresh(): unknown;
  testID: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { error, pending, value } = props.snapshot;
  const readError = pending === 'idle' ? error : undefined;
  const unavailable = value?.kind === 'unavailable' ? value : undefined;
  if (readError === undefined && unavailable === undefined) return null;
  const codes = readError === undefined ? [unavailable?.failure.code]
    : [readError.code, ...(readError.diagnostics ?? [])];
  const requestId = readPluginErrorRequestIdV1(readError);
  return <Stack gap="small">
    <ErrorState
      kind={readError === undefined ? 'unavailable' : 'error'}
      layout="line"
      testID={`${props.testID}.${readError === undefined ? 'unavailable' : 'error'}`}
      title={readError === undefined
        ? text('plugins.triage.prGlance.unavailable.title', 'Pull request status can’t be read')
        : text('plugins.triage.prGlance.readFailed', 'Couldn’t read this session’s pull request')}
      {...(readError === undefined ? {
        description: text('plugins.triage.prGlance.sessionUnavailable',
          'This session’s linked pull requests can’t be read right now. Links and watching are unchanged.'),
      } : {})}
      {...(readError === undefined || readError.retryable === false ? {} : {
        onRetry: props.refresh,
        retryLabel: text('plugins.triage.prGlance.retry', 'Try again'),
      })}
    />
    <PullRequestFailureDetails codes={codes} requestId={requestId} />
  </Stack>;
}

export function PullRequestFailureDetails(props: Readonly<{
  codes: readonly (string | undefined)[];
  requestId?: string;
  detail?: string;
  title?: string;
}>): React.ReactElement | null {
  const details = [...new Set(props.codes.filter(code => code !== undefined))].join('\n');
  return !details ? null : <ActionFailureDetails code={details} requestId={props.requestId} detail={props.detail}
    title={props.title} showReason={false} />;
}
