import * as React from 'react';
import type { ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';
import {
  AgentActionButton,
  Button,
  Icon,
  type LayoutChangeEvent,
  Menu,
  Row,
  Stack,
  Status,
  usePluginTranslation,
  usePluginHostApi,
} from '@happier-dev/plugin-ui';
import type {
  TriageEntryRefV1,
  TriageSourceInstanceIdV1,
  TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';
import type { TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';
import { TRIAGE_DEFAULT_FIX_ACTION_ID_V1, TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1 } from '@happier-dev/triage-protocol/v1';

import {
  applyTriageActionLaunchModeV1,
  planTriageOfferedActionsV1,
  readTriageActionLaunchModeV1,
  readTriageActionTitleKeyV1,
  type TriageActionLaunchModeV1,
  type TriageActionV1,
} from '../../settings/actions.js';
import type { TriageActionTargetV1 } from '../state/actionTarget.js';
import { TriageSourceWriteCluster, triageSourceWriteReplacedByNativeStateV1, useTriageMergeChoicesV1 } from './sourceWriteCluster.js';
import type { TriageAgentEntryV1 } from '../detail/storyRail.js';
import { useTriageEntrySessionStartChoices } from './useEntrySessionStart.js';
import { TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, type TriageTaskDraftV1 } from '../../actions/tasksProtocol.js';
import { TriageMountedUiResultV1Schema } from '../../actions/mountedUiProtocol.js';

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
  /**
   * The launch the person chose on the split (owner ruling 2026-11-07): `start` runs in the background, `review`
   * opens the prefilled composer. Absent, the action's own configured delivery decides.
   */
  launchMode?: TriageActionLaunchModeV1;
  /** The split's other destination: send to a running Session the host's picker selects. */
  destinationChoice?: 'existingSession';
  existingSession?: ActionSessionAddressV1;
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
  /** Error detail supplies its exact reference; the existing task draft owns Where and creation. */
  taskDraft?: TriageTaskDraftV1;
  /** The one aggregate action target; it reads `selection`, never `focus`. */
  target: TriageActionTargetV1;
  /** The configured catalog. Filtering it for this entry happens in one place. */
  actions: readonly TriageActionV1[];
  workflowSubject: TriageSourceWorkflowSubjectV1;
  /**
   * Where review-workspace preparation stands for this entry. `unsupported`: the selected source contribution
   * declares no admitted preparation operation, so an action that declares `pull_request` would resolve the
   * workspace refusal every time; it is disabled with a stated reason rather than left to fail after the press.
   * `pending`: the source can prepare, but this entry's durable input is still reading or unavailable; the body
   * owns that read's progress and failure details. Missing exact PR revisions are acquired on press, not awaited here.
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
  /** The source's name as the reader knows it ("GitHub"), for the copy that says whose answer the write reports. */
  sourceLabel?: string;
  /** An inline section under the action row (the source's own changes, opened from ⋯); forms never ride inside a menu. */
  section?: React.ReactNode;
  /**
   * Receives the primary agent action's Start and Send to a Session while it can start (`null` otherwise), so the
   * story's agent chapter offers the same press through this one controller rather than a second start path.
   */
  onAgentEntry?: (entry: TriageAgentEntryV1 | null) => void;
  /** Quiet context at the end of the action row (the entry's attention reason). */
  trailing?: React.ReactNode;
  /**
   * A phone's pinned action band (lab c7/t1 phone): one row of the primary, Ask and ⋯. The primary keeps its whole
   * word: where the band cannot hold all three, Ask is a row of ⋯ too, and the primary ends in "…" only when it
   * alone cannot fit. Everything else the row would hold (the source's write, Make task, the rest) is a row of that ⋯.
   */
  compact?: boolean;
  /** The entry's own state control leading the one action row (a task's Status button, lab t1 `dpa`). */
  leading?: React.ReactNode;
  /**
   * The entry has no code repository (a personal or Linear task): working on it starts a Session rather than
   * fixing code, so the seeded Fix reads "Start" (lab t1). A renamed action keeps the person's own words.
   */
  withoutRepository?: boolean;
  /** The entry's repository, which decides the Start split's default Machine. */
  repository?: Parameters<typeof useTriageEntrySessionStartChoices>[0]['repository'];
  /** Starts the action; resolves to a refusal when the press could start nothing. */
  onAction: (request: TriageEntryActionRequestV1) => void | Promise<TriageEntryActionRefusalV1 | null | void>;
  /** Opens the one actions editor on this action (the chevron's "Edit action…"); absent where no editor is mounted. */
  onEditAction?: (actionId: string) => void;
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
  entryReady: boolean;
}>): TriageReviewPreparationV1 {
  return !input.sourceCanPrepare ? 'unsupported'
    : input.entryReady ? 'ready' : 'pending';
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
 * asks for a review, an error asks for investigation, and the reader's own pull request or an issue asks for a fix. Asking a question is
 * never the primary while an action that works on the entry can be pressed, and a blocked action never is.
 */
export function readTriagePrimaryActionIdV1(
  offered: readonly TriageActionV1[],
  reviewPreparation: TriageReviewPreparationV1,
  context: Readonly<{ workflowSubject: TriageSourceWorkflowSubjectV1; viewerIsAuthor: boolean }>,
): string | null {
  const pressable = offered.filter((action) => !(action.workspaceMode === 'pull_request' && reviewPreparation === 'unsupported'));
  if (context.workflowSubject === 'errorIssue') {
    const investigate = pressable.find((action) => action.actionId === TRIAGE_DEFAULT_INVESTIGATE_ACTION_ID_V1);
    if (investigate !== undefined) return investigate.actionId;
  }
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
const RECENT_SESSION_ITEM_PREFIX = 'triage-start:recent:';
const EXISTING_SESSION_ITEM_ID = 'triage-start:existing-session';
const EXTRA_ITEM_PREFIX = 'triage-more:';
const NO_PREPARATION_COPY =
  'This source cannot prepare a review workspace, so actions that need one cannot start here.';

/** Make task's one press, for its button or its row in ⋯. */
function useTriageMakeTask(draft: TriageTaskDraftV1 | undefined) {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [busy, setBusy] = React.useState(false);
  const run = React.useCallback(async () => {
    if (draft === undefined) return;
    setBusy(true);
    try {
      const result = TriageMountedUiResultV1Schema.parse(await host.executeAction(TRIAGE_TASKS_OPEN_CREATE_ACTION_LOCAL_ID_V1, draft));
      if (result.status !== 'applied') {
        await host.notify(text('plugins.triage.tasks.draft.unavailable', 'The task draft could not be opened.'), { severity: 'warning' });
      }
    } catch {
      await host.notify(text('plugins.triage.tasks.draft.unavailable', 'The task draft could not be opened.'), { severity: 'warning' });
    } finally { setBusy(false); }
  }, [draft, host, text]);
  return { label: text('plugins.triage.tasks.make', 'Make task'), busy, run };
}

const MAKE_TASK_ITEM_ID = 'triage-make-task';
const SOURCE_WRITE_ITEM_PREFIX = 'triage-source-write:';

function TriageEntryActionButton(props: Readonly<{
  action: TriageActionV1;
  entryRef: TriageEntryRefV1;
  sourceInstanceId: TriageSourceInstanceIdV1;
  blocked: boolean;
  primary: boolean;
  withoutRepository: boolean;
  /** The words naming who it starts with ("Fix with Claude"), once the default is known. */
  label?: string;
  joinedEdge?: 'end';
  singleLine?: boolean;
  /** Drawn as this glyph alone, named by its words for assistive technology (Ask in the pinned phone band). */
  glyph?: 'conversations';
  onPress: (request: TriageEntryActionRequestV1) => void;
}>): React.ReactElement {
  const seededKey = readTriageActionTitleKeyV1(props.action);
  const starts = props.withoutRepository && seededKey !== null && props.action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1;
  const titleKey = starts ? 'plugins.triage.surface.actions.start' : seededKey;
  const words = props.label ?? (starts ? 'Start' : props.action.label);
  const name = props.glyph === undefined
    ? { ...(titleKey === null || props.label !== undefined ? {} : { titleKey }), title: words }
    : { ...(titleKey === null || props.label !== undefined ? {} : { accessibilityLabelKey: titleKey }), accessibilityLabel: words,
      icon: <Icon name={props.glyph} size="small" /> };
  return (
    <Button
      {...name}
      variant={props.primary ? 'primary' : 'secondary'}
      size="small"
      {...(props.joinedEdge === undefined ? {} : { joinedEdge: props.joinedEdge })}
      {...(props.singleLine === true ? { singleLine: true } : {})}
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
  const [startOpen, setStartOpen] = React.useState(false);
  const compact = props.compact === true;
  // The pinned band's room, and the width its controls needed when Ask last had to yield (null: it never did).
  const [bandRoom, setBandRoom] = React.useState<number | null>(null);
  const [bandNeed, setBandNeed] = React.useState<number | null>(null);
  const bandControlsWidth = React.useRef(0);
  const makeTask = useTriageMakeTask(props.taskDraft);
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

  // The story's agent chapter borrows this row's primary agent press. The handle is stable (it reads the current
  // request and press at the moment it is used) and is republished only when the press becomes or stops being
  // available, so lending it never rerenders the detail on each row render.
  const agentPrimary = target.kind === 'refused' ? null
    : readTriageEntryPrimaryActionV1(offered, reviewPreparation, workflowSubject, viewerIsAuthor);
  const agentRequest = target.kind === 'refused' || agentPrimary === null || agentPrimary.target.kind !== 'agent'
    || isTriageActionBlockedV1(agentPrimary, reviewPreparation) ? null
    : { action: agentPrimary, entryRef: target.entryRef, sourceInstanceId: target.sourceInstanceId };
  // Who the split's press starts with, and the recent Sessions its caret lists while open (the choices' read owner).
  const startChoices = useTriageEntrySessionStartChoices({
    action: agentRequest?.action ?? null,
    ...(props.repository === undefined ? {} : { repository: props.repository }),
    menuOpen: startOpen,
  });
  const latestAgent = React.useRef({ request: agentRequest, press });
  latestAgent.current = { request: agentRequest, press };
  const agentHandle = React.useMemo<TriageAgentEntryV1>(() => ({
    start: () => { const { request, press: run } = latestAgent.current; if (request !== null) run(request); },
    send: () => {
      const { request, press: run } = latestAgent.current;
      if (request !== null) run({ ...request, destinationChoice: 'existingSession' });
    },
  }), []);
  const onAgentEntry = props.onAgentEntry;
  const agentAvailable = agentRequest !== null;
  React.useEffect(() => {
    if (onAgentEntry === undefined) return undefined;
    onAgentEntry(agentAvailable ? agentHandle : null);
    return () => onAgentEntry(null);
  }, [agentAvailable, agentHandle, onAgentEntry]);

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
  const primary = readTriageEntryPrimaryActionV1(offered, reviewPreparation, workflowSubject, viewerIsAuthor);
  // Beside the one filled action stays the one quiet question (Ask); every other action is one press behind More.
  const asking = offered.find((action) => action !== primary && readTriageActionIntentV1(action) === 'ask') ?? null;
  // The pinned band's one rule (DESIGN-F 1115 g): the primary keeps its word. When the band cannot hold the primary,
  // Ask and ⋯ at their own widths, Ask yields into ⋯ (its first row); it comes back once the band has that width again.
  const askYields = compact && asking !== null && bandNeed !== null && bandRoom !== null && bandRoom < bandNeed;
  const beside = askYields ? null : asking;
  const overflowActions = [
    ...(askYields && asking !== null ? [asking] : []),
    ...offered.filter((action) => action !== primary && action !== asking),
  ];
  // Measured from the band's own layout, never from a guessed breakpoint: the primary's words, the agent it names and
  // the locale all change the width the row needs. The controls are drawn at their own widths while Ask is beside the
  // primary, so their width is what the band needs; once Ask has yielded they may shrink again (the primary's "…").
  const fitBand = (room: number, needed: number) => {
    if (compact && asking !== null && !askYields && room > 0 && needed > room) setBandNeed(needed);
  };
  const onBandRoom = (event: LayoutChangeEvent) => {
    const room = event.nativeEvent.layout.width;
    setBandRoom(room);
    fitBand(room, bandControlsWidth.current);
  };
  const onBandControls = (event: LayoutChangeEvent) => {
    if (askYields) return;
    bandControlsWidth.current = event.nativeEvent.layout.width;
    fitBand(bandRoom ?? 0, bandControlsWidth.current);
  };
  const extraItems = props.overflowItems ?? [];
  // Make task is a rarer action than Ask, so it is always a row of ⋯. On a phone the source's write is one too; a
  // write with several methods keeps them as one group.
  const write = compact ? props.sourceWrite : undefined;
  const writeBlocked = write === undefined ? false
    : write.pending || write.reading === true || write.disabledReason !== null || (write.methods !== undefined && write.methods.length === 0);
  const writeMethods = write?.methods !== undefined && write.methods.length > 1 && !writeBlocked ? write.methods : null;
  const writeShown = write !== undefined && !triageSourceWriteReplacedByNativeStateV1(write);
  const hasOverflow = overflowActions.length > 0 || extraItems.length > 0 || mergeChoices !== null
    || props.taskDraft !== undefined || writeShown;
  // The reason a control cannot start sits with that control: under the row when a blocked action is in sight,
  // as the subtitle of its own menu row when it waits behind More, so the row never says "cannot" beside an action
  // that can.
  const isBlocked = (action: TriageActionV1 | null) => action !== null && isTriageActionBlockedV1(action, reviewPreparation);
  // Only a source that can never prepare a workspace owes the reader that sentence; a read still pending says nothing.
  const sourceCannotPrepare = reviewPreparation === 'unsupported';
  const blockedInRow = sourceCannotPrepare && (isBlocked(primary) || isBlocked(beside));
  const preparationReasonLabel = text('plugins.triage.surface.session.preparationUnsupported', NO_PREPARATION_COPY);
  const retryLabel = text('plugins.triage.surface.actions.retry', 'Retry');
  const preparationReason = (
    <Status
      tone="muted"
      labelKey="plugins.triage.surface.session.preparationUnsupported"
      label={NO_PREPARATION_COPY}
    />
  );
  // A renamed control shows the person's own words in every locale; a still-shipped one keeps its translation.
  // `titleKey` is therefore resolved from the record, never stored in it.
  const button = (action: TriageActionV1, onPress: (request: TriageEntryActionRequestV1) => void, split?: Readonly<{ label?: string }>,
    glyph?: 'conversations') => (
    <TriageEntryActionButton
      key={action.actionId}
      action={action}
      entryRef={entryRef}
      sourceInstanceId={sourceInstanceId}
      blocked={isTriageActionBlockedV1(action, reviewPreparation)}
      primary={action.actionId === primaryActionId}
      withoutRepository={props.withoutRepository === true}
      singleLine={compact && action === primary}
      {...(glyph === undefined ? {} : { glyph })}
      {...(split === undefined ? {} : { joinedEdge: 'end' as const, ...(split.label === undefined ? {} : { label: split.label }) })}
      onPress={onPress}
    />
  );
  const moreLabel = text('plugins.triage.surface.detail.moreActions', 'More actions');
  const actionItemId = (action: TriageActionV1) => `${ACTION_ITEM_PREFIX}${action.actionId}`;
  // The Start split (lab t1 `tasks-start`): the primary agent action can also go to the agent and machine the
  // reader chooses, or to a Session already running. Same action, same controller; only the destination differs.
  const startDestinations = primary !== null && primary.target.kind === 'agent' && !isBlocked(primary);
  const startTarget = startChoices.defaultTarget.status === 'ready' ? startChoices.defaultTarget : null;
  const primaryWords = primary === null ? '' : (() => {
    const key = readTriageActionTitleKeyV1(primary);
    if (props.withoutRepository === true && key !== null && primary.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1) {
      return text('plugins.triage.surface.actions.start', 'Start');
    }
    return key === null ? primary.label : text(key, primary.label);
  })();
  const startWithLabel = startTarget?.agent == null ? undefined
    : text('plugins.triage.surface.actions.withAgent', '{action} with {agent}', { action: primaryWords, agent: startTarget.agent.label });
  const recentRows = startChoices.recentSessions.status !== 'ready' ? []
    : startChoices.recentSessions.items.filter((row) => row.serverId !== undefined).slice(0, START_MENU_RECENT_ROWS);
  // Lab t1: recent Sessions under their own label, then the way to every Session; with none, only that way.
  const startGroups = [{
    id: 'triage-start:recent',
    accessibilityLabel: text('plugins.triage.surface.actions.sendToSessionGroup', 'Send to a Session'),
    // A few recent rows, then the way to every Session (lab t1 start): the menu never runs past the screen.
    items: [
      ...recentRows.map((row) => {
        // What it is doing only when the host says it is working, then where it runs: its workspace (unless the title
        // already names it), its machine, and its Home.
        // A managed workspace's folder is a content hash, not a name; the host shows its machine instead, and so does this.
        const tail = row.path?.split(/[\\/]/u).filter((part) => part !== '').at(-1);
        const workspace = tail === undefined || /^[0-9a-f]{24,}$/iu.test(tail) ? undefined : tail;
        const where = [
          row.runtimeActivityState === 'active' ? text('plugins.triage.surface.actions.sessionWorking', 'Working') : undefined,
          workspace !== undefined && workspace.toLowerCase() !== row.title?.trim().toLowerCase() ? workspace : undefined,
          row.host ?? row.locationLabel,
          row.serverName,
        ].filter((part) => part !== undefined && part !== '').join(' · ');
        return {
          id: `${RECENT_SESSION_ITEM_PREFIX}${String(row.serverId)}\u001f${row.id}`,
          label: row.title ?? text('plugins.triage.surface.actions.untitledSession', 'Untitled Session'),
          ...(where === '' ? {} : { subtitle: where }),
        };
      }),
      recentRows.length === 0
        ? { id: EXISTING_SESSION_ITEM_ID, label: text('plugins.triage.surface.actions.sendToSession', 'Send to a Session…') }
        : { id: EXISTING_SESSION_ITEM_ID, label: text('plugins.triage.surface.actions.findSession', 'Find a Session…') },
    ],
  }];
  const selectStartItem = (id: string) => {
    if (primary === null) return;
    const recent = recentRows.find((row) => `${RECENT_SESSION_ITEM_PREFIX}${String(row.serverId)}\u001f${row.id}` === id);
    if (recent?.serverId !== undefined) {
      press({ action: primary, entryRef, sourceInstanceId, existingSession: { serverId: recent.serverId, sessionId: recent.id } });
      return;
    }
    if (id === EXISTING_SESSION_ITEM_ID) press({ action: primary, entryRef, sourceInstanceId, destinationChoice: 'existingSession' });
  };
  const launchPrimary = (launchMode: TriageActionLaunchModeV1) => {
    if (primary !== null) press({ action: primary, entryRef, sourceInstanceId, launchMode });
  };
  // A start runs with nobody at the keyboard, so an action that names no task can only open the composer.
  const startUnavailable = primary === null || applyTriageActionLaunchModeV1(primary, 'start') !== null ? undefined
    : text('plugins.triage.surface.actions.startNeedsTask', 'This action names no task, so it opens the composer.');
  const actionMenuItem = (action: TriageActionV1) => {
    const titleKey = readTriageActionTitleKeyV1(action);
    const blocked = isTriageActionBlockedV1(action, reviewPreparation);
    const starts = props.withoutRepository === true && titleKey !== null && action.actionId === TRIAGE_DEFAULT_FIX_ACTION_ID_V1;
    return {
      id: actionItemId(action),
      label: starts ? text('plugins.triage.surface.actions.start', 'Start')
        : titleKey === null ? action.label : text(titleKey, action.label),
      ...(blocked ? { disabled: true } : {}),
      ...(blocked && sourceCannotPrepare ? { subtitle: preparationReasonLabel } : {}),
    };
  };
  const menuItems = [
    // Ask that left the band is the menu's first row: it is still the one quiet question beside the primary.
    ...(askYields && asking !== null ? [actionMenuItem(asking)] : []),
    ...(mergeChoices === null ? [] : mergeChoices.readinessItems),
    ...(!writeShown || write === undefined || writeMethods !== null ? [] : [{
      id: `${SOURCE_WRITE_ITEM_PREFIX}write`,
      label: write.methods?.length === 1 && !writeBlocked ? write.methods[0]!.title : write.title,
      ...(writeBlocked ? { disabled: true } : {}),
      ...(write.disabledReason == null ? {} : { subtitle: write.disabledReason }),
    }]),
    // The source's re-read stays with its write: the row right under it, never a line under the band.
    ...(!writeShown || write?.retry === undefined || write.disabledReason == null ? [] : [{
      id: `${SOURCE_WRITE_ITEM_PREFIX}retry`, label: retryLabel,
    }]),
    ...(props.taskDraft !== undefined ? [{
      id: MAKE_TASK_ITEM_ID, label: makeTask.label, ...(makeTask.busy ? { disabled: true } : {}),
    }] : []),
    ...overflowActions.filter((action) => action !== asking).map(actionMenuItem),
    ...extraItems.map((item) => ({
      id: `${EXTRA_ITEM_PREFIX}${item.id}`,
      label: item.label,
      ...(item.disabled === true ? { disabled: true } : {}),
    })),
    ...(mergeChoices === null ? [] : mergeChoices.items),
  ];
  // The source's merge alternatives follow the entry's own actions in the same ⋯; a merge method choice keeps its group.
  const menuGroups = [
    ...(writeMethods === null || write === undefined ? [] : [{
      id: `${SOURCE_WRITE_ITEM_PREFIX}methods`,
      accessibilityLabel: write.title,
      items: writeMethods.map((method) => ({ id: `${SOURCE_WRITE_ITEM_PREFIX}method:${method.id}`, label: method.title })),
    }]),
    ...(mergeChoices === null ? [] : mergeChoices.groups),
  ];
  const selectMenuItem = (id: string) => {
    setMoreOpen(false);
    if (id === MAKE_TASK_ITEM_ID) { void makeTask.run(); return; }
    if (id === `${SOURCE_WRITE_ITEM_PREFIX}retry`) { void write?.retry?.(); return; }
    if (write !== undefined && id.startsWith(SOURCE_WRITE_ITEM_PREFIX)) {
      const method = id.startsWith(`${SOURCE_WRITE_ITEM_PREFIX}method:`) ? id.slice(`${SOURCE_WRITE_ITEM_PREFIX}method:`.length)
        : write.methods?.length === 1 ? write.methods[0]!.id : undefined;
      void (method === undefined ? write.execute() : write.execute(method));
      return;
    }
    if (mergeChoices !== null && mergeChoices.run(id)) return;
    const action = overflowActions.find((candidate) => actionItemId(candidate) === id);
    if (action !== undefined) {
      press({ action, entryRef, sourceInstanceId });
      return;
    }
    extraItems.find((item) => `${EXTRA_ITEM_PREFIX}${item.id}` === id)?.onPress();
  };

  const controls = (
    <>
      {primary === null ? null : !startDestinations ? (
        compact ? <Stack style={COMPACT_PRIMARY_STYLE_V1}>{button(primary, press)}</Stack> : button(primary, press)
      ) : (
        // One control with two presses (lab c7/t1, owner ruling 2026-11-07): the action in its own launch mode,
        // and on its chevron the other launch, editing it, and the Sessions it can be sent to.
        <AgentActionButton
          title={startWithLabel ?? primaryWords}
          actionName={primaryWords}
          launchMode={readTriageActionLaunchModeV1(primary)}
          {...(startUnavailable === undefined ? {} : { startUnavailableReason: startUnavailable })}
          compact={compact}
          groups={startGroups}
          showGroupLabels={recentRows.length > 0}
          onMenuOpenChange={setStartOpen}
          onLaunch={launchPrimary}
          {...(props.onEditAction === undefined ? {} : { onEdit: () => { props.onEditAction?.(primary.actionId); } })}
          onSelectDestination={selectStartItem}
        />
      )}
      {beside === null ? null : compact ? <Stack style={COMPACT_KEEP_STYLE_V1}>{button(beside, press, undefined, 'conversations')}</Stack> : button(beside, press)}
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
      {/* The source's own write follows ⋯. It arrives with the source's body, after the row has painted, so in this
          place it joins the row without moving anything already there (lab b4/c7 drew it before ⋯). */}
      {props.sourceWrite === undefined || (compact && writeShown) ? null
        : <TriageSourceWriteCluster write={props.sourceWrite} sourceLabel={props.sourceLabel} choices="host" />}
    </>
  );

  return (
    <Stack gap="small">
      <Row gap="small" align="center" wrap={!compact}>
        {props.leading ?? null}
        {compact ? (
          <Row grow gap="small" align="center" onLayout={onBandRoom} testID={TRIAGE_ACTION_BAND_ROOM_TEST_ID_V1}>
            <Row gap="small" align="center" onLayout={onBandControls} testID={TRIAGE_ACTION_BAND_CONTROLS_TEST_ID_V1}
              style={asking !== null && !askYields ? COMPACT_BAND_OWN_WIDTH_STYLE_V1 : COMPACT_BAND_SHRINK_STYLE_V1}>
              {controls}
            </Row>
          </Row>
        ) : controls}
        {/* The far end of the one action row (lab b4/c7) is why the entry is here, alone: never a control. */}
        {props.trailing === undefined || props.trailing === null ? null : (
          <Row gap="small" align="center" wrap style={TRAILING_STYLE_V1}>
            {props.trailing}
          </Row>
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
      {/* On a phone the write is a row of ⋯, which carries this reason (and its re-read) itself. */}
      {props.sourceWrite?.disabledReason == null || props.sourceWrite.reading === true || writeShown
        || triageSourceWriteReplacedByNativeStateV1(props.sourceWrite) ? null : (
        <Row gap="small" align="center" wrap>
          <Status tone="muted" label={props.sourceWrite.disabledReason} />
          {props.sourceWrite.retry === undefined ? null : (
            <Button title={retryLabel} variant="plain" size="small" onPress={() => { void props.sourceWrite?.retry?.(); }} />
          )}
        </Row>
      )}
      {props.sourceWrite?.feedback == null ? null : props.sourceWrite.feedback}
      {/* On a phone the band stays one row: the detail places the open section in its story, not in the band. */}
      {compact ? null : props.section ?? null}
    </Stack>
  );
}

/** The Start menu shows the lab's few recent Sessions; Find a Session… reaches every other one. */
const START_MENU_RECENT_ROWS = 3;

const COMPACT_PRIMARY_STYLE_V1 = Object.freeze({ flexShrink: 1, minWidth: 0 });
/**
 * In the pinned phone band Ask is the chat glyph, named "Ask" (lab merged-detail-pr phone; owner 2026-11-11). It keeps
 * its own width; where the band cannot hold it beside the primary's whole word, it is a row of ⋯ instead.
 */
const COMPACT_KEEP_STYLE_V1 = Object.freeze({ flexShrink: 0 });
/** While Ask stands beside the primary, the band's controls take their own widths, so the band can tell whether they fit. */
const COMPACT_BAND_OWN_WIDTH_STYLE_V1 = Object.freeze({ flexShrink: 0 });
/** With nothing left to yield, the primary gives up width last and ends in "…". */
const COMPACT_BAND_SHRINK_STYLE_V1 = Object.freeze({ flexShrink: 1, minWidth: 0 });

/** The pinned band's room and its controls, by the layouts that decide whether Ask yields into ⋯. */
export const TRIAGE_ACTION_BAND_ROOM_TEST_ID_V1 = 'triage-action-band-room';
export const TRIAGE_ACTION_BAND_CONTROLS_TEST_ID_V1 = 'triage-action-band-controls';

/** The attention reason sits at the far end of the action row, as the lab places it. */
const TRAILING_STYLE_V1 = Object.freeze({ marginLeft: 'auto' as const, justifyContent: 'flex-end' as const });

/** The action that leads the row. With nothing pressable, the first offered action still leads, disabled, beside the reason it cannot start. */
function readTriageEntryPrimaryActionV1(
  offered: readonly TriageActionV1[],
  reviewPreparation: TriageReviewPreparationV1,
  workflowSubject: TriageSourceWorkflowSubjectV1,
  viewerIsAuthor: boolean,
): TriageActionV1 | null {
  const primaryActionId = readTriagePrimaryActionIdV1(offered, reviewPreparation, { workflowSubject, viewerIsAuthor });
  return offered.find((action) => action.actionId === primaryActionId) ?? offered[0] ?? null;
}
