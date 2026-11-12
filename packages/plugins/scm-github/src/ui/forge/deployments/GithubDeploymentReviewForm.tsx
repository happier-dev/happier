import * as React from 'react';
import { projectForgeCiMutationExecutionV1 } from '@happier-dev/forge-ci/runtime';
import {
  ForgeCiStateNotice,
  readForgeOperationStateV1,
} from '@happier-dev/forge-ci/ui';
import {
  Banner,
  Action,
  Card,
  CheckStatusGlyph,
  Icon,
  IconButton,
  Row,
  Select,
  Stack,
  Text,
  TextField,
  usePluginTranslation,
  projectPluginActionControlExecutionV1,
  isPluginActionConfirmationDeclined,
} from '@happier-dev/plugin-ui';
import { type ForgeCiMutationResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { useGithubDeploymentReviewV1 } from '../../actions/useGithubDeploymentReview.js';

type Review = ReturnType<typeof useGithubDeploymentReviewV1>;
type Outcome = Readonly<{
  decision: 'approve' | 'reject';
  result: ForgeCiMutationResultV1;
}> | null;

/**
 * The one deployment review form (lab b3 `E`), shared by the deployment-review page and the run detail's waiting
 * deployment. The person names the environments and an optional comment, then approves or rejects directly: GitHub
 * owns who may approve and re-checks eligibility on submit. An accepted or confirmed answer asks for a fresh read;
 * an unknown answer offers a status check and never resends.
 */
export function GithubDeploymentReviewForm({
  review,
  testID,
  context,
  onClose,
}: Readonly<{
  review: Review;
  testID?: string;
  /** The run this card answers, said under its title where the card stands outside that run's detail. */
  context?: string;
  /** Folds the card back where it opened from a summary (the Actions banner). */
  onClose?: () => void;
}>): React.ReactElement | null {
  const t = usePluginTranslation();
  const eligible = React.useMemo(
    () => (review.pending?.rows ?? []).filter((row) => row.eligible),
    [review.pending],
  );
  // The run-summary entry can mount before its selected environment arrives.
  // Null means untouched; an explicit selection, including empty, remains the person's choice.
  const [environmentSelection, setEnvironmentIds] = React.useState<readonly string[] | null>(null);
  const environmentIds = environmentSelection ?? (review.selected?.eligible ? [review.selected.id] : []);
  const [comment, setComment] = React.useState('');
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome>(null);
  if (eligible.length === 0 && outcome === null) return null;

  const control = (decision: 'approve' | 'reject') => {
    const descriptor = review.reviewAction(decision, environmentIds, comment);
    if (descriptor === null) return null;
    return <Action.Control action={descriptor.action}
      title={decision === 'approve' ? t('plugins.github.deploymentReview.approve', 'Approve and deploy')
        : t('plugins.github.deploymentReview.reject', 'Reject')}
      variant={decision === 'approve' ? 'primary' : 'secondary'}
      disabled={!ready}
      controller={{
        prepare() {
          if (!ready) return null;
          setBusy(decision);
          return { input: descriptor.input };
        },
        async onSettled(execution) {
          const projected = projectPluginActionControlExecutionV1(execution, t);
          setBusy(null);
          if (isPluginActionConfirmationDeclined(projected)) return;
          const result = projectForgeCiMutationExecutionV1(descriptor.input, projected);
          if (result === null) return;
          setOutcome({ decision, result });
          if (result.kind === 'confirmed' || result.kind === 'accepted') {
            await Promise.all([review.runStatus.refresh(), review.pendingStatus.refresh()]);
          }
        },
      }} />;
  };

  if (
    outcome !== null &&
    (outcome.result.kind === 'confirmed' || outcome.result.kind === 'accepted')
  ) {
    const names = eligible
      .filter((row) => environmentIds.includes(row.id))
      .map((row) => row.environment.name)
      .join(', ');
    return (
      <Banner
        tone="neutral"
        presentation="strip"
        testID={testID}
        title={
          outcome.decision === 'approve'
            ? t(
                'plugins.github.deploymentReview.approved',
                'You approved {environments}',
                { environments: names },
              )
            : t(
                'plugins.github.deploymentReview.rejected',
                'You rejected {environments}',
                { environments: names },
              )
        }
        {...(comment.trim() === ''
          ? {}
          : { description: `“${comment.trim()}”` })}
      />
    );
  }

  const options = eligible.map((row) => ({
    value: row.id,
    label: row.environment.name,
    ...(row.reviewers === undefined || row.reviewers.length === 0
      ? {}
      : {
          description: t(
            'plugins.github.deploymentReview.whoCanApprove',
            '{reviewers} can approve',
            { reviewers: row.reviewers.join(', ') },
          ),
        }),
  }));
  const ready = environmentIds.length > 0 && review.canReview && busy === null && outcome?.result.kind !== 'outcome_unknown';
  return (
    <Card testID={testID}>
      <Stack gap="medium">
        <Row gap="small" align="flex-start" justify="space-between">
          <CheckStatusGlyph status="waiting" />
          <Stack gap="xsmall" style={headingStyle}>
            <Text
              value={t(
                'plugins.github.deploymentReview.form.title',
                'Review deployment',
              )}
              variant="heading"
            />
            {context === undefined ? null : (
              <Text tone="secondary" variant="meta" value={context} numberOfLines={1} />
            )}
          </Stack>
          {onClose === undefined ? null : (
            <IconButton
              icon={<Icon name="close" size="small" tone="secondary" />}
              accessibilityLabel={t('plugins.github.deploymentReview.close', 'Close review')}
              onPress={onClose}
            />
          )}
        </Row>
        <Select
          presentation="inline"
          multiple
          label={t(
            'plugins.github.deploymentReview.environments',
            'Environments',
          )}
          options={options}
          value={environmentIds}
          onChange={(value) =>
            setEnvironmentIds(
              Array.isArray(value) ? value.map(String) : [String(value)],
            )
          }
        />
        <TextField
          multiline
          label={t('plugins.github.deploymentReview.comment', 'Comment')}
          placeholder={t(
            'plugins.github.deploymentReview.comment.placeholder',
            'Add a note for the run (optional)',
          )}
          value={comment}
          onChange={setComment}
        />
        {outcome?.result.kind === 'rejected' ? (
          <ForgeCiStateNotice
            presentation="banner"
            state={readForgeOperationStateV1({
              failure: outcome.result.failure,
              hasRetainedValue: true,
            })}
            about={{
              forgeName: 'GitHub',
              subject: t(
                'plugins.github.deploymentReview.subject',
                'this deployment',
              ),
            }}
          />
        ) : null}
        {outcome?.result.kind === 'outcome_unknown' ? (
          <ForgeCiStateNotice
            presentation="banner"
            state={readForgeOperationStateV1({
              mutation: outcome.result,
              hasRetainedValue: true,
            })}
            about={{
              forgeName: 'GitHub',
              subject: t(
                'plugins.github.deploymentReview.subject',
                'this deployment',
              ),
            }}
            onCheckStatus={() =>
              Promise.all([
                review.runStatus.refresh(),
                review.pendingStatus.refresh(),
              ])
            }
          />
        ) : null}
        <Row gap="small" align="center" justify="space-between" wrap>
          <Text
            tone="secondary"
            variant="meta"
            value={t(
              'plugins.github.deploymentReview.note',
              'GitHub decides who may approve. The run continues as soon as one reviewer approves.',
            )}
          />
          <Row gap="small" align="center">
            {control('reject')}
            {control('approve')}
          </Row>
        </Row>
      </Stack>
    </Card>
  );
}

const headingStyle = { flexGrow: 1, flexShrink: 1, minWidth: 0 } as const;
