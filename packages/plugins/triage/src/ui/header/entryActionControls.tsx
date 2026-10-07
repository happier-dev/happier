import * as React from 'react';
import {
  Button,
  Popover,
  Row,
  Stack,
  Status,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type {
  TriageEntryRefV1,
  TriageSourceInstanceIdV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import {
  planTriageOfferedActionsV1,
  readTriageActionTitleKeyV1,
  type TriageActionV1,
} from '../../settings/actions.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';

/**
 * The Triage common header's action controls (`core/SESSIONS.md` §1,
 * `PLAN.md` §0a A1/A3).
 *
 * This is the SOLE source-neutral Session-start control owner. A source's own
 * detail body contributes provider facts, provider Actions and links to already
 * canonical review runs; it never renders Ask, Fix, Fix / review, a Session
 * picker or an orchestration callback, because a second start owner is how two
 * Sessions get started for one entry from one screen.
 *
 * It is deliberately thin, and it decides nothing about the actions themselves.
 * Which actions exist, what they are called and what each one needs on disk are
 * the configured record's (`settings/actions.ts`); which of them this entry
 * is offered is that module's one planner. What is left here is what a reader
 * may press and what a press reports — not a destination, a creation key, a
 * workspace, a link, an open or a retry, all of which stay in
 * `sessions/entrySessionOrchestrator.ts`.
 */

/** The exact selected entry a press was made for, and the action it pressed. */
export type TriageEntryActionRequestV1 = Readonly<{
  action: TriageActionV1;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
}>;

/**
 * Why a press started nothing. The catalog is re-read at the press, so an
 * action removed elsewhere, or an Account that cannot be reached, is found only
 * then — and a press that silently does nothing is the failure `core/CORPUS.md`
 * §4.2 names for Refresh.
 */
export type TriageEntryActionRefusalV1 = Readonly<{ kind: 'missing' | 'unavailable' }>;

export type TriageEntryActionControlsPropsV1 = Readonly<{
  /** The one aggregate action target; it reads `selection`, never `focus`. */
  target: TriageActionTargetV1;
  /** The configured catalog. Filtering it for this entry happens in one place. */
  actions: readonly TriageActionV1[];
  workflowSubject: TriageSourceWorkflowSubjectV1;
  /**
   * Whether the currently selected source contribution declares the admitted
   * review-workspace preparation operation. An action that declares
   * `pull_request` without one resolves the workspace refusal every time, so the
   * control is disabled with a stated reason rather than left to fail after the
   * press.
   */
  preparesReviewWorkspace: boolean;
  /** Whether the reader opened this entry (their own pull request asks for Fix, someone else's for Review). */
  viewerIsAuthor: boolean;
  /**
   * More things this entry can do that are not the one primary action: the header's overflow holds them after
   * the entry's other actions (a walkthrough, the source's own write controls).
   */
  overflow?: React.ReactNode;
  /** Quiet context at the end of the action row (the entry's attention reason). */
  trailing?: React.ReactNode;
  /** Starts the action; resolves to a refusal when the press could start nothing. */
  onAction: (request: TriageEntryActionRequestV1) => void | Promise<TriageEntryActionRefusalV1 | null | void>;
}>;

/**
 * The one primary control: the first action in catalog order a reader can
 * press. Every other action is secondary, so two filled buttons never sit side
 * by side (`DESIGN.md` "Hierarchy"). An action this entry cannot run is never
 * the primary one.
 */
type TriageActionIntentV1 = 'review' | 'fix' | 'ask' | 'other';

/** What an action does to the entry, read from its own declared target and workspace, never from its label. */
function readTriageActionIntentV1(action: TriageActionV1): TriageActionIntentV1 {
  if (action.target.kind === 'reviewStart' || action.workspaceMode === 'pull_request') return 'review';
  if (action.workspaceMode === 'repository') return 'fix';
  if (action.workspaceMode === 'reference_only') return 'ask';
  return 'other';
}

/**
 * The one filled action of an entry, chosen from what the entry asks of the reader: someone else's pull request
 * asks for a review, the reader's own pull request, an issue or an error asks for a fix. Asking a question is
 * never the primary while an action that works on the entry can be pressed, and a blocked action never is.
 */
export function readTriagePrimaryActionIdV1(
  offered: readonly TriageActionV1[],
  preparesReviewWorkspace: boolean,
  context: Readonly<{ workflowSubject: TriageSourceWorkflowSubjectV1; viewerIsAuthor: boolean }>,
): string | null {
  const pressable = offered.filter((action) => !isTriageActionBlockedV1(action, preparesReviewWorkspace));
  const wanted: readonly TriageActionIntentV1[] = context.workflowSubject === 'pullRequest' && !context.viewerIsAuthor
    ? ['review', 'fix']
    : ['fix', 'review'];
  for (const intent of wanted) {
    const hit = pressable.find((action) => readTriageActionIntentV1(action) === intent);
    if (hit !== undefined) return hit.actionId;
  }
  return (pressable.find((action) => readTriageActionIntentV1(action) !== 'ask') ?? pressable[0])?.actionId ?? null;
}

function isTriageActionBlockedV1(action: TriageActionV1, preparesReviewWorkspace: boolean): boolean {
  return action.workspaceMode === 'pull_request' && !preparesReviewWorkspace;
}

const NO_SELECTION_COPY = 'Select an entry to start a session from it.';
const NO_PREPARATION_COPY =
  'This source cannot prepare a review workspace, so a pull request cannot be fixed here.';

function TriageEntryActionButton(props: Readonly<{
  action: TriageActionV1;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
  blocked: boolean;
  primary: boolean;
  /** Inside the header's More: a quiet row-like control, not a second bordered button. */
  inOverflow?: boolean;
  onPress: (request: TriageEntryActionRequestV1) => void;
}>): React.ReactElement {
  const titleKey = readTriageActionTitleKeyV1(props.action);
  return (
    <Button
      {...(titleKey === null ? {} : { titleKey })}
      title={props.action.label}
      variant={props.primary ? 'primary' : props.inOverflow === true ? 'plain' : 'secondary'}
      size="small"
      disabled={props.blocked}
      onPress={() => {
        props.onPress({
          action: props.action,
          entryRef: props.entryRef,
          sourceInstanceId: props.sourceInstanceId,
        });
      }}
    />
  );
}

export function TriageEntryActionControls(
  props: TriageEntryActionControlsPropsV1,
): React.ReactElement {
  const { target, actions, workflowSubject, preparesReviewWorkspace, viewerIsAuthor, onAction } = props;
  const text = usePluginTranslation();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const offered = React.useMemo(
    () => planTriageOfferedActionsV1(actions, workflowSubject),
    [actions, workflowSubject],
  );
  const [refusal, setRefusal] = React.useState<TriageEntryActionRefusalV1 | null>(null);
  const press = React.useCallback((request: TriageEntryActionRequestV1) => {
    setRefusal(null);
    void (async () => {
      const outcome = await onAction(request);
      if (outcome !== undefined && outcome !== null) setRefusal(outcome);
    })();
  }, [onAction]);

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
  // Read from the action's own declared mode rather than from the subject: an
  // action needs a prepared workspace because it SAID so, and a subject that
  // happens to be a pull request is not by itself a claim about preparation.
  const preparationMissing = !preparesReviewWorkspace
    && offered.some((action) => action.workspaceMode === 'pull_request');
  const primaryActionId = readTriagePrimaryActionIdV1(offered, preparesReviewWorkspace, { workflowSubject, viewerIsAuthor });
  // With nothing pressable, the first offered action still leads, disabled, beside the reason it cannot start.
  const primary = offered.find((action) => action.actionId === primaryActionId) ?? offered[0] ?? null;
  // Beside the one filled action stays the one quiet question (Ask); every other action is one press behind More.
  const beside = offered.find((action) => action !== primary && readTriageActionIntentV1(action) === 'ask') ?? null;
  const overflowActions = offered.filter((action) => action !== primary && action !== beside);
  const hasOverflow = overflowActions.length > 0 || (props.overflow !== undefined && props.overflow !== null);
  // A renamed control shows the person's own words in every locale; a still-shipped one keeps its translation.
  // `titleKey` is therefore resolved from the record, never stored in it.
  const button = (action: TriageActionV1, onPress: (request: TriageEntryActionRequestV1) => void, inOverflow = false) => (
    <TriageEntryActionButton
      key={action.actionId}
      action={action}
      entryRef={entryRef}
      sourceInstanceId={sourceInstanceId}
      blocked={isTriageActionBlockedV1(action, preparesReviewWorkspace)}
      primary={action.actionId === primaryActionId}
      inOverflow={inOverflow}
      onPress={onPress}
    />
  );
  const moreLabel = text('plugins.triage.surface.detail.moreActions', 'More actions');

  return (
    <Stack gap="small">
      <Row gap="small" align="center" wrap>
        {primary === null ? null : button(primary, press)}
        {beside === null ? null : button(beside, press)}
        {hasOverflow ? (
          <Popover
            open={moreOpen}
            onOpenChange={setMoreOpen}
            trigger={moreLabel}
            triggerIcon="more"
            triggerAccessibilityLabel={moreLabel}
            placement="bottom"
          >
            <Stack gap="small">
              {overflowActions.length === 0 ? null : (
                <Stack gap="xsmall">
                  {overflowActions.map((action) => button(action, (request) => { setMoreOpen(false); press(request); }, true))}
                </Stack>
              )}
              {props.overflow}
            </Stack>
          </Popover>
        ) : null}
        {props.trailing === undefined || props.trailing === null ? null : (
          <Stack style={TRAILING_STYLE_V1}>{props.trailing}</Stack>
        )}
      </Row>
      {refusal === null ? null : refusal.kind === 'missing' ? (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.actions.noLongerAvailable"
          label="That action is no longer available for this entry."
        />
      ) : (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.actions.startUnavailable"
          label="Happier cannot reach your account right now, so this action cannot start. Try again in a moment."
        />
      )}
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

/** The attention reason sits at the far end of the action row, as the lab places it. */
const TRAILING_STYLE_V1 = Object.freeze({ marginLeft: 'auto' as const, alignItems: 'flex-end' as const });
