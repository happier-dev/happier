import * as React from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  Button,
  Form,
  Heading,
  Row,
  Stack,
  Status,
  usePluginHostApi,
  usePluginUiFocusTarget,
  usePluginTranslation,
  type PluginUiFocusTarget,
} from '@happier-dev/plugin-ui';

import {
  TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
  TriageStartPullRequestReviewResultV1Schema,
} from '../../actions/entrySessionProtocol.js';
import { openLinkedSession } from '../../sessions/entrySessionOpen.js';
import {
  readAvailableEngineOptions,
  type TriageReviewEngineOptionV1,
} from '../../sessions/reviewEngineOptions.js';
import type { TriagePendingPullRequestReviewV1 } from './useEntrySessionStart.js';

type ReviewChooserFailureV1 = 'engineList' | 'reviewRefused' | 'reviewUnknown' | 'open';

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
  /** The exact configured action that invoked this transient chooser. */
  returnFocusTarget: PluginUiFocusTarget;
  /** Dismisses only the chooser; the prepared workspace, Session and link remain. */
  onDismiss: () => void;
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
  const engineFocus = usePluginUiFocusTarget();
  const recoveryFocus = usePluginUiFocusTarget();
  const [phase, setPhase] = React.useState<ReviewChooserPhaseV1>(IDLE);
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
    } catch {
      if (operation.current === currentOperation) {
        setPhase({ kind: 'failed', failure: 'engineList', options: [], selected: [] });
      }
    }
  }, [host, props.pending.sessionId]);

  React.useEffect(() => {
    void loadEngines();
    return () => { operation.current += 1; };
  }, [loadEngines]);

  React.useEffect(() => {
    if (phase.kind === 'choosing' && phase.options.length > 0) engineFocus.focus();
    if (phase.kind === 'choosing' && phase.options.length === 0) recoveryFocus.focus();
    if (phase.kind === 'failed') recoveryFocus.focus();
  }, [engineFocus, phase, recoveryFocus]);

  const openSession = React.useCallback(async (): Promise<void> => {
    const currentOperation = operation.current + 1;
    operation.current = currentOperation;
    setPhase({ kind: 'settled' });
    const result = await openLinkedSession({
      execute: async (actionId, input, options) => await host.executeAction(actionId, input, options),
      sessionId: props.pending.sessionId,
    });
    if (operation.current !== currentOperation) return;
    if (result.status === 'opened') {
      props.onFinished();
      return;
    }
    setPhase({ kind: 'failed', failure: 'open', options: [], selected: [] });
  }, [host, props.onFinished, props.pending.sessionId]);

  const startReview = React.useCallback(async (
    options: readonly TriageReviewEngineOptionV1[],
    selected: readonly string[],
  ): Promise<void> => {
    if (selected.length === 0) return;
    const currentOperation = operation.current + 1;
    operation.current = currentOperation;
    setPhase({ kind: 'starting', options, selected });
    let raw: unknown;
    try {
      raw = await host.executeAction(
        TRIAGE_START_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1,
        {
          v: 1,
          sessionId: props.pending.sessionId,
          review: props.pending.review,
          engineIds: [...selected],
          instructions: props.pending.instructions,
        } as unknown as JsonValue,
      );
    } catch {
      // This outward write may already have reached review.start. Repeating it
      // would be a blind second mutation; only the idempotent Session open is
      // offered from this state.
      if (operation.current === currentOperation) {
        setPhase({ kind: 'failed', failure: 'reviewUnknown', options, selected });
      }
      return;
    }
    if (operation.current !== currentOperation) return;
    const result = TriageStartPullRequestReviewResultV1Schema.safeParse(raw);
    if (!result.success || result.data.status !== 'started') {
      setPhase({ kind: 'failed', failure: 'reviewRefused', options, selected });
      return;
    }
    await openSession();
  }, [host, openSession, props.pending]);

  const dismiss = React.useCallback(() => {
    operation.current += 1;
    props.onDismiss();
    // The public logical target survives the child unmount and delegates the
    // physical move to the host. No DOM/native ref escapes into Triage.
    props.returnFocusTarget.focus();
  }, [props.onDismiss, props.returnFocusTarget]);

  const choosing = phase.kind === 'choosing' ? phase : null;
  const failed = phase.kind === 'failed' ? phase : null;
  const options = choosing?.options ?? failed?.options ?? [];
  const selected = choosing?.selected ?? failed?.selected ?? [];
  const canRetryReview = failed?.failure === 'reviewRefused';
  const mustOnlyOpen = failed?.failure === 'reviewUnknown' || failed?.failure === 'open';

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
          options={options}
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
              : failed.failure === 'reviewUnknown'
                ? 'plugins.triage.surface.reviewChooser.unknown'
                : 'plugins.triage.surface.reviewChooser.openFailed'}
          label={failed.failure === 'engineList'
            ? 'The available review engines could not be read.'
            : failed.failure === 'reviewRefused'
              ? 'The pull request changed or the review could not be started. The linked session is still available.'
              : failed.failure === 'reviewUnknown'
                ? 'Happier could not confirm whether the review started. It will not be started a second time.'
                : 'The linked session could not be opened.'}
        />
      ) : null}

      <Row gap="small" align="center" wrap>
        {phase.kind === 'choosing' ? (
          <Button
            titleKey="plugins.triage.surface.reviewChooser.start"
            title="Start review"
            variant="primary"
            disabled={phase.selected.length === 0}
            onPress={() => { void startReview(phase.options, phase.selected); }}
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
        {canRetryReview ? (
          <Button
            titleKey="plugins.triage.surface.loadMore.retry"
            title="Try again"
            variant="primary"
            focusTarget={recoveryFocus}
            onPress={() => { void startReview(options, selected); }}
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
        <Button
          titleKey="plugins.triage.surface.actions.cancel"
          title="Cancel"
          variant="secondary"
          disabled={phase.kind === 'starting' || phase.kind === 'settled'}
          onPress={dismiss}
        />
      </Row>
    </Stack>
  );
}
