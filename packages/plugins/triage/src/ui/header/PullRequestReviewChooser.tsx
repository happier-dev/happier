import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport, type ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import type { ReviewStartInput } from '@happier-dev/plugin-sdk/reviews';
import {
  Action,
  Button,
  Heading,
  Row,
  Stack,
  Status,
  usePluginHostApi,
  usePluginUiFocusTarget,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectPluginActionControlExecutionV1 } from '@happier-dev/plugin-ui/hostApi';

import { TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 } from '../../actions/entrySessionProtocol.js';
import { prepareTriagePullRequestReviewContinuationV1, settleTriagePullRequestReviewContinuationV1, type TriagePullRequestReviewContinuationOutcomeV1 } from '../../sessions/pullRequestReviewContinuation.js';
import { ActionFailureDetails } from '../ActionFailureDetails.js';
import { useLinkedSessionOpen } from '../detail/useLinkedSessionOpen.js';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import type { TriagePendingPullRequestReviewV1 } from './useEntrySessionStart.js';

type ReviewControlFailureV1 = Readonly<{
  code: string; message?: string; details?: ProtocolJsonValue; diagnostics?: readonly string[];
  requestId?: string; phase?: string; effectAttempted?: boolean;
}>;

type ReviewChooserPhaseV1 =
  | Readonly<{ kind: 'choosing' | 'starting' | 'settled' }>
  | Readonly<{ kind: 'failed'; failure: 'reviewRefused' | 'reviewUnknown' | 'open'; hostFailure?: ReviewControlFailureV1 }>;

export type TriagePullRequestReviewChooserPropsV1 = Readonly<{
  pending: TriagePendingPullRequestReviewV1;
  /** Retires the chooser after the canonical Session open succeeds. */
  onFinished: () => void;
}>;

