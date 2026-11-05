import * as React from 'react';
import {
  Button,
  Menu,
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
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';

import {
  planTriageOfferedActionsV1,
  readTriageActionTitleKeyV1,
  type TriageActionV1,
} from '../../settings/actions.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { TriageSourceWriteCluster, triageSourceWriteReplacedByNativeStateV1, useTriageMergeChoicesV1 } from './sourceWriteCluster.js';

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

export type TriageReviewPreparationV1 = 'ready' | 'pending' | 'unsupported';

/** One row of the header's More menu that is not a configured action. */
export type TriageEntryOverflowItemV1 = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}>;

export type TriageEntryActionControlsPropsV1 = Readonly<{
  /** The one aggregate action target; it reads `selection`, never `focus`. */
  target: TriageActionTargetV1;
  /** The configured catalog. Filtering it for this entry happens in one place. */
  actions: readonly TriageActionV1[];
  workflowSubject: TriageSourceWorkflowSubjectV1;
  /**
   * Where review-workspace preparation stands for this entry. `unsupported`: the selected source contribution
   * declares no admitted preparation operation, so an action that declares `pull_request` would resolve the
   * workspace refusal every time; it is disabled with a stated reason rather than left to fail after the press.
   * `pending`: the source can prepare, but this entry's own read has not produced the workspace yet (still reading,
   * or it failed); the action stays disabled and keeps its place, because the verb belongs to the entry's kind.
   */
  reviewPreparation: TriageReviewPreparationV1;
  /** Whether the reader opened this entry (their own pull request asks for Fix, someone else's for Review). */
  viewerIsAuthor: boolean;
  /**
   * More things this entry can do that are not the one primary action: the header's More menu lists them after the
   * entry's other actions (a walkthrough, orchestration). Rows of the shared menu, never controls or a form.
   */
  overflowItems?: readonly TriageEntryOverflowItemV1[];
  /**
   * The source's own main write for this entry (Merge, Mark ready), offered by the source. It leads the source's
   * controls after the agent's, where the lab puts the entry's source action (its Approve). Quiet (secondary): the
   * view's one filled action stays the agent's.
   * The source keeps custody of the write and its confirmation; this control only calls `execute`.
   */
  sourceWrite?: TriageDetailPrimaryWriteV1;
  sourceLabel?: string;
  /** A quiet control beside Ask that stays in sight (the source's own changes, which open `section`). */
  beside?: React.ReactNode;
  /** An inline section under the action row (the source's write form); forms never ride inside a menu. */
  section?: React.ReactNode;
  /** Quiet context at the end of the action row (the entry's attention reason). */
  trailing?: React.ReactNode;
  /** Starts the action; resolves to a refusal when the press could start nothing. */
  onAction: (request: TriageEntryActionRequestV1) => void | Promise<TriageEntryActionRefusalV1 | null | void>;
}>;

/**
 * The one primary control: the first action in catalog order a reader can
 * press. Every other action is secondary, so two filled buttons never sit side
 * by side (`DESIGN.md` "Hierarchy"). An action this source can never run is not
 * the primary one; one that only waits on this entry's read keeps its place.
 */
type TriageActionIntentV1 = 'review' | 'fix' | 'ask' | 'other';

/** Source support and the selected entry's readiness are separate facts. */
export function resolveTriageReviewPreparationV1(input: Readonly<{
  sourceCanPrepare: boolean;
  workspaceReady: boolean;
}>): TriageReviewPreparationV1 {
  return input.workspaceReady ? 'ready'
    : input.sourceCanPrepare ? 'pending' : 'unsupported';
}

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
  reviewPreparation: TriageReviewPreparationV1,
  context: Readonly<{ workflowSubject: TriageSourceWorkflowSubjectV1; viewerIsAuthor: boolean }>,
): string | null {
  const pressable = offered.filter((action) => !(action.workspaceMode === 'pull_request' && reviewPreparation === 'unsupported'));
  const wanted: readonly TriageActionIntentV1[] = context.workflowSubject === 'pullRequest' && !context.viewerIsAuthor
    ? ['review', 'fix']
    : ['fix', 'review'];
  for (const intent of wanted) {
    const hit = pressable.find((action) => readTriageActionIntentV1(action) === intent);
    if (hit !== undefined) return hit.actionId;
  }
  return (pressable.find((action) => readTriageActionIntentV1(action) !== 'ask') ?? pressable[0])?.actionId ?? null;
}

