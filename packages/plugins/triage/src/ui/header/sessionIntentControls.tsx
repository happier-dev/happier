import * as React from 'react';
import { Button, Row, Stack, Status } from '@happier-dev/plugin-ui';
import type {
  TriageEntryRefV1,
  TriageSourceInstanceIdV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import type { TriageEntrySessionIntentV1 } from '../../sessions/entrySessionOrchestrator.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';

/**
 * The Triage common header's Session-intent controls (`core/SESSIONS.md` §1).
 *
 * This is the SOLE source-neutral Session-intent control owner. A source's own
 * detail body contributes provider facts, provider Actions and links to already
 * canonical review runs; it never renders Ask, Fix, Fix / review, a Session
 * picker or an orchestration callback, because a second start owner is how two
 * Sessions get started for one entry from one screen.
 *
 * It is deliberately thin. The intent vocabulary is
 * `entrySessionOrchestrator.ts`'s own `TriageEntrySessionIntentV1` rather than a
 * local copy, so the rendered choice and the gate that admits it cannot drift:
 * **Fix / review** is the pull request's wording for the one `fix` intent, not a
 * third intent. Nothing here selects a destination, mints a creation key,
 * prepares a workspace, links, opens or retries — `startEntrySession` owns all
 * of that, and this module owns only what a reader may press.
 *
 * The controls are decided by the entry's Contract-owned workflow subject and
 * the selected source contribution's declared preparation capability, and by
 * nothing else: no layout, platform, mount or source body takes part, which is
 * why the same set renders in the wide split and the compact stacked
 * composition.
 */

/** What the reader is offered, in the orchestrator's own intent vocabulary. */
export type TriageSessionIntentControlV1 = Readonly<{
  intent: TriageEntrySessionIntentV1;
  /**
   * Which words this control uses. `fixReview` and `fix` are one intent with
   * two labels: a pull request is fixed through a prepared review workspace, so
   * the control says so.
   */
  id: 'ask' | 'fix' | 'fixReview';
  titleKey: string;
  title: string;
}>;

const ASK_CONTROL: TriageSessionIntentControlV1 = Object.freeze({
  intent: 'ask',
  id: 'ask',
  titleKey: 'plugins.triage.surface.session.ask',
  title: 'Ask',
});

const FIX_CONTROL: TriageSessionIntentControlV1 = Object.freeze({
  intent: 'fix',
  id: 'fix',
  titleKey: 'plugins.triage.surface.session.fix',
  title: 'Fix',
});

const FIX_REVIEW_CONTROL: TriageSessionIntentControlV1 = Object.freeze({
  intent: 'fix',
  id: 'fixReview',
  titleKey: 'plugins.triage.surface.session.fixReview',
  title: 'Fix / review',
});

const PULL_REQUEST_CONTROLS: readonly TriageSessionIntentControlV1[] =
  Object.freeze([ASK_CONTROL, FIX_REVIEW_CONTROL]);
const FIXABLE_CONTROLS: readonly TriageSessionIntentControlV1[] =
  Object.freeze([ASK_CONTROL, FIX_CONTROL]);

/**
 * The one offered-control decision.
 *
 * Only a pull request reaches a source-prepared review workspace, so only a
 * pull request says **Fix / review**. Every other subject — a code issue, an
 * error issue, or any other fixable subject a source declares — is fixed in a
 * project the reader chooses, and says **Fix**.
 */
export function planTriageSessionIntentControlsV1(
  workflowSubject: TriageSourceWorkflowSubjectV1,
): readonly TriageSessionIntentControlV1[] {
  return workflowSubject === 'pullRequest' ? PULL_REQUEST_CONTROLS : FIXABLE_CONTROLS;
}

/** The exact selected entry a press was made for, plus the intent it carries. */
export type TriageSessionIntentRequestV1 = Readonly<{
  intent: TriageEntrySessionIntentV1;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
}>;

export type TriageSessionIntentControlsPropsV1 = Readonly<{
  /** The one aggregate action target; it reads `selection`, never `focus`. */
  target: TriageActionTargetV1;
  workflowSubject: TriageSourceWorkflowSubjectV1;
  /**
   * Whether the currently selected source contribution declares the admitted
   * review-workspace preparation operation. A pull-request Fix without one
   * resolves the workspace refusal every time, so the control is disabled with
   * a stated reason rather than left to fail after the press.
   */
  preparesReviewWorkspace: boolean;
  onIntent: (request: TriageSessionIntentRequestV1) => void;
}>;

const NO_SELECTION_COPY = 'Select an entry to start a session from it.';
const NO_PREPARATION_COPY =
  'This source cannot prepare a review workspace, so a pull request cannot be fixed here.';

export function TriageSessionIntentControls(
  props: TriageSessionIntentControlsPropsV1,
): React.ReactElement {
  const { target, workflowSubject, preparesReviewWorkspace, onIntent } = props;
  const controls = planTriageSessionIntentControlsV1(workflowSubject);

  // No selection is a stated refusal, never a fallback to the focused or first
  // row: a control here would start a Session from whichever row a keyboard
  // cursor happened to be parked on.
  if (target.kind === 'refused') {
    return (
      <Status
        tone="muted"
        labelKey="plugins.triage.surface.session.noSelection"
        label={NO_SELECTION_COPY}
      />
    );
  }

  const entryRef = target.entryRef;
  const sourceInstanceId = target.sourceInstanceId;
  const preparationMissing = workflowSubject === 'pullRequest' && !preparesReviewWorkspace;

  return (
    <Stack gap="small">
      <Row gap="small" align="center">
        {controls.map((control) => {
          const blocked = control.id === 'fixReview' && preparationMissing;
          return (
            <Button
              key={control.id}
              titleKey={control.titleKey}
              title={control.title}
              variant={control.intent === 'ask' ? 'secondary' : 'primary'}
              disabled={blocked}
              onPress={() => {
                onIntent({ intent: control.intent, entryRef, sourceInstanceId });
              }}
            />
          );
        })}
      </Row>
      {preparationMissing ? (
        <Status
          tone="muted"
          labelKey="plugins.triage.surface.session.preparationUnsupported"
          label={NO_PREPARATION_COPY}
        />
      ) : null}
    </Stack>
  );
}
