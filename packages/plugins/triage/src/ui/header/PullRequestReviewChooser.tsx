import * as React from 'react';
import { PluginError } from '@happier-dev/plugin-sdk';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';
import { resolveReviewNarratorPolicy } from '@happier-dev/plugin-sdk/reviews';
import {
  Action,
  Button,
  Form,
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
import { useLinkedSessionOpen } from '../detail/useLinkedSessionOpen.js';
import {
  readAvailableEngineOptions,
  type TriageReviewEngineOptionV1,
} from '../../sessions/reviewEngineOptions.js';
import type { TriagePendingPullRequestReviewV1 } from './useEntrySessionStart.js';

type ReviewChooserFailureV1 =
  | 'engineList'
  | 'reviewRefused'
  /** Some chosen engines started and some did not; only the latter may repeat. */
  | 'reviewPartial'
  | 'reviewUnknown'
  | 'open';

type ReviewChooserPhaseV1 =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'loadingEngines' }>
  | Readonly<{
      kind: 'choosing';
      options: readonly TriageReviewEngineOptionV1[];
      selected: readonly string[];
    }>
  | Readonly<{
      kind: 'starting';
      options: readonly TriageReviewEngineOptionV1[];
      selected: readonly string[];
    }>
  | Readonly<{ kind: 'settled' }>
  | Readonly<{
      kind: 'failed';
      failure: ReviewChooserFailureV1;
      options: readonly TriageReviewEngineOptionV1[];
      selected: readonly string[];
    }>;

const IDLE: ReviewChooserPhaseV1 = Object.freeze({ kind: 'idle' });
const LOADING: ReviewChooserPhaseV1 = Object.freeze({ kind: 'loadingEngines' });

export type TriagePullRequestReviewChooserPropsV1 = Readonly<{
  pending: TriagePendingPullRequestReviewV1;
  /** Retires the chooser after the canonical Session open succeeds. */
  onFinished: () => void;
}>;

/**
 * The one mounted consumer of a selected-PR review continuation.
 *
 * It owns only the human interaction between the already-linked Session and
 * the daemon-owned verification/start Action: current engine read, explicit
 * selection, phase-local retry, focus transfer and the final canonical open.
 * It owns no engine registry, source reread, SCM scope, review fan-out, Session
 * creation/link or navigation implementation.
 */