function isTriageActionBlockedV1(action: TriageActionV1, reviewPreparation: TriageReviewPreparationV1): boolean {
  return action.workspaceMode === 'pull_request' && reviewPreparation !== 'ready';
}

const NO_SELECTION_COPY = 'Select an entry to start a session from it.';
const ACTION_ITEM_PREFIX = 'triage-action:';
const EXTRA_ITEM_PREFIX = 'triage-more:';
const NO_PREPARATION_COPY =
  'This source cannot prepare a review workspace, so actions that need one cannot start here.';

function TriageEntryActionButton(props: Readonly<{
  action: TriageActionV1;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
  blocked: boolean;
  primary: boolean;
  onPress: (request: TriageEntryActionRequestV1) => void;
}>): React.ReactElement {
  const titleKey = readTriageActionTitleKeyV1(props.action);
  return (
    <Button
      {...(titleKey === null ? {} : { titleKey })}
      title={props.action.label}
      variant={props.primary ? 'primary' : 'secondary'}
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
  const { target, actions, workflowSubject, reviewPreparation, viewerIsAuthor, onAction } = props;
  const text = usePluginTranslation();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const offered = React.useMemo(
    () => planTriageOfferedActionsV1(actions, workflowSubject),
    [actions, workflowSubject],
  );
  const [refusal, setRefusal] = React.useState<TriageEntryActionRefusalV1 | null>(null);
  // Merge's alternatives join this row's one ⋯ rather than a second ⋯ beside Merge.
  const mergeChoices = useTriageMergeChoicesV1(props.sourceWrite, props.sourceLabel);
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
  const primaryActionId = readTriagePrimaryActionIdV1(offered, reviewPreparation, { workflowSubject, viewerIsAuthor });
  // With nothing pressable, the first offered action still leads, disabled, beside the reason it cannot start.
  const primary = offered.find((action) => action.actionId === primaryActionId) ?? offered[0] ?? null;
  // Beside the one filled action stays the one quiet question (Ask); every other action is one press behind More.
  const beside = offered.find((action) => action !== primary && readTriageActionIntentV1(action) === 'ask') ?? null;
  const overflowActions = offered.filter((action) => action !== primary && action !== beside);
  const extraItems = props.overflowItems ?? [];
  const hasOverflow = overflowActions.length > 0 || extraItems.length > 0 || mergeChoices !== null;
  // The reason a control cannot start sits with that control: under the row when a blocked action is in sight,
  // as the subtitle of its own menu row when it waits behind More, so the row never says "cannot" beside an action
  // that can.
  const isBlocked = (action: TriageActionV1 | null) => action !== null && isTriageActionBlockedV1(action, reviewPreparation);
  // Only a source that can never prepare a workspace owes the reader that sentence; a read still pending says nothing.
  const sourceCannotPrepare = reviewPreparation === 'unsupported';
  const blockedInRow = sourceCannotPrepare && (isBlocked(primary) || isBlocked(beside));
  const preparationReasonLabel = text('plugins.triage.surface.session.preparationUnsupported', NO_PREPARATION_COPY);
  const preparationReason = (
    <Status
      tone="muted"
      labelKey="plugins.triage.surface.session.preparationUnsupported"
      label={NO_PREPARATION_COPY}
    />
  );
  // A renamed control shows the person's own words in every locale; a still-shipped one keeps its translation.
  // `titleKey` is therefore resolved from the record, never stored in it.
  const button = (action: TriageActionV1, onPress: (request: TriageEntryActionRequestV1) => void) => (
    <TriageEntryActionButton
      key={action.actionId}
      action={action}
      entryRef={entryRef}
      sourceInstanceId={sourceInstanceId}
      blocked={isTriageActionBlockedV1(action, reviewPreparation) || props.sourceWrite?.reading === true}
      primary={action.actionId === primaryActionId}
      onPress={onPress}
    />
  );
  const moreLabel = text('plugins.triage.surface.detail.moreActions', 'More actions');
  const actionItemId = (action: TriageActionV1) => `${ACTION_ITEM_PREFIX}${action.actionId}`;
  const menuItems = [
    ...(mergeChoices === null ? [] : mergeChoices.readinessItems),
    ...overflowActions.map((action) => {
      const titleKey = readTriageActionTitleKeyV1(action);
      const blocked = isTriageActionBlockedV1(action, reviewPreparation);
      return {
        id: actionItemId(action),
        label: titleKey === null ? action.label : text(titleKey, action.label),
        ...(blocked ? { disabled: true } : {}),
        ...(blocked && sourceCannotPrepare ? { subtitle: preparationReasonLabel } : {}),
      };
    }),
    ...extraItems.map((item) => ({
      id: `${EXTRA_ITEM_PREFIX}${item.id}`,
      label: item.label,
      ...(item.disabled === true ? { disabled: true } : {}),
    })),
    ...(mergeChoices === null ? [] : mergeChoices.items),
  ];
  // The source's merge alternatives follow the entry's own actions in the same ⋯; a merge method choice keeps its group.
  const menuGroups = mergeChoices === null ? [] : mergeChoices.groups;
  const selectMenuItem = (id: string) => {
    setMoreOpen(false);
    if (mergeChoices !== null && mergeChoices.run(id)) return;
    const action = overflowActions.find((candidate) => actionItemId(candidate) === id);
    if (action !== undefined) {
      press({ action, entryRef, sourceInstanceId });
      return;
    }
    extraItems.find((item) => `${EXTRA_ITEM_PREFIX}${item.id}` === id)?.onPress();
  };

  return (
    <Stack gap="small">
      <Row gap="small" align="center" wrap>
        {primary === null ? null : button(primary, press)}
        {beside === null ? null : button(beside, press)}
        {hasOverflow ? (
          <Menu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            trigger={moreLabel}
            triggerIcon="more"
            triggerAccessibilityLabel={moreLabel}
            items={menuItems}
            {...(menuGroups.length === 0 ? {} : { groups: [...menuGroups], showGroupLabels: true })}
            {...(mergeChoices?.explanation == null ? {} : { sheet: { title: moreLabel, footer: mergeChoices.explanation } })}
            onSelect={selectMenuItem}
          />
        ) : null}
        {/* The source's own controls follow the agent's (More lists only agent actions), so a source write that lands
            after the entry's read appends to the row and nothing already in it moves. */}
        {props.sourceWrite === undefined && props.beside == null ? null : (
          // One group, so a narrow row (a phone's pinned footer) moves the source's controls to their own line
          // together rather than splitting them.
          <Row gap="small" align="center">
            {props.sourceWrite === undefined ? null : <TriageSourceWriteCluster write={props.sourceWrite} sourceLabel={props.sourceLabel} choices="host" />}
            {props.beside ?? null}
          </Row>
        )}
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
      {blockedInRow ? preparationReason : null}
      {/* Why the source's write cannot run, said quietly beside the disabled control's row, never a dead button. The
          readiness line that explains it elsewhere lives behind this row's ⋯ here, so only a native state line (a
          queue, auto-merge, which replaces the button) already says it. */}
      {props.sourceWrite?.disabledReason == null || triageSourceWriteReplacedByNativeStateV1(props.sourceWrite) ? null : (
        <Status tone="muted" label={props.sourceWrite.disabledReason} />
      )}
      {props.sourceWrite?.feedback == null ? null : props.sourceWrite.feedback}
      {props.section ?? null}
    </Stack>
  );
}

/** The attention reason sits at the far end of the action row, as the lab places it. */
const TRAILING_STYLE_V1 = Object.freeze({ marginLeft: 'auto' as const, alignItems: 'flex-end' as const });
