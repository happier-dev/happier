import * as React from 'react';
import { ComposerSurfaceInputV1Schema } from '@happier-dev/plugin-sdk/ui';
import {
  Popover,
  Row,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import {
  useTriageSessionPullRequestStatusV1,
  type TriageSessionPullRequestBindingV1,
  type TriageSessionPullRequestProjectionSnapshotV1,
} from '../sessions/sessionPullRequestStatus.js';
import { projectPullRequestGlanceV1 } from '../sessions/pullRequestGlance/glanceModel.js';
import { checksFact, mergeFact, reviewFact, watchLineText } from '../sessions/pullRequestGlance/factPresentation.js';

const selectSnapshot = (snapshot: TriageSessionPullRequestProjectionSnapshotV1) => snapshot;

function PullRequestStatus(props: Readonly<{
  binding: TriageSessionPullRequestBindingV1;
  renderDetails(bindingId: string, onResourceOpened: () => void): React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const model = projectPullRequestGlanceV1(props.binding);
  const unavailable = text('plugins.triage.surface.merge.line.unavailable', 'Status unavailable');
  const fact = model.freshness.kind === 'unavailable' ? unavailable
    : model.freshness.kind === 'stale' ? text('plugins.triage.surface.row.stale', 'Stale')
      : model.checks.kind === 'failing' || model.checks.kind === 'running' ? checksFact(text, model.checks).value
        : model.merge.kind !== 'unknown' ? mergeFact(text, model.merge, model.branch?.base ?? null).value
          : model.review.kind === 'changesRequested' || model.review.kind === 'reviewRequired' ? reviewFact(text, model.review).value
            : model.checks.kind !== 'unknown' ? checksFact(text, model.checks).value : unavailable;
  const watch = model.watch;
  const watchDetail = watch.kind === 'fixing' || watch.kind === 'exhausted'
    || watch.kind === 'credentials' || watch.kind === 'paused'
    ? watchLineText(text, watch, null).value : null;
  const label = `PR #${model.number} · ${fact}${watchDetail === null ? '' : ` · ${watchDetail}`}`;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={label}
      triggerAppearance="composerStatus"
      triggerComposerStatus={{
        tone: watch.kind === 'exhausted' || watch.kind === 'credentials' ? 'warning'
          : watch.kind === 'fixing' ? 'active'
            : model.freshness.kind !== 'current' || watch.kind === 'paused' ? 'paused'
              : model.checks.kind === 'running' ? 'active' : 'neutral',
        emphasis: 'prominent',
      }}
      triggerIcon="branch"
      triggerAccessibilityLabel={`${model.repository} · ${label}`}
      sheet={{ title: text('plugins.triage.prGlance.selectLabel', 'Pull request') }}
      testID={`pr-composer.${props.binding.bindingId}`}
    >
      {open ? props.renderDetails(props.binding.bindingId, () => setOpen(false)) : null}
    </Popover>
  );
}

/** A compact view of the same joined Resource and glance, never a second status/readiness owner. */
export function TriageSessionPullRequestComposer(props: Readonly<{
  launchInput: unknown;
  renderDetails(bindingId: string, onResourceOpened: () => void): React.ReactNode;
}>): React.ReactElement | null {
  const { target } = useSurfaceContext();
  const input = React.useMemo(() => ComposerSurfaceInputV1Schema.safeParse(props.launchInput), [props.launchInput]);
  const sessionId = target.kind === 'session' ? target.sessionId : null;
  const admitted = input.success && input.data.role === 'region'
    && input.data.regionLocalId === 'session-pull-request-status'
    && input.data.composer.kind === 'session' && input.data.composer.sessionId === sessionId;
  const { value: snapshot } = useTriageSessionPullRequestStatusV1(selectSnapshot, admitted);
  const result = snapshot.value;
  // The strip speaks only after the shared Resource confirms a Session link.
  // A known PR's unavailable native status is presented by its own badge below.
  if (!admitted || result?.kind !== 'ready' || result.sessionId !== sessionId
    || result.pullRequests.length === 0) return null;
  return (
    <Row gap="xsmall" wrap>
      {result.pullRequests.map(binding => <PullRequestStatus
        key={binding.bindingId} binding={binding} renderDetails={props.renderDetails}
      />)}
    </Row>
  );
}
