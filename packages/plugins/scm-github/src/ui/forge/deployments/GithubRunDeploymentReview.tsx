import * as React from 'react';
import type { ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import {
  useForgeCiQueryV1,
  useForgeCiQueryValueV1,
} from '@happier-dev/forge-ci/ui';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { useGithubDeploymentReviewV1 } from '../../actions/useGithubDeploymentReview.js';
import { GithubDeploymentReviewForm } from './GithubDeploymentReviewForm.js';

/**
 * The same review card inside a waiting run's detail (Actions pane/page, lab a2/a4): the run's pending
 * environments come from the one shared `listDeployments` query the review hook also reads, and the card opens on
 * the first environment the person may answer. Nothing renders when none is eligible.
 */
export function GithubRunDeploymentReview({
  reads,
  repository,
  run,
  context,
  onClose,
}: Readonly<{
  reads: ForgeCiReadsV1 | null;
  repository: ScmHostingRepositoryIdentityV1;
  run: ForgeCiRunV1;
  /** Which run this is, when the card stands outside that run's detail (the Actions banner). */
  context?: string;
  onClose?: () => void;
}>): React.ReactElement | null {
  const pending = useForgeCiQueryValueV1(
    useForgeCiQueryV1(reads, 'listDeployments', {
      repository,
      runId: run.ref.runId,
    }),
  );
  const attempt = run.currentAttempt?.attemptId;
  const environmentId = pending?.rows.find((row) => row.eligible)?.id;
  if (attempt === undefined || environmentId === undefined) return null;
  return (
    <Review
      reads={reads}
      repository={repository}
      location={{ runId: run.ref.runId, attempt, environmentId }}
      {...(context === undefined ? {} : { context })}
      {...(onClose === undefined ? {} : { onClose })}
    />
  );
}

function Review({
  reads,
  repository,
  location,
  context,
  onClose,
}: Readonly<{
  reads: ForgeCiReadsV1 | null;
  repository: ScmHostingRepositoryIdentityV1;
  location: Readonly<{ runId: string; attempt: string; environmentId: string }>;
  context?: string;
  onClose?: () => void;
}>): React.ReactElement | null {
  const review = useGithubDeploymentReviewV1({ reads, repository, location });
  return (
    <GithubDeploymentReviewForm
      review={review}
      {...(context === undefined ? {} : { context })}
      {...(onClose === undefined ? {} : { onClose })}
      testID={`github.actions.run.${location.runId}.review`}
    />
  );
}