export function TriagePullRequestReviewChooser(
  props: TriagePullRequestReviewChooserPropsV1,
): React.ReactElement {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const linkedSession = useLinkedSessionOpen();
  const engineFocus = usePluginUiFocusTarget();
  const recoveryFocus = usePluginUiFocusTarget();
  const [phase, setPhase] = React.useState<ReviewChooserPhaseV1>(IDLE);
  const [walkthrough, setWalkthrough] = React.useState(true);
  const [narratorEngineId, setNarratorEngineId] = React.useState<string | null>(null);
  const operation = React.useRef(0);

  const loadEngines = React.useCallback(async (): Promise<void> => {
    const currentOperation = operation.current + 1;
    operation.current = currentOperation;
    setPhase(LOADING);
    try {
      const raw = await host.executeAction('review.engines.list', {
        sessionId: props.pending.sessionId,
      });
      if (operation.current !== currentOperation) return;
      const options = readAvailableEngineOptions(raw, props.pending.sessionId);
      if (options === null) {
        setPhase({ kind: 'failed', failure: 'engineList', options: [], selected: [] });
        return;
      }
      setPhase({ kind: 'choosing', options, selected: [] });
    } catch (error) {
      if (operation.current === currentOperation) {
        setPhase({ kind: 'failed', failure: 'engineList', options: [], selected: [] });
        await presentTriageMountedUiActionFailure(host, error, text);
      }
    }
  }, [host, props.pending.sessionId, text]);

  React.useEffect(() => {
    void loadEngines();
    return () => { operation.current += 1; };
  }, [loadEngines]);

  const focusDestination = phase.kind === 'choosing'
    ? phase.options.length > 0 ? 'engines' : 'recovery'
    : phase.kind === 'failed' ? 'recovery' : null;
  React.useEffect(() => {
    if (focusDestination === 'engines') engineFocus.focus();
    if (focusDestination === 'recovery') recoveryFocus.focus();
  }, [engineFocus, focusDestination, recoveryFocus]);

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
    setPhase({ kind: 'failed', failure: 'open', options: [], selected: [] });
  }, [linkedSession.open, props.onFinished, props.pending.sessionId]);

  const reviewController = (
    options: readonly TriageReviewEngineOptionV1[],
    selected: readonly string[],
    writeWalkthrough = walkthrough,
  ): PluginUiActionControlController => {
    let currentOperation = operation.current;
    const settleReview = async (continuation: TriagePullRequestReviewContinuationOutcomeV1) => {
      if (operation.current !== currentOperation) return;
      if (continuation.kind === 'cancelled') { setPhase({ kind: 'choosing', options, selected }); return; }
      const failure = continuation.kind === 'settled'
        ? continuation.result.status === 'refused' ? continuation.result.failure : undefined
        : continuation.failure;
      if (failure !== undefined) void presentTriageMountedUiActionFailure(host, new PluginError({
        code: failure.codes[0] ?? 'unavailable',
        diagnostics: failure.codes.slice(1).map(code => ({ code, severity: 'error' })),
        ...(failure.requestId === undefined ? {} : { details: { requestId: failure.requestId } }),
      }), text);
      if (continuation.kind === 'unknown') { setPhase({ kind: 'failed', failure: 'reviewUnknown', options, selected }); return; }
      if (continuation.kind !== 'settled' || continuation.result.status !== 'started') {
        setPhase({ kind: 'failed', failure: 'reviewRefused', options, selected }); return;
      }
      if (continuation.result.failedEngineIds.length > 0) {
        setPhase({ kind: 'failed', failure: 'reviewPartial', options, selected: [...continuation.result.failedEngineIds] }); return;
      }
      await openSession();
    };
    return {
      async prepare({ signal }) {
        if (selected.length === 0) return null;
        const policy = resolveReviewNarratorPolicy({ selectedEngineIds: selected, engines: options });
        const candidates = options.filter((option) => option.capabilities.structuredNarration);
        const narrator = candidates.find((option) => option.value === narratorEngineId)
          ?? candidates.find((option) => option.value === policy.defaultNarratorEngineId)
          ?? candidates[0];
        if (writeWalkthrough && (props.pending.comparisonSource === undefined || narrator === undefined)) return null;
        currentOperation = operation.current + 1;
        operation.current = currentOperation;
        setPhase({ kind: 'starting', options, selected });
        const continuation = await prepareTriagePullRequestReviewContinuationV1(host, props.pending, {
          engineIds: [...selected],
          ...(writeWalkthrough ? {
            outputs: ['walkthrough'], comparisonSource: props.pending.comparisonSource,
            ...(policy.requiresSeparateNarrator ? { narrator: { engineId: narrator!.value } } : {}),
          } : {}),
        }, { signal, isCurrent: () => operation.current === currentOperation });
        if (continuation.kind !== 'ready') { await settleReview(continuation); return null; }
        return { input: continuation.input };
      },
      onSettled(execution) {
        const projected = projectPluginActionControlExecutionV1(execution, text);
        void settleReview(projected.status === 'success'
          ? settleTriagePullRequestReviewContinuationV1(projected.result)
          : { kind: projected.status === 'outcomeUnknown' ? 'unknown' : 'unavailable' });
      },
    };
  };

  const choosing = phase.kind === 'choosing' ? phase : null;
  const failed = phase.kind === 'failed' ? phase : null;
  const options = choosing?.options ?? failed?.options ?? (phase.kind === 'starting' ? phase.options : []);
  const selected = choosing?.selected ?? failed?.selected ?? (phase.kind === 'starting' ? phase.selected : []);
  const canRetryReview = failed?.failure === 'reviewRefused' || failed?.failure === 'reviewPartial';
  const mustOnlyOpen = failed?.failure === 'reviewUnknown' || failed?.failure === 'open';
  const narratorPolicy = resolveReviewNarratorPolicy({ selectedEngineIds: selected, engines: options });
  const narratorOptions = options.filter((option) => option.capabilities.structuredNarration);
  const chosenNarrator = narratorOptions.find((option) => option.value === narratorEngineId)
    ?? narratorOptions.find((option) => option.value === narratorPolicy.defaultNarratorEngineId)
    ?? narratorOptions[0];
  const canStart = selected.length > 0 && (!walkthrough
    || (props.pending.comparisonSource !== undefined && chosenNarrator !== undefined));

  return (
    <Stack gap="small">
      <Heading
        level={3}
        value={text('plugins.triage.surface.reviewChooser.engines', 'Review engines')}
      />

      {phase.kind === 'loadingEngines' ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.reviewChooser.loading"
          label="Reading available review engines…"
        />
      ) : null}

      {choosing !== null || (failed !== null && options.length > 0) ? (
        <Form.Select
          label={text('plugins.triage.surface.reviewChooser.engines', 'Review engines')}
          options={options.map((option) => ({ ...option, accessibilityLabel: option.label, ...(!option.capabilities.structuredNarration ? {
            description: text('plugins.triage.surface.reviewChooser.findingsOnly', 'Findings only'),
          } : {}) }))}
          value={selected}
          multiple
          required
          disabled={phase.kind !== 'choosing'}
          focusTarget={engineFocus}
          onChange={(value) => {
            if (phase.kind !== 'choosing') return;
            setPhase({
              ...phase,
              selected: Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
            });
          }}
        />
      ) : null}

      {choosing !== null && choosing.options.length > 0 ? (
        <Form.Toggle
          label={text('plugins.triage.surface.reviewChooser.walkthrough', 'Also write a walkthrough')}
          value={walkthrough}
          onChange={setWalkthrough}
        />
      ) : null}

      {choosing !== null && walkthrough && selected.length > 0 && narratorPolicy.requiresSeparateNarrator ? (
        <Form.Select
          label={text('plugins.triage.surface.reviewChooser.narrator', 'Narrator')}
          options={narratorOptions}
          value={chosenNarrator?.value}
          presentation={narratorOptions.length > 4 ? 'field' : 'inline'}
          required
          onChange={(value) => { if (typeof value === 'string') setNarratorEngineId(value); }}
        />
      ) : null}

      {choosing !== null && walkthrough && selected.length > 0 && chosenNarrator === undefined ? (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.reviewChooser.noNarrator"
          label="No available engine can write a walkthrough. Choose findings only to start this review."
        />
      ) : null}

      {choosing !== null && walkthrough && props.pending.comparisonSource === undefined ? (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.comparisonUnavailable"
          label="This source cannot open a comparison for this pull request."
        />
      ) : null}

      {choosing !== null && choosing.options.length === 0 ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.reviewChooser.empty"
          label="No review engine is available for this session."
        />
      ) : null}

      {choosing !== null && choosing.options.length > 0 && choosing.selected.length === 0 ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.reviewChooser.required"
          label="Choose at least one review engine before starting."
        />
      ) : null}

      {phase.kind === 'starting' ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.reviewChooser.starting"
          label="Starting the review…"
        />
      ) : null}

      {phase.kind === 'settled' ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.reviewChooser.opening"
          label="Opening the session…"
        />
      ) : null}

      {failed !== null ? (
        <Status
          tone="warning"
          labelKey={failed.failure === 'engineList'
            ? 'plugins.triage.surface.reviewChooser.listFailed'
            : failed.failure === 'reviewRefused'
              ? 'plugins.triage.surface.reviewChooser.refused'
              : failed.failure === 'reviewPartial'
                ? 'plugins.triage.surface.reviewChooser.partial'
                : failed.failure === 'reviewUnknown'
                  ? 'plugins.triage.surface.reviewChooser.unknown'
                  : 'plugins.triage.surface.reviewChooser.openFailed'}
          label={failed.failure === 'engineList'
            ? 'The available review engines could not be read.'
            : failed.failure === 'reviewRefused'
              ? 'The pull request changed or the review could not be started. The linked session is still available.'
              : failed.failure === 'reviewPartial'
                ? 'Some of the review engines you chose did not start. Trying again starts only those, and the reviews already running are left alone.'
                : failed.failure === 'reviewUnknown'
                  ? 'Happier could not confirm whether the review started. It will not be started a second time.'
                  : 'The linked session could not be opened.'}
        />
      ) : null}

      <Row gap="small" align="center" wrap>
        {phase.kind === 'choosing' || phase.kind === 'starting' || canRetryReview ? (
          <Action.Control
            action={{ pluginId: 'happier.triage', localId: TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 }}
            titleKey={canRetryReview ? 'plugins.triage.surface.loadMore.retry' : 'plugins.triage.surface.reviewChooser.start'}
            title={canRetryReview ? 'Try again' : 'Start review'}
            variant="primary"
            disabled={!canStart || phase.kind === 'starting'}
            controller={reviewController(options, selected, failed?.failure === 'reviewPartial' ? false : walkthrough)}
          />
        ) : null}
        {phase.kind === 'choosing' && phase.options.length === 0 ? (
          <Button
            titleKey="plugins.triage.surface.loadMore.retry"
            title="Try again"
            variant="primary"
            focusTarget={recoveryFocus}
            onPress={() => { void loadEngines(); }}
          />
        ) : null}
        {failed?.failure === 'engineList' ? (
          <Button
            titleKey="plugins.triage.surface.loadMore.retry"
            title="Try again"
            variant="primary"
            focusTarget={recoveryFocus}
            onPress={() => { void loadEngines(); }}
          />
        ) : null}
        {mustOnlyOpen ? (
          <Button
            titleKey="plugins.triage.surface.reviewChooser.open"
            title="Open session"
            variant="primary"
            focusTarget={recoveryFocus}
            onPress={() => { void openSession(); }}
          />
        ) : null}
        {mustOnlyOpen ? null : (
          <Button
            titleKey="plugins.triage.surface.actions.cancel"
            title="Cancel"
            variant="secondary"
            disabled={phase.kind === 'starting' || phase.kind === 'settled'}
            // Session creation and linking already settled before this chooser
            // mounted. Cancel ends only the optional review continuation, then
            // opens that stable Session so it cannot be stranded off-screen.
            // Once opening is the only safe continuation, the primary control
            // above owns it alone rather than presenting a duplicate Cancel.
            onPress={() => { void openSession(); }}
          />
        )}
      </Row>
    </Stack>
  );
}