/** The shared Review composer owns authoring; Triage retains selected-PR admission and Session recovery. */
export function TriagePullRequestReviewChooser(
  props: TriagePullRequestReviewChooserPropsV1,
): React.ReactElement {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const linkedSession = useLinkedSessionOpen();
  const recoveryFocus = usePluginUiFocusTarget();
  const [phase, setPhase] = React.useState<ReviewChooserPhaseV1>({ kind: 'choosing' });
  const compositionDraft = React.useRef<ReviewStartInput | undefined>(undefined);
  const operation = React.useRef(0);
  React.useEffect(() => () => { operation.current += 1; }, []);
  const failed = phase.kind === 'failed' ? phase : null;
  const mustOnlyOpen = failed?.failure === 'reviewUnknown' || failed?.failure === 'open';
  React.useEffect(() => {
    if (mustOnlyOpen) recoveryFocus.focus();
  }, [mustOnlyOpen, recoveryFocus]);

  const openSession = React.useCallback(async (): Promise<void> => {
    const currentOperation = operation.current + 1;
    operation.current = currentOperation;
    setPhase({ kind: 'settled' });
    const result = await linkedSession.open(props.pending.sessionId);
    if (operation.current !== currentOperation) return;
    if (result?.status === 'opened') {
      props.onFinished();
      return;
    }
    setPhase({ kind: 'failed', failure: 'open' });
  }, [linkedSession.open, props.onFinished, props.pending.sessionId]);

  const reviewController = (): PluginUiActionControlController => {
    let currentOperation = operation.current;
    const settleReview = async (continuation: TriagePullRequestReviewContinuationOutcomeV1, hostFailure?: ReviewControlFailureV1) => {
      if (operation.current !== currentOperation) return;
      if (continuation.kind === 'cancelled') { setPhase({ kind: 'choosing' }); return; }
      const failure = continuation.kind === 'settled' ? continuation.result.failure : continuation.failure;
      if (continuation.kind === 'settled' && continuation.result.status === 'refused') {
        setPhase({ kind: 'failed', failure: 'reviewRefused', hostFailure: failure === undefined ? undefined : {
          code: failure.codes[0] ?? 'unavailable', requestId: failure.requestId, diagnostics: failure.codes.slice(1),
        } });
        return;
      }
      if (failure !== undefined) void presentTriageMountedUiActionFailure(host, new PluginError({
        code: failure.codes[0] ?? 'unavailable',
        diagnostics: failure.codes.slice(1).map(code => ({ code, severity: 'error' })),
        ...(failure.requestId === undefined ? {} : { details: { requestId: failure.requestId } }),
      }), text, continuation.kind === 'settled' && continuation.result.status === 'accepted'
        ? text('plugins.triage.review.relationNotRecorded', 'Review started. Relation not recorded.') : undefined);
      if (continuation.kind === 'unknown') { setPhase({ kind: 'failed', failure: 'reviewUnknown', hostFailure }); return; }
      if (continuation.kind !== 'settled') {
        setPhase({ kind: 'failed', failure: 'reviewRefused', hostFailure }); return;
      }
      await openSession();
    };
    return {
      async prepare({ signal }) {
        currentOperation = operation.current + 1;
        operation.current = currentOperation;
        setPhase({ kind: 'starting' });
        const continuation = await prepareTriagePullRequestReviewContinuationV1(host, props.pending, undefined,
          { signal, draft: compositionDraft.current, isCurrent: () => operation.current === currentOperation });
        if (continuation.draft !== undefined) compositionDraft.current = continuation.draft;
        if (continuation.kind !== 'ready') { await settleReview(continuation); return null; }
        return { input: continuation.input };
      },
      onSettled(execution) {
        const projected = projectPluginActionControlExecutionV1(execution, text);
        if (projected.status === 'success') {
          void settleReview(settleTriagePullRequestReviewContinuationV1(projected.result));
          return;
        }
        const hostFailure = !execution.ok && (projected.status === 'error' || projected.status === 'outcomeUnknown') ? {
          code: execution.errorCode, message: execution.error, requestId: projected.requestId,
          phase: execution.failureCause?.phase, effectAttempted: execution.effectAttempted,
          details: projectNativeJsonValueForTransport({ details: projected.details,
            failureCause: projected.failureCause, remediation: projected.remediation }),
        } : undefined;
        void settleReview({ kind: projected.status === 'outcomeUnknown' ? 'unknown' : 'unavailable' }, hostFailure);
      },
    };
  };
  const canRetryReview = failed?.failure === 'reviewRefused';
  const notice = failed === null ? null : {
    labelKey: failed.failure === 'reviewRefused' ? 'plugins.triage.surface.reviewChooser.refused'
      : failed.failure === 'reviewUnknown' ? 'plugins.triage.surface.reviewChooser.unknown'
        : 'plugins.triage.surface.reviewChooser.openFailed',
    label: failed.failure === 'reviewRefused'
      ? 'The pull request changed or the review could not be started. The linked session is still available.'
      : failed.failure === 'reviewUnknown'
        ? 'Happier could not confirm whether the review started. It will not be started a second time.'
        : 'The linked session could not be opened.',
  };

  return (
    <Stack gap="small">
      <Heading level={3} value={text('plugins.triage.surface.reviewChooser.start', 'Start review')} />
      {phase.kind === 'starting' ? (
        <Status tone="muted" labelKey="plugins.triage.surface.reviewChooser.starting" label="Starting the review…" />
      ) : null}
      {phase.kind === 'settled' ? (
        <Status tone="muted" labelKey="plugins.triage.surface.reviewChooser.opening" label="Opening the session…" />
      ) : null}
      {notice === null ? null : failed?.hostFailure === undefined ? (
        <Status tone="warning" {...notice} />
      ) : (
        <ActionFailureDetails {...failed.hostFailure} inline={{ fallback: text(notice.labelKey, notice.label), diagnostics: failed.hostFailure.diagnostics }} />
      )}
      <Row gap="small" align="center" wrap>
        {phase.kind === 'choosing' || phase.kind === 'starting' || canRetryReview ? (
          <Action.Control
            action={{ pluginId: 'happier.triage', localId: TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 }}
            titleKey={canRetryReview ? 'plugins.triage.surface.loadMore.retry' : 'plugins.triage.surface.reviewChooser.start'}
            title={canRetryReview ? 'Try again' : 'Start review'}
            variant="primary"
            disabled={phase.kind === 'starting'}
            controller={reviewController()}
          />
        ) : null}
        {mustOnlyOpen ? (
          <Button titleKey="plugins.triage.surface.reviewChooser.open" title="Open session" variant="primary"
            focusTarget={recoveryFocus} onPress={() => { void openSession(); }} />
        ) : (
          <Button titleKey="plugins.triage.surface.actions.cancel" title="Cancel" variant="secondary"
            disabled={phase.kind === 'starting' || phase.kind === 'settled'}
            // The Session is already linked; cancelling only ends the optional Review continuation.
            onPress={() => { void openSession(); }} />
        )}
      </Row>
    </Stack>
  );
}
