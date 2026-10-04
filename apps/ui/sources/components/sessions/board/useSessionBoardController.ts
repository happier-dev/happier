import * as React from 'react';

import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import {
    sessionBoardHostedHtmlDraftBufferKey,
    sessionBoardNoteDraftBufferKey,
    useSessionBoardContinuity,
} from './SessionBoardContinuity';

import type { PluginContributionIdentityV1 } from '@happier-dev/protocol';
import {
    readSessionSurfaceNoteTextV1,
    SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
    sessionBoardPlacedWidthRetainsPlacementV1,
    SessionSurfaceItemV1Schema,
    type SessionBoardActionFailureV1,
    type SessionBoardActionRecoveryEvidenceV1,
    type SessionBoardItemWidth,
    type SessionBoardItemFrameStyle,
    type SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import {
    resolveActiveSessionBoardViewId,
    selectSessionBoardView,
    SESSION_BOARD_OVERVIEW_VIEW_ID,
    type SessionBoardActionOutcome,
    type SessionBoardActionsPort,
    type SessionBoardItemRemoveInput,
    type SessionBoardItemUpsertInput,
    type SessionBoardLayoutUpdateInput,
    type SessionBoardItemPlacementInput,
    type SessionBoardMutationResult,
    type SessionBoardSnapshot,
    type SessionBoardViewProjection,
} from '@/sync/domains/session/board';
import {
    classifySessionBoardMutationApprovalFailure,
    type SessionBoardMutationApprovalRequest,
} from './sessionBoardMutationApproval';
import { resolveSessionBoardFailurePresentation } from './sessionBoardFailurePresentation';

import type { SessionBoardBinding } from './observeSessionBoard';
import {
    defaultSessionBoardSourceAvailability,
    isSessionBoardItemEditableInPlace,
    type SessionBoardSourceAvailabilityResolver,
} from './sessionBoardItemPresentation';

/**
 * The ONE mounted Board controller.
 *
 * Every Board host renders the same surface, and that surface asks this controller
 * two questions: is this command genuinely supported here, and what happened when
 * I ran it. Everything else it used to receive — a dozen independent optional
 * callbacks, each free to be absent for a different unstated reason — collapses
 * into this one owner.
 *
 * Three rules it exists to enforce:
 *
 * - A command with no real producer is **absent**, never a control that does
 *   nothing when pressed.
 * - A mutation is never fire-and-forget. Approval, conflict, unknown outcome,
 *   denial and offline are typed results that reach the person.
 * - **Freshness is not permission.** A reachable but stale snapshot with a current
 *   Lane 04 capability stays editable and lets CAS decide concurrency; only
 *   offline/unknown reachability or a lost capability pauses writes.
 *
 * It owns no transport and no shared state: reads come from the Plan 02
 * repository through {@link SessionBoardBinding}, writes go through the same four
 * Board Actions an Agent uses, and the active Board view is viewer-local and never
 * persisted.
 */

/**
 * What this Board can add. `fromPlugins` is an availability fact only: the Add popover lists the
 * installed widgets itself and creates one through `item.addInstalled`.
 */
export type SessionBoardAddIntent = 'note' | 'walkthrough' | 'interactiveView' | 'fromPlugins' | 'askAgent';

export type SessionBoardCommand =
    | Readonly<{ kind: 'add'; intent: Exclude<SessionBoardAddIntent, 'fromPlugins'> }>
    /**
     * Create one installed-plugin widget from the Add popover, placed on the view
     * being read. The item persists
     * the stable qualified surface identity and nothing else; the current
     * generation, renderer, origin and Artifact are resolved at every mount.
     */
    | Readonly<{
        kind: 'item.addInstalled';
        surface: PluginContributionIdentityV1;
        title: string;
    }>
    | Readonly<{ kind: 'item.edit'; itemId: string }>
    | Readonly<{ kind: 'item.rename'; itemId: string; title: string }>
    | Readonly<{ kind: 'item.resize'; itemId: string; width: SessionBoardItemWidth }>
    | Readonly<{ kind: 'item.frameStyle'; itemId: string; frameStyle: SessionBoardItemFrameStyle | null }>
    /** Height is item content, not placement: it stays coherent across every view. */
    | Readonly<{ kind: 'item.height'; itemId: string; height: SessionSurfaceItemV1['height'] }>
    | Readonly<{ kind: 'item.move'; itemId: string; direction: 'before' | 'after' }>
    | Readonly<{
        kind: 'item.moveAnchored';
        itemId: string;
        fromViewId: string;
        toViewId: string;
        anchor?: Readonly<{ side: 'before' | 'after'; itemId: string }>;
    }>
    | Readonly<{ kind: 'item.moveToView'; itemId: string; viewId: string }>
    | Readonly<{ kind: 'item.remove'; itemId: string }>
    /** Place a readable item the shared layout does not place anywhere. */
    | Readonly<{ kind: 'item.pin'; itemId: string }>
    /** Drop this view's placement only; the shared item record survives. */
    | Readonly<{ kind: 'item.unpin'; itemId: string }>
    | Readonly<{ kind: 'item.openHere'; itemId: string }>
    | Readonly<{ kind: 'item.managePlugin'; itemId: string }>
    | Readonly<{ kind: 'item.prepareEncryption' }>
    | Readonly<{ kind: 'view.select'; viewId: string }>
    | Readonly<{ kind: 'view.create' }>
    | Readonly<{ kind: 'view.rename'; viewId: string; title: string }>
    | Readonly<{ kind: 'view.move'; viewId: string; direction: 'before' | 'after' }>
    | Readonly<{ kind: 'view.remove'; viewId: string }>;

export type SessionBoardCommandKind = SessionBoardCommand['kind'];

/** What the person is told after a mutation. `null` while nothing has been run. */
export type SessionBoardCommandOutcome =
    | Readonly<{ kind: 'applied' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'approvalPending'; artifactId: string; actionId: string }>
    | Readonly<{
        kind: 'conflict';
        currentItemRevision?: string | null;
        currentLayoutRevision?: string | null;
    }>
    | Readonly<{ kind: 'outcomeUnknown'; recovery: SessionBoardActionRecoveryEvidenceV1 | null }>
    | Readonly<{ kind: 'denied' }>
    | Readonly<{ kind: 'unavailable'; reason: string }>
    | Readonly<{ kind: 'failed'; error: string }>;

/** Why durable Board writes are paused. Never set for a merely stale snapshot. */
export type SessionBoardMutationBlockedReason = 'offline' | 'no_capability' | 'no_producer' | 'approval_pending';

type SessionBoardMutationSubmission =
    | Readonly<{ actionId: 'session.board.item.upsert'; input: SessionBoardItemUpsertInput }>
    | Readonly<{ actionId: 'session.board.item.remove'; input: SessionBoardItemRemoveInput }>
    | Readonly<{ actionId: 'session.board.layout.update'; input: SessionBoardLayoutUpdateInput }>;

export type SessionBoardRetainedMutation = Readonly<{
    kind: 'approvalPending' | 'conflict' | 'outcomeUnknown';
    command: SessionBoardCommand;
    submission: SessionBoardMutationSubmission;
    baselineSnapshot: SessionBoardSnapshot;
    /** A completed stale→fresh or refreshing→settled repository cycle was observed. */
    refreshObserved: boolean;
    ready: boolean;
    onApplied?: () => void;
}>;

export type SessionBoardNoteDraft = Readonly<{
    itemId: string;
    expectedItemRevision: string | null;
    initialTitle: string;
    initialBody: string;
    /** The opened item whose non-content presentation fields an edit must retain. */
    baseItem?: SessionSurfaceItemV1;
    placement?: SessionBoardItemPlacementInput;
}>;

export type SessionBoardHostedHtmlDraft = Readonly<{
    itemId: string;
    expectedItemRevision: string | null;
    initialTitle: string;
    initialHtml: string;
    /** Existing item whose presentation/capability fields an edit must retain. */
    baseItem?: SessionSurfaceItemV1;
    placement?: SessionBoardItemPlacementInput;
}>;

export type SessionBoardViewRemovalDisposition =
    | Readonly<{ kind: 'move'; viewId: string }>
    | Readonly<{ kind: 'unpin' }>;

export type SessionBoardViewRemovalChoiceRequest = Readonly<{
    source: Readonly<{ viewId: string; title: string }>;
    eligibleDestinations: ReadonlyArray<Readonly<{ viewId: string; title: string }>>;
}>;

export type SessionBoardControllerInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
    binding: SessionBoardBinding & Readonly<{ refresh?: () => void | Promise<void> }>;
    /** `null` while Lane 08.04's Action adapter is absent: every write command is then absent too. */
    actions: SessionBoardActionsPort | null;
    /** The incumbent Action approval owner currently holds one exact Board mutation. */
    approvalPending?: boolean;
    /** Register exact result custody; this callback never re-executes the mutation. */
    requestApprovalContinuation?: (request: SessionBoardMutationApprovalRequest) => void;
    /** Inserts a bounded editable suggestion into the incumbent Session composer. */
    onAskAgent?: () => void;
    /** Hand an item to the placement that can run it. */
    onOpenItemHere?: (itemId: string) => void;
    onManagePlugin?: (itemId: string) => void;
    onPrepareEncryption?: () => void;
    /** Exact current renderer/plugin admission for this device, from the host's PEP projection. */
    resolveSourceAvailability?: SessionBoardSourceAvailabilityResolver;
    /**
     * Whether this Session's exact plugin projection admits any `widget`.
     * `false` removes **From plugins…** from the Add menu entirely rather than
     * opening a picker with nothing in it.
     */
    installedWidgetsAvailable?: boolean;
    /** Exact Session caller-hosted runtime admission for this device/account. */
    callerHostedHtmlAvailable?: boolean;
    /** Destructive confirmation host. Injected so the shared Actions decision owns the policy. */
    confirmDestructive?: (request: Readonly<{
        title: string;
        message: string;
        confirmText: string;
        /** Viewer-local Board view whose native tab should regain focus after the dialog. */
        focusReturnViewId?: string;
    }>) => Promise<boolean>;
    /** Explicit item disposition required before a non-empty Board view may be removed. */
    chooseViewRemovalDisposition?: (
        request: SessionBoardViewRemovalChoiceRequest,
    ) => Promise<SessionBoardViewRemovalDisposition | null>;
    /** Board-view title host (create/rename). */
    promptViewTitle?: (request: Readonly<{ title: string; defaultValue?: string }>) => Promise<string | null>;
    /** Run a draft-replacing transition through the mounted editor's canonical guard. */
    beforeReplaceNoteDraft?: (replace: () => void | Promise<void>) => true | Promise<boolean>;
}>;

export type SessionBoardController = Readonly<{
    snapshot: SessionBoardSnapshot | null;
    activeViewId: string;
    activeView: SessionBoardViewProjection | null;
    /** One-shot handoff after an applied selected-view removal reaches the authoritative layout. */
    viewRemovalFocusRequest: Readonly<{ removedViewId: string; requestId: number }> | null;
    acknowledgeViewRemovalFocus: (requestId: number) => void;
    /** Readable items the shared layout places nowhere; recoverable through `item.pin`. */
    recoveredItemIds: readonly string[];
    /** Add sources with a real producer, in menu order. Empty means: offer no Add menu. */
    addIntents: readonly SessionBoardAddIntent[];
    mutationsBlockedReason: SessionBoardMutationBlockedReason | null;
    busy: boolean;
    noteDraft: SessionBoardNoteDraft | null;
    closeNoteDraft: () => void;
    onNoteSaved: (result: SessionBoardMutationResult | null, committedItemRevision?: string | null, draftSettled?: boolean) => void;
    /** Exact one-shot handoff from a successful editor save to its surviving card heading. */
    headingFocusRequest: Readonly<{ itemId: string; requestId: number }> | null;
    acknowledgeHeadingFocus: (requestId: number) => void;
    hostedHtmlDraft: SessionBoardHostedHtmlDraft | null;
    closeHostedHtmlDraft: () => void;
    onHostedHtmlSaved: (result?: SessionBoardMutationResult | null, committedItemRevision?: string | null, draftSettled?: boolean) => void;
    /** The latest mutation result, for surfaces that want it inline as well as in the notice. */
    lastOutcome: SessionBoardCommandOutcome | null;
    /** Exact unresolved generic mutation retained by this mounted controller. */
    mutationRecovery: Readonly<{ kind: 'conflict' | 'outcomeUnknown'; ready: boolean }> | null;
    /** Deliberate re-entry through the ordinary command path; never an automatic replay. */
    retryLastMutation: () => Promise<void>;
    /** A one-shot polite announcement, e.g. the active view was removed remotely. */
    announcement: string | null;
    supports: (kind: SessionBoardCommandKind) => boolean;
    /** Exact item-level Edit handler truth, including source runtime admission. */
    supportsItemEdit: (itemId: string) => boolean;
    run: (command: SessionBoardCommand) => Promise<void>;
    resolveSourceAvailability: SessionBoardSourceAvailabilityResolver;
}>;

/** Translate one Action outcome into the result the person is shown. */
export function describeSessionBoardOutcome(
    outcome: SessionBoardActionOutcome<SessionBoardMutationResult>,
): SessionBoardCommandOutcome {
    switch (outcome.status) {
        case 'ok':
            return { kind: 'applied' };
        case 'pending_approval':
            return {
                kind: 'approvalPending',
                artifactId: outcome.approval.artifactId,
                actionId: outcome.approval.actionId,
            };
        case 'outcome_unknown':
            return { kind: 'outcomeUnknown', recovery: outcome.recovery };
        case 'unavailable':
            return { kind: 'unavailable', reason: outcome.reason };
        case 'refused':
            switch (outcome.error.error) {
                case 'session_board_revision_conflict':
                    return {
                        kind: 'conflict',
                        ...(outcome.error.currentItemRevision !== undefined
                            ? { currentItemRevision: outcome.error.currentItemRevision }
                            : {}),
                        ...(outcome.error.currentLayoutRevision !== undefined
                            ? { currentLayoutRevision: outcome.error.currentLayoutRevision }
                            : {}),
                    };
                case 'session_board_source_conflict':
                    return { kind: 'conflict' };
                case 'session_board_forbidden':
                    return { kind: 'denied' };
                default:
                    return { kind: 'failed', error: outcome.error.error };
            }
        case 'failed':
            return { kind: 'failed', error: outcome.code };
        case 'cancelled':
            return { kind: 'cancelled' };
    }
}

function describeSessionBoardApprovalFailure(
    code: string,
    actionFailure?: SessionBoardActionFailureV1,
): SessionBoardCommandOutcome {
    const failure = classifySessionBoardMutationApprovalFailure(code);
    if (failure === 'cancelled') return { kind: 'cancelled' };
    if (failure === 'denied') return { kind: 'denied' };
    if (failure === 'conflict') {
        const details = actionFailure?.errorCode === 'session_board_revision_conflict'
            && 'details' in actionFailure
            ? actionFailure.details
            : undefined;
        return {
            kind: 'conflict',
            ...(details?.currentItemRevision !== undefined
                ? { currentItemRevision: details.currentItemRevision }
                : {}),
            ...(details?.currentLayoutRevision !== undefined
                ? { currentLayoutRevision: details.currentLayoutRevision }
                : {}),
        };
    }
    if (failure === 'outcomeUnknown') {
        const recovery = actionFailure?.errorCode === 'outcome_unknown'
            && 'details' in actionFailure
            ? actionFailure.details.recovery
            : null;
        return { kind: 'outcomeUnknown', recovery };
    }
    // An executed approval whose acknowledgement is unknown is never replayed.
    // Its exact failure remains visible and the repository refresh below is the
    // only recovery action this mounted controller performs automatically.
    return { kind: 'failed', error: code };
}

function outcomeNotice(outcome: SessionBoardCommandOutcome): Readonly<{
    message: string;
    severity: 'info' | 'warning' | 'error';
}> | null {
    switch (outcome.kind) {
        case 'applied':
            return { message: t('common.done'), severity: 'info' };
        case 'cancelled':
            return null;
        case 'approvalPending':
            return { message: t('approvals.status.open'), severity: 'info' };
        case 'conflict':
            return resolveSessionBoardFailurePresentation('session_board_revision_conflict');
        case 'outcomeUnknown':
            return resolveSessionBoardFailurePresentation('outcome_unknown');
        case 'denied':
            return resolveSessionBoardFailurePresentation('session_board_forbidden');
        case 'unavailable': {
            const presentation = resolveSessionBoardFailurePresentation(outcome.reason);
            return { message: presentation.message, severity: presentation.severity };
        }
        case 'failed':
            return resolveSessionBoardFailurePresentation(outcome.error);
    }
}

/** Board-view titles are shared author copy; only a synthetic Overview is localized. */
function viewTitle(view: SessionBoardViewProjection | null | undefined): string {
    const raw = view?.title?.trim();
    return raw && raw.length > 0 ? raw : t('sessionBoard.views.overview');
}

function boardNoticeAddressKey(serverId: string | null | undefined, sessionId: string): string {
    const address = normalizeSessionAddress(serverId ?? null, sessionId);
    return address ? sessionAddressKey(address) : JSON.stringify([null, sessionId]);
}

function boardCommandNoticeTarget(command: SessionBoardCommand): string | null {
    if ('itemId' in command) return command.itemId;
    if ('viewId' in command) return command.viewId;
    if (command.kind === 'add') return command.intent;
    if (command.kind === 'item.addInstalled') {
        return JSON.stringify([command.surface.pluginId, command.surface.localId]);
    }
    return null;
}

function placedItemIds(view: SessionBoardViewProjection | undefined): readonly string[] {
    return view?.placements.map((placement) => placement.itemId) ?? [];
}

function isAnchoredAt(
    ids: readonly string[],
    id: string,
    anchor: Readonly<{ side: 'before' | 'after'; itemId: string }> | undefined,
): boolean {
    const index = ids.indexOf(id);
    if (index < 0) return false;
    if (!anchor) return index === ids.length - 1;
    const anchorIndex = ids.indexOf(anchor.itemId);
    return anchorIndex >= 0 && index === anchorIndex + (anchor.side === 'after' ? 1 : -1);
}

function isTabAnchoredAt(
    ids: readonly string[],
    id: string,
    anchor: Readonly<{ side: 'before' | 'after'; tabId: string }> | undefined,
): boolean {
    const index = ids.indexOf(id);
    if (index < 0) return false;
    if (!anchor) return index === ids.length - 1;
    const anchorIndex = ids.indexOf(anchor.tabId);
    return anchorIndex >= 0 && index === anchorIndex + (anchor.side === 'after' ? 1 : -1);
}

function canonicalItemsEqual(left: SessionSurfaceItemV1, right: SessionSurfaceItemV1): boolean {
    const leftParsed = SessionSurfaceItemV1Schema.safeParse(left);
    const rightParsed = SessionSurfaceItemV1Schema.safeParse(right);
    return leftParsed.success
        && rightParsed.success
        && JSON.stringify(leftParsed.data) === JSON.stringify(rightParsed.data);
}

/**
 * Decide only from the canonical refreshed Board projection whether the exact
 * retained mutation's requested effect now exists. Revisions fence off a
 * pre-existing equal-looking value; semantic checks prevent an unrelated later
 * write from being mistaken for this effect.
 */
function isRetainedSessionBoardMutationApplied(
    retained: SessionBoardRetainedMutation,
    snapshot: SessionBoardSnapshot,
): boolean {
    const submission = retained.submission;
    if (submission.actionId === 'session.board.item.upsert') {
        const current = snapshot.itemsById.get(submission.input.itemId);
        if (
            !current
            || current.revision === null
            || current.revision === submission.input.expectedItemRevision
            || current.state.kind !== 'ready'
            || !canonicalItemsEqual(current.state.item, submission.input.item)
        ) return false;
        const placement = submission.input.placement;
        if (!placement) return true;
        if (snapshot.layoutRevision === retained.baselineSnapshot.layoutRevision) return false;
        const view = snapshot.views.find((candidate) => candidate.id === (placement.tabId ?? SESSION_BOARD_OVERVIEW_VIEW_ID));
        const currentPlacement = view?.placements.find((candidate) => candidate.itemId === submission.input.itemId);
        return currentPlacement !== undefined
            && sessionBoardPlacedWidthRetainsPlacementV1(currentPlacement.width, placement)
            && isAnchoredAt(placedItemIds(view), submission.input.itemId, placement.anchor);
    }

    if (submission.actionId === 'session.board.item.remove') {
        return snapshot.layoutRevision !== submission.input.expectedLayoutRevision
            && !snapshot.itemsById.has(submission.input.itemId)
            && snapshot.views.every((view) => !view.placements.some((placement) => placement.itemId === submission.input.itemId));
    }

    if (snapshot.layoutRevision === submission.input.expectedLayoutRevision) return false;
    const operation = submission.input.operation;
    const views = snapshot.views.filter((view) => !view.synthetic);
    const viewIds = views.map((view) => view.id);
    switch (operation.op) {
        case 'tab.create': {
            const created = views.find((view) => view.id === operation.tabId);
            return created?.title === operation.title
                && isTabAnchoredAt(viewIds, operation.tabId, operation.anchor);
        }
        case 'tab.rename':
            return views.find((view) => view.id === operation.tabId)?.title === operation.title;
        case 'tab.move':
            return isTabAnchoredAt(viewIds, operation.tabId, operation.anchor);
        case 'tab.remove': {
            if (views.some((view) => view.id === operation.tabId)) return false;
            const disposition = operation.disposition;
            if (disposition.kind === 'unpin') return true;
            const before = retained.baselineSnapshot.views.find((view) => view.id === operation.tabId);
            const destination = views.find((view) => view.id === disposition.tabId);
            const destinationIds = new Set(placedItemIds(destination));
            return before !== undefined
                && before.placements.every((placement) => destinationIds.has(placement.itemId));
        }
        case 'item.place': {
            const view = views.find((candidate) => candidate.id === operation.tabId);
            const placement = view?.placements.find((candidate) => candidate.itemId === operation.itemId);
            return placement?.width === operation.width
                && isAnchoredAt(placedItemIds(view), operation.itemId, operation.anchor);
        }
        case 'item.move': {
            const from = views.find((view) => view.id === operation.fromTabId);
            const to = views.find((view) => view.id === operation.toTabId);
            if (operation.fromTabId !== operation.toTabId
                && from?.placements.some((placement) => placement.itemId === operation.itemId)) return false;
            return isAnchoredAt(placedItemIds(to), operation.itemId, operation.anchor);
        }
        case 'item.unpin':
            return !views.find((view) => view.id === operation.tabId)
                ?.placements.some((placement) => placement.itemId === operation.itemId);
        case 'item.unpinAll':
            return views.every((view) => !view.placements.some((placement) => placement.itemId === operation.itemId));
        case 'item.resize':
            return views.find((view) => view.id === operation.tabId)
                ?.placements.find((placement) => placement.itemId === operation.itemId)?.width === operation.width;
        case 'item.frameStyle': {
            const placement = views.find((view) => view.id === operation.tabId)
                ?.placements.find((candidate) => candidate.itemId === operation.itemId);
            return placement !== undefined && placement.frameStyle === (operation.frameStyle ?? undefined);
        }
    }
}

export function useSessionBoardController(input: SessionBoardControllerInput): SessionBoardController {
    const snapshot = input.binding.status === 'ready' ? input.binding.snapshot : null;
    const boardAddress = React.useMemo(
        () => normalizeSessionAddress(input.serverId ?? null, input.sessionId),
        [input.serverId, input.sessionId],
    );
    const continuity = useSessionBoardContinuity(boardAddress);
    const localRequestedView = React.useState<string | null>(null);
    const requestedViewState = continuity?.controller.requestedViewId ?? localRequestedView;
    const requestedViewId = requestedViewState[0];
    const setRequestedViewId = React.useCallback((viewId: string | null) => {
        requestedViewState[1](viewId);
    }, [requestedViewState]);
    const localViewRemovalFocusRequest = React.useState<Readonly<{
        removedViewId: string;
        requestId: number;
    }> | null>(null);
    const [viewRemovalFocusRequest, setViewRemovalFocusRequest] = continuity?.controller.viewRemovalFocusRequest
        ?? localViewRemovalFocusRequest;
    const nextViewRemovalFocusRequestId = React.useRef(1);
    const localNoteDraft = React.useState<SessionBoardNoteDraft | null>(null);
    const localHeadingFocusRequest = React.useState<Readonly<{
        itemId: string;
        requestId: number;
    }> | null>(null);
    const localHostedHtmlDraft = React.useState<SessionBoardHostedHtmlDraft | null>(null);
    const localLastOutcome = React.useState<SessionBoardCommandOutcome | null>(null);
    const localRetainedMutation = React.useState<SessionBoardRetainedMutation | null>(null);
    const localAnnouncement = React.useState<string | null>(null);
    const localBusy = React.useState(false);
    const [noteDraftState, setNoteDraftState] = continuity?.controller.noteDraft ?? localNoteDraft;
    const [headingFocusRequest, setHeadingFocusRequest] = continuity?.controller.headingFocusRequest ?? localHeadingFocusRequest;
    const nextHeadingFocusRequestId = React.useRef(1);
    const [hostedHtmlDraft, setHostedHtmlDraftState] = continuity?.controller.hostedHtmlDraft ?? localHostedHtmlDraft;
    const [lastOutcomeState, setLastOutcomeState] = continuity?.controller.lastOutcome ?? localLastOutcome;
    const [retainedMutationState, setRetainedMutationState] = continuity?.controller.retainedMutation ?? localRetainedMutation;
    const [announcement, setAnnouncement] = continuity?.controller.announcement ?? localAnnouncement;
    const [busy, setBusy] = continuity?.controller.busy ?? localBusy;
    const mutationInFlightRef = React.useRef(false);
    // Synchronous guard for an approval this controller just registered. The
    // provider's `approvalPending` bit owns shared editor/generic state; never
    // latch that external bit here or editor-origin settlement could not clear it.
    const approvalPendingRef = React.useRef(false);
    const noteDraftRef = React.useRef(noteDraftState);
    // Hosted HTML is read through a ref for the same reason the Note draft is:
    // a command may await the editor's guard, and a render closure captured
    // before that decision is stale by the time the transition resumes.
    const hostedHtmlDraftRef = React.useRef(hostedHtmlDraft);
    const lastOutcomeRef = React.useRef(lastOutcomeState);
    const retainedMutationRef = React.useRef(retainedMutationState);
    // A guarded Remove may save the editor before it reaches the aggregate.
    // That save advances the item CAS while repository convergence is still in
    // flight. Keep the exact committed revision in this one transition-local
    // owner; it is neither shared Board state nor a second revision authority.
    const guardedRemovalRef = React.useRef<{
        itemId: string;
        committedItemRevision: string | null;
    } | null>(null);
    const stableInputRef = React.useRef(input);
    stableInputRef.current = input;
    noteDraftRef.current = noteDraftState;
    hostedHtmlDraftRef.current = hostedHtmlDraft;
    lastOutcomeRef.current = lastOutcomeState;
    retainedMutationRef.current = retainedMutationState;
    const setNoteDraft = React.useCallback((next: SessionBoardNoteDraft | null) => {
        noteDraftRef.current = next;
        setNoteDraftState(next);
    }, [setNoteDraftState]);
    const setHostedHtmlDraft = React.useCallback((next: SessionBoardHostedHtmlDraft | null) => {
        hostedHtmlDraftRef.current = next;
        setHostedHtmlDraftState(next);
    }, [setHostedHtmlDraftState]);
    const setLastOutcome = React.useCallback((next: SessionBoardCommandOutcome | null) => {
        lastOutcomeRef.current = next;
        setLastOutcomeState(next);
    }, [setLastOutcomeState]);
    const setRetainedMutation = React.useCallback((next: SessionBoardRetainedMutation | null) => {
        retainedMutationRef.current = next;
        setRetainedMutationState(next);
    }, [setRetainedMutationState]);

    /**
     * The one item this Board is editing, whichever editor owns the draft.
     *
     * A Note draft and a hosted-HTML draft are the same unsaved human work and
     * share ONE in-place slot, so every draft-replacing intent — Add, From
     * plugins…, Edit and Remove — asks this single question instead of each
     * branch re-deciding which editor counts.
     */
    const activeDraftItemId = React.useCallback((): string | null => (
        noteDraftRef.current?.itemId ?? hostedHtmlDraftRef.current?.itemId ?? null
    ), []);

    /**
     * Retire the draft an APPLIED mutation just made unreachable, with the
     * retained input buffer that backs it.
     *
     * Every other settlement — stale CAS, denial, offline, pending approval and
     * genuine `outcomeUnknown` — keeps both, so the editor stays mounted over
     * work whose record may still exist.
     */
    const retireDraftForItem = React.useCallback((itemId: string) => {
        const note = noteDraftRef.current;
        if (note?.itemId === itemId) {
            continuity?.editorDrafts.clear(sessionBoardNoteDraftBufferKey(note.itemId, note.expectedItemRevision));
            setNoteDraft(null);
        }
        const hosted = hostedHtmlDraftRef.current;
        if (hosted?.itemId === itemId) {
            continuity?.editorDrafts.clear(sessionBoardHostedHtmlDraftBufferKey(hosted.itemId));
            setHostedHtmlDraft(null);
        }
    }, [continuity, setHostedHtmlDraft, setNoteDraft]);

    // The repository normally publishes refreshing→settled, but it may retain
    // the exact projection object when canonical bytes are unchanged. Observe
    // the refresh promise when the binding exposes one so ambiguity can still
    // become deliberately retryable without inventing a second repository fact.
    const requestMutationRecoveryRefresh = React.useCallback((retained: SessionBoardRetainedMutation) => {
        const completion = stableInputRef.current.binding.refresh?.();
        if (!completion || typeof (completion as PromiseLike<void>).then !== 'function') return;
        void Promise.resolve(completion).then(() => {
            const current = retainedMutationRef.current;
            if (current !== retained || current.kind === 'approvalPending') return;
            setRetainedMutation({ ...current, refreshObserved: true });
        });
    }, [setRetainedMutation]);

    const previousViewsRef = React.useRef<readonly SessionBoardViewProjection[]>(snapshot?.views ?? []);
    const requestedViewStillExists = snapshot?.views.some((view) => view.id === requestedViewId) === true;
    const reconciledViewId = snapshot && requestedViewId !== null && !requestedViewStillExists
        ? resolveRemovedSessionBoardViewId(previousViewsRef.current, snapshot.views, requestedViewId)
        : null;
    const activeViewId = snapshot
        ? resolveActiveSessionBoardViewId(snapshot, reconciledViewId ?? requestedViewId)
        : SESSION_BOARD_OVERVIEW_VIEW_ID;
    const activeView = snapshot ? selectSessionBoardView(snapshot, activeViewId) : null;

    // A collaborator can delete the view this person is reading. Selection is
    // viewer-local, so it is reconciled here — once, with one announcement, and
    // without writing anything back to shared Board state.
    const reconciledFrom = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!snapshot || requestedViewId === null || requestedViewId === activeViewId) return;
        if (reconciledFrom.current === requestedViewId) return;
        reconciledFrom.current = requestedViewId;
        setRequestedViewId(activeViewId);
        setAnnouncement(t('sessionBoard.views.reconciled', { title: viewTitle(activeView) }));
    }, [activeView, activeViewId, requestedViewId, snapshot]);
    React.useEffect(() => {
        if (snapshot) previousViewsRef.current = snapshot.views;
    }, [snapshot]);

    const canEdit = snapshot?.canEdit === true;
    const reachable = snapshot?.reachability === 'reachable';
    const actions = input.actions;

    // Freshness is deliberately absent from this decision.
    const mutationsBlockedReason: SessionBoardMutationBlockedReason | null = !actions
        ? 'no_producer'
        : !canEdit
            ? 'no_capability'
            : !reachable
                ? 'offline'
                : input.approvalPending === true || approvalPendingRef.current || retainedMutationState !== null
                    ? 'approval_pending'
                    : null;

    const askAgent = input.onAskAgent;
    const openItemHere = input.onOpenItemHere;
    const managePlugin = input.onManagePlugin;
    const prepareEncryption = input.onPrepareEncryption;

    const installedWidgetsAvailable = input.installedWidgetsAvailable === true;
    const callerHostedHtmlAvailable = input.callerHostedHtmlAvailable === true;
    const addIntents = React.useMemo((): readonly SessionBoardAddIntent[] => {
        const intents: SessionBoardAddIntent[] = [];
        if (mutationsBlockedReason === null) intents.push('note', 'walkthrough');
        if (mutationsBlockedReason === null && callerHostedHtmlAvailable) intents.push('interactiveView');
        // **From plugins…** appears only when this Session's exact projection
        // actually admits a `widget`.
        if (mutationsBlockedReason === null && installedWidgetsAvailable) intents.push('fromPlugins');
        if (canEdit && askAgent) intents.push('askAgent');
        return Object.freeze(intents);
    }, [askAgent, callerHostedHtmlAvailable, canEdit, installedWidgetsAvailable, mutationsBlockedReason]);

    const supports = React.useCallback((kind: SessionBoardCommandKind): boolean => {
        const settled = !mutationInFlightRef.current
            && !approvalPendingRef.current
            && guardedRemovalRef.current === null;
        const writable = mutationsBlockedReason === null && settled;
        // Opening an editor is not a mutation. The draft is local to the retained
        // editor and its Save already explains that it needs a connection to this
        // Home, so unreachability must not remove the entry point to editing text
        // the person can already read from the cached record.
        const draftable = settled
            && (mutationsBlockedReason === null || mutationsBlockedReason === 'offline');
        switch (kind) {
            case 'item.rename':
            case 'item.resize':
            case 'item.frameStyle':
            case 'item.height':
            case 'item.move':
            case 'item.moveAnchored':
            case 'item.moveToView':
            case 'item.remove':
            case 'item.pin':
            case 'item.unpin':
            case 'view.create':
            case 'view.rename':
            case 'view.move':
            case 'view.remove':
            case 'item.addInstalled':
                return writable;
            case 'item.edit':
                return draftable;
            case 'add':
                return addIntents.length > 0;
            case 'item.openHere':
                return openItemHere !== undefined;
            case 'item.managePlugin':
                return managePlugin !== undefined;
            case 'item.prepareEncryption':
                return prepareEncryption !== undefined;
            case 'view.select':
                return true;
        }
    }, [addIntents.length, managePlugin, mutationsBlockedReason, openItemHere, prepareEncryption]);

    const stable = stableInputRef;
    const supportsItemEdit = React.useCallback((itemId: string): boolean => {
        if (!supports('item.edit')) return false;
        const current = stable.current;
        const live = current.binding.status === 'ready' ? current.binding.snapshot : null;
        const projected = live?.itemsById.get(itemId);
        if (!projected || projected.revision === null || projected.state.kind !== 'ready') return false;
        if (!isSessionBoardItemEditableInPlace(projected.state.item)) return false;
        return projected.state.item.source.kind !== 'hostedHtml'
            || current.callerHostedHtmlAvailable === true;
    }, [supports]);
    const present = React.useCallback((outcome: SessionBoardCommandOutcome, command: SessionBoardCommand) => {
        setLastOutcome(outcome);
        const notice = outcomeNotice(outcome);
        if (!notice) return;
        publishPresentationNotice({
            key: JSON.stringify([
                'session-board',
                boardNoticeAddressKey(stable.current.serverId, stable.current.sessionId),
                command.kind,
                boardCommandNoticeTarget(command),
            ]),
            message: notice.message,
            severity: notice.severity,
        });
    }, []);

    const submit = React.useCallback(async (
        command: SessionBoardCommand,
        call: (port: SessionBoardActionsPort) => Promise<SessionBoardActionOutcome<SessionBoardMutationResult>>,
        onApplied?: () => void,
    ): Promise<SessionBoardCommandOutcome | null> => {
        const port = stable.current.actions;
        if (!port) return null;
        if (mutationInFlightRef.current
            || approvalPendingRef.current
            || retainedMutationRef.current !== null
            || stable.current.approvalPending === true) return null;
        mutationInFlightRef.current = true;
        setBusy(true);
        try {
            const baselineSnapshot = stable.current.binding.status === 'ready'
                ? stable.current.binding.snapshot
                : null;
            const submission: { current: SessionBoardMutationSubmission | null } = { current: null };
            const capturingPort: SessionBoardActionsPort = {
                upsertItem: async (actionInput) => {
                    submission.current = { actionId: 'session.board.item.upsert', input: actionInput };
                    return await port.upsertItem(actionInput);
                },
                removeItem: async (actionInput, approval) => {
                    submission.current = { actionId: 'session.board.item.remove', input: actionInput };
                    return await port.removeItem(actionInput, approval);
                },
                updateLayout: async (actionInput) => {
                    submission.current = { actionId: 'session.board.layout.update', input: actionInput };
                    return await port.updateLayout(actionInput);
                },
            };
            const rawOutcome = await call(capturingPort);
            const outcome = describeSessionBoardOutcome(rawOutcome);
            present(outcome, command);
            const retain = (kind: SessionBoardRetainedMutation['kind']) => {
                const captured = submission.current;
                if (!captured || !baselineSnapshot) return false;
                setRetainedMutation({
                    kind,
                    command,
                    submission: captured,
                    baselineSnapshot,
                    refreshObserved: false,
                    ready: false,
                    ...(onApplied ? { onApplied } : {}),
                });
                return true;
            };
            if (rawOutcome.status === 'pending_approval') {
                const captured = submission.current;
                const register = stable.current.requestApprovalContinuation;
                if (!captured || !register || !baselineSnapshot) {
                    const failed = { kind: 'failed', error: 'approval_continuation_unavailable' } as const;
                    present(failed, command);
                    return failed;
                }
                approvalPendingRef.current = true;
                retain('approvalPending');
                const callbacks: Pick<
                    SessionBoardMutationApprovalRequest,
                    'approval' | 'onSucceeded' | 'onFailed'
                > = {
                    approval: rawOutcome.approval,
                    onSucceeded: async () => {
                        approvalPendingRef.current = false;
                        setRetainedMutation(null);
                        const applied = { kind: 'applied' } as const;
                        present(applied, command);
                        stable.current.binding.refresh?.();
                        onApplied?.();
                    },
                    onFailed: (code, failure) => {
                        approvalPendingRef.current = false;
                        const approvalOutcome = describeSessionBoardApprovalFailure(code, failure);
                        present(approvalOutcome, command);
                        if (approvalOutcome.kind === 'outcomeUnknown' || approvalOutcome.kind === 'conflict') {
                            const retained = {
                                kind: approvalOutcome.kind,
                                command,
                                submission: captured,
                                baselineSnapshot,
                                refreshObserved: false,
                                ready: false,
                                ...(onApplied ? { onApplied } : {}),
                            } satisfies SessionBoardRetainedMutation;
                            setRetainedMutation(retained);
                            requestMutationRecoveryRefresh(retained);
                        } else {
                            setRetainedMutation(null);
                        }
                    },
                };
                switch (captured.actionId) {
                    case 'session.board.item.upsert':
                        register({
                            ...callbacks,
                            actionId: captured.actionId,
                            expectedInput: captured.input,
                        });
                        break;
                    case 'session.board.item.remove':
                        register({
                            ...callbacks,
                            actionId: captured.actionId,
                            expectedInput: captured.input,
                        });
                        break;
                    case 'session.board.layout.update':
                        register({
                            ...callbacks,
                            actionId: captured.actionId,
                            expectedInput: captured.input,
                        });
                        break;
                }
            } else if (outcome.kind === 'outcomeUnknown' || outcome.kind === 'conflict') {
                // Both ambiguous settlement and stale CAS reconcile through the
                // canonical SSR repository before deliberate re-entry. Never
                // resubmit here: an outcome-unknown write may already exist.
                if (retain(outcome.kind)) {
                    const next = retainedMutationRef.current;
                    if (next) requestMutationRecoveryRefresh(next);
                }
            } else if (outcome.kind === 'applied') {
                setRetainedMutation(null);
                onApplied?.();
            } else {
                setRetainedMutation(null);
            }
            return outcome;
        } finally {
            mutationInFlightRef.current = false;
            setBusy(false);
        }
    }, [present, requestMutationRecoveryRefresh, setRetainedMutation]);

    React.useEffect(() => {
        const retained = retainedMutationRef.current;
        if (!retained || retained.kind === 'approvalPending' || !snapshot) return;
        if (snapshot.loading !== 'idle' || snapshot.freshness !== 'fresh') {
            if (!retained.refreshObserved) setRetainedMutation({ ...retained, refreshObserved: true });
            return;
        }
        if (snapshot.reachability !== 'reachable' || snapshot.incomplete) return;
        // Repository projection identity is intentionally reused when a refresh
        // returns unchanged canonical records. The observed refreshing/stale leg
        // is therefore the only proof that the identical object is post-refresh.
        if (snapshot === retained.baselineSnapshot && !retained.refreshObserved) return;
        if (isRetainedSessionBoardMutationApplied(retained, snapshot)) {
            setRetainedMutation(null);
            const applied = { kind: 'applied' } as const;
            present(applied, retained.command);
            retained.onApplied?.();
            return;
        }
        if (!retained.ready) setRetainedMutation({ ...retained, ready: true, refreshObserved: true });
    }, [present, setRetainedMutation, snapshot]);

    const runInternal = React.useCallback(async (
        command: SessionBoardCommand,
        retryingRetainedMutation: boolean,
    ): Promise<void> => {
        const current = stable.current;
        const live = current.binding.status === 'ready' ? current.binding.snapshot : null;
        if (!live) return;
        if (retryingRetainedMutation) {
            if (
                !current.actions
                || !live.canEdit
                || live.reachability !== 'reachable'
                || current.approvalPending === true
                || approvalPendingRef.current
                || mutationInFlightRef.current
            ) return;
        } else if (!supports(command.kind)) return;
        const view = selectSessionBoardView(live, requestedViewId);

        switch (command.kind) {
            case 'view.select':
                reconciledFrom.current = null;
                setAnnouncement(null);
                setRequestedViewId(command.viewId);
                return;

            case 'item.openHere':
                current.onOpenItemHere?.(command.itemId);
                return;

            case 'item.managePlugin':
                current.onManagePlugin?.(command.itemId);
                return;

            case 'item.prepareEncryption':
                current.onPrepareEncryption?.();
                return;

            case 'add': {
                if (command.intent === 'walkthrough') {
                    await submit(command, (p) => p.upsertItem({
                        sessionId: current.sessionId,
                        itemId: randomUUID(),
                        expectedItemRevision: null,
                        item: {
                            v: 1,
                            title: t('walkthrough.eyebrow'),
                            frame: 'card',
                            height: { mode: 'auto', fallback: 'compact' },
                            source: { kind: 'walkthrough', comparison: 'session' },
                        },
                        placement: {
                            tabId: view.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : view.id,
                            tabTitle: viewTitle(view),
                            width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                        },
                    }));
                    return;
                }
                if (command.intent === 'askAgent') {
                    current.onAskAgent?.();
                    return;
                }
                if (command.intent === 'interactiveView') {
                    const replace = () => {
                        setNoteDraft(null);
                        setHostedHtmlDraft({
                            itemId: randomUUID(),
                            expectedItemRevision: null,
                            initialTitle: '',
                            initialHtml: '',
                            placement: {
                                tabId: view.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : view.id,
                                tabTitle: viewTitle(view),
                                width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                            },
                        });
                    };
                    if (activeDraftItemId() !== null && current.beforeReplaceNoteDraft) {
                        await current.beforeReplaceNoteDraft(replace);
                    } else {
                        replace();
                    }
                    return;
                }
                if (command.intent !== 'note') return;
                // The first note creates the real Overview row and its placement in the
                // SAME aggregate mutation; the synthetic view never reaches the wire.
                const replace = () => {
                    setHostedHtmlDraft(null);
                    setNoteDraft({
                        itemId: randomUUID(),
                        expectedItemRevision: null,
                        initialTitle: '',
                        initialBody: '',
                        placement: {
                            tabId: view.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : view.id,
                            tabTitle: viewTitle(view),
                            width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                        },
                    });
                };
                if (activeDraftItemId() !== null && current.beforeReplaceNoteDraft) {
                    await current.beforeReplaceNoteDraft(replace);
                } else {
                    replace();
                }
                return;
            }

            case 'item.addInstalled': {
                // Creation is atomic: the item record and its first placement
                // land in ONE aggregate mutation, so a Board never keeps an
                // unplaced installed widget after a partial write.
                const title = command.title.trim();
                const itemId = randomUUID();
                const target = view;
                await submit(command, (p) => p.upsertItem({
                    sessionId: current.sessionId,
                    itemId,
                    expectedItemRevision: null,
                    item: {
                        v: 1,
                        // The contribution title seeds ordinary user-owned Board
                        // metadata. It is not authority and a later plugin update
                        // must not overwrite an edited title.
                        title,
                        frame: 'card',
                        height: { mode: 'auto', fallback: 'regular' },
                        // Stable qualified identity ONLY: no version, generation,
                        // renderer, machine, Artifact or placement is persisted.
                        source: { kind: 'installedSurface', surface: command.surface },
                    },
                    placement: {
                        tabId: !target || target.synthetic ? SESSION_BOARD_OVERVIEW_VIEW_ID : target.id,
                        tabTitle: viewTitle(target),
                        width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                    },
                }));
                return;
            }

            case 'item.edit': {
                // The card, keyboard/menu activation and direct command path all
                // consume this exact source/runtime admission. A hosted document
                // must never create a hidden draft when no caller-HTML editor can
                // mount on this device.
                if (!supportsItemEdit(command.itemId)) return;
                const projected = live.itemsById.get(command.itemId);
                if (!projected || projected.revision === null || projected.state.kind !== 'ready') return;
                // Read the opened record once, here. The draft closures below run
                // after this scope narrowed `state`/`revision`, and a property
                // narrowing does not survive into a nested function.
                const opened = projected.state.item;
                const openedRevision = projected.revision;
                const source = opened.source;
                if (source.kind === 'hostedHtml' && source.source.kind === 'html') {
                    if (hostedHtmlDraftRef.current?.itemId === command.itemId) return;
                    const replace = () => {
                        setNoteDraft(null);
                        setHostedHtmlDraft({
                            itemId: command.itemId,
                            expectedItemRevision: openedRevision,
                            initialTitle: opened.title,
                            initialHtml: source.source.html,
                            baseItem: opened,
                        });
                    };
                    if (activeDraftItemId() !== null && current.beforeReplaceNoteDraft) {
                        await current.beforeReplaceNoteDraft(replace);
                    } else {
                        replace();
                    }
                    return;
                }
                // The same predicate the card's menu uses, so an offered Edit
                // always opens an editor and an unopenable document never
                // acquires one.
                if (source.kind !== 'declarative' || !isSessionBoardItemEditableInPlace(opened)) return;
                const body = readSessionSurfaceNoteTextV1(source.document) ?? '';
                // Clicking Edit again must not recreate the hook and discard its live
                // draft. Moving to another Note uses the exact same guard as Add and
                // From plugins, so every draft-replacing Board intent has one owner.
                if (noteDraftRef.current?.itemId === command.itemId) return;
                const replace = () => {
                    setHostedHtmlDraft(null);
                    setNoteDraft({
                        itemId: command.itemId,
                        expectedItemRevision: openedRevision,
                        initialTitle: opened.title,
                        initialBody: body,
                        baseItem: opened,
                    });
                };
                if (activeDraftItemId() !== null && current.beforeReplaceNoteDraft) {
                    await current.beforeReplaceNoteDraft(replace);
                } else {
                    replace();
                }
                return;
            }

            case 'item.height': {
                const projected = live.itemsById.get(command.itemId);
                if (!projected || projected.revision === null || projected.state.kind !== 'ready') return;
                const next: SessionSurfaceItemV1 = { ...projected.state.item, height: command.height };
                await submit(command, (port) => port.upsertItem({
                    sessionId: current.sessionId,
                    itemId: command.itemId,
                    expectedItemRevision: projected.revision as string,
                    item: next,
                }));
                return;
            }

            case 'item.rename': {
                const projected = live.itemsById.get(command.itemId);
                if (!projected || projected.revision === null || projected.state.kind !== 'ready') return;
                const next: SessionSurfaceItemV1 = { ...projected.state.item, title: command.title };
                await submit(command, (p) => p.upsertItem({
                    sessionId: current.sessionId,
                    itemId: command.itemId,
                    expectedItemRevision: projected.revision as string,
                    item: next,
                }));
                return;
            }

            case 'item.resize':
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: { op: 'item.resize', itemId: command.itemId, tabId: view.id, width: command.width },
                }));
                return;

            case 'item.frameStyle':
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: { op: 'item.frameStyle', itemId: command.itemId, tabId: view.id, frameStyle: command.frameStyle },
                }));
                return;

            case 'item.move': {
                const index = view.placements.findIndex((placement) => placement.itemId === command.itemId);
                const anchor = command.direction === 'before' ? view.placements[index - 1] : view.placements[index + 1];
                if (!anchor) return;
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: {
                        op: 'item.move',
                        itemId: command.itemId,
                        fromTabId: view.id,
                        toTabId: view.id,
                        anchor: { side: command.direction, itemId: anchor.itemId },
                    },
                }), () => {
                    const title = live.itemsById.get(command.itemId)?.state;
                    announceAccessibilityMessage(t(
                        command.direction === 'before'
                            ? 'sessionBoard.item.moved.before'
                            : 'sessionBoard.item.moved.after',
                        { title: title?.kind === 'ready' ? title.item.title : command.itemId },
                    ));
                });
                return;
            }

            case 'item.moveAnchored': {
                const source = live.views.find((candidate) => candidate.id === command.fromViewId);
                const destination = live.views.find((candidate) => candidate.id === command.toViewId);
                if (!source || !destination || source.synthetic || destination.synthetic) return;
                if (!source.placements.some((placement) => placement.itemId === command.itemId)) return;
                if (source.id !== destination.id
                    && destination.placements.some((placement) => placement.itemId === command.itemId)) return;
                if (command.anchor?.itemId === command.itemId
                    || (command.anchor && !destination.placements.some((placement) => placement.itemId === command.anchor?.itemId))) return;
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: {
                        op: 'item.move',
                        itemId: command.itemId,
                        fromTabId: source.id,
                        toTabId: destination.id,
                        ...(command.anchor ? { anchor: command.anchor } : {}),
                    },
                }), () => {
                    const itemState = live.itemsById.get(command.itemId)?.state;
                    const itemTitle = itemState?.kind === 'ready' ? itemState.item.title : command.itemId;
                    announceAccessibilityMessage(source.id === destination.id
                        ? t('sessionBoard.item.moved.reordered', { title: itemTitle })
                        : t('sessionBoard.item.moved.toView', {
                            title: itemTitle,
                            view: viewTitle(destination),
                        }));
                });
                return;
            }

            case 'item.moveToView': {
                const destination = live.views.find((candidate) => candidate.id === command.viewId);
                if (!destination
                    || destination.synthetic
                    || destination.id === view.id
                    // One item may intentionally appear in several views. A move
                    // must never collapse or duplicate that independent placement.
                    || destination.placements.some((placement) => placement.itemId === command.itemId)) return;
                const last = destination.placements[destination.placements.length - 1];
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: {
                        op: 'item.move',
                        itemId: command.itemId,
                        fromTabId: view.id,
                        toTabId: destination.id,
                        ...(last ? { anchor: { side: 'after' as const, itemId: last.itemId } } : {}),
                    },
                }), () => {
                    const itemState = live.itemsById.get(command.itemId)?.state;
                    const itemTitle = itemState?.kind === 'ready' ? itemState.item.title : command.itemId;
                    announceAccessibilityMessage(t('sessionBoard.item.moved.toView', {
                        title: itemTitle,
                        view: viewTitle(destination),
                    }));
                });
                return;
            }

            case 'item.pin': {
                if (!view.synthetic) {
                    await submit(command, (p) => p.updateLayout({
                        sessionId: current.sessionId,
                        expectedLayoutRevision: live.layoutRevision,
                        operation: {
                            op: 'item.place',
                            itemId: command.itemId,
                            tabId: view.id,
                            width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                        },
                    }));
                    return;
                }
                // Removing the last Board view with the unpin disposition leaves
                // a real layout with no views and every item in Recovered items.
                // `item.place` refuses a view it cannot name — it never invents
                // user-facing Board copy — so pinning onto the synthetic Overview
                // uses the same atomic item+placement contract the first Note
                // does, which creates that view from its supplied title.
                const projected = live.itemsById.get(command.itemId);
                if (!projected || projected.revision === null || projected.state.kind !== 'ready') {
                    present({ kind: 'failed', error: 'session_board_item_unreadable' }, command);
                    return;
                }
                // Captured before the request closure: the narrowing above does
                // not reach into it, and a cast there would only hide that.
                const pinnedItem = projected.state.item;
                const pinnedRevision = projected.revision;
                await submit(command, (p) => p.upsertItem({
                    sessionId: current.sessionId,
                    itemId: command.itemId,
                    expectedItemRevision: pinnedRevision,
                    // The stored content is resubmitted unchanged: a pin is a
                    // placement, never an edit of the person's item.
                    item: pinnedItem,
                    placement: {
                        tabId: SESSION_BOARD_OVERVIEW_VIEW_ID,
                        tabTitle: viewTitle(view),
                        width: SESSION_BOARD_DEFAULT_ITEM_WIDTH_V1,
                    },
                }));
                return;
            }

            case 'item.unpin':
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: { op: 'item.unpin', itemId: command.itemId, tabId: view.id },
                }));
                return;

            case 'item.remove': {
                const remove = async () => {
                    // The draft guard may await a Save before continuing. Re-read
                    // the mounted controller input afterwards instead of keeping
                    // the snapshot captured before that decision.
                    const removalInput = stable.current;
                    const removalLive = removalInput.binding.status === 'ready'
                        ? removalInput.binding.snapshot
                        : null;
                    const projected = removalLive?.itemsById.get(command.itemId);
                    if (!removalLive || removalLive.layoutRevision === null || !projected) return;
                    if (projected.revision === null) {
                        // A missing-reference card has no shared record left to delete, but the
                        // layout still carries its placements and the card publishes Remove as
                        // the recovery. Resolve it as layout-reference cleanup through the same
                        // canonical layout Action: Remove from Board means every placement,
                        // while unrelated items survive and no item revision is fabricated.
                        const hasPlacement = removalLive.views.some((candidate) => !candidate.synthetic
                            && candidate.placements.some((placement) => placement.itemId === command.itemId));
                        const cleanupLayoutRevision = removalLive.layoutRevision;
                        if (!hasPlacement) {
                            present({ kind: 'failed', error: 'session_board_item_not_found' }, command);
                            return;
                        }
                        await submit(command, (p) => p.updateLayout({
                            sessionId: removalInput.sessionId,
                            expectedLayoutRevision: cleanupLayoutRevision,
                            operation: { op: 'item.unpinAll', itemId: command.itemId },
                        }), () => retireDraftForItem(command.itemId));
                        return;
                    }
                    // Captured here because the request closure below cannot see
                    // this narrowing; the previous cast concealed that.
                    const guardedRemoval = guardedRemovalRef.current;
                    const removedRevision = guardedRemoval?.itemId === command.itemId
                        && guardedRemoval.committedItemRevision !== null
                        ? guardedRemoval.committedItemRevision
                        : projected.revision;
                    const removedLayoutRevision = removalLive.layoutRevision;
                    const confirmed = removalInput.confirmDestructive
                        ? await removalInput.confirmDestructive({
                            title: t('sessionBoard.item.remove.title'),
                            message: t('sessionBoard.item.remove.message'),
                            confirmText: t('common.remove'),
                            // The item menu may have closed before this modal mounts,
                            // and a successful removal makes that card disappear.
                            // Return to the surviving mounted Board view rather than
                            // relying on an activation-time target that may no longer
                            // exist. Re-select after the draft guard so remote layout
                            // convergence cannot leave this identity stale.
                            focusReturnViewId: selectSessionBoardView(removalLive, requestedViewId).id,
                        })
                        : true;
                    if (!confirmed) {
                        setLastOutcome({ kind: 'cancelled' });
                        return;
                    }
                    await submit(command, (p) => p.removeItem(
                        {
                            sessionId: removalInput.sessionId,
                            itemId: command.itemId,
                            expectedItemRevision: removedRevision,
                            expectedLayoutRevision: removedLayoutRevision,
                        },
                        // The provider resolved the one shared Action policy through
                        // the canonical Board modal (or its explicit UI waiver).
                        // Carry that decision to the Action seam so it cannot create
                        // a second approval artifact for the same destructive intent.
                        removalInput.confirmDestructive
                            ? { approvalDecisionApplied: true }
                            : undefined,
                    ), () => retireDraftForItem(command.itemId));
                };

                // Removing another item leaves this editor mounted. Removing the
                // item being edited — Note or interactive view alike — first uses
                // that editor's existing Save / Discard / Keep Editing decision,
                // before either destructive confirmation or the aggregate mutation
                // can run. A hosted-HTML draft used to skip this entirely, so the
                // record was deleted, its editor stayed mounted over nothing and
                // the final input was lost with no decision offered.
                if (activeDraftItemId() === command.itemId && current.beforeReplaceNoteDraft) {
                    const guardedRemoval = {
                        itemId: command.itemId,
                        committedItemRevision: null,
                    };
                    guardedRemovalRef.current = guardedRemoval;
                    try {
                        await current.beforeReplaceNoteDraft(remove);
                    } finally {
                        if (guardedRemovalRef.current === guardedRemoval) guardedRemovalRef.current = null;
                    }
                    return;
                }
                await remove();
                return;
            }

            case 'view.create': {
                const title = current.promptViewTitle
                    ? await current.promptViewTitle({ title: t('sessionBoard.views.createTitle') })
                    : null;
                const trimmed = title?.trim() ?? '';
                if (trimmed.length === 0) {
                    setLastOutcome({ kind: 'cancelled' });
                    return;
                }
                const tabId = randomUUID();
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: { op: 'tab.create', tabId, title: trimmed },
                }), () => setRequestedViewId(tabId));
                return;
            }

            case 'view.rename': {
                const target = live.views.find((candidate) => candidate.id === command.viewId);
                if (!target || target.synthetic) return;
                const trimmed = command.title.trim();
                if (trimmed.length === 0) {
                    setLastOutcome({ kind: 'cancelled' });
                    return;
                }
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: { op: 'tab.rename', tabId: command.viewId, title: trimmed },
                }));
                return;
            }

            case 'view.move': {
                const index = live.views.findIndex((candidate) => candidate.id === command.viewId);
                const anchor = command.direction === 'before' ? live.views[index - 1] : live.views[index + 1];
                if (!anchor || anchor.synthetic) return;
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: {
                        op: 'tab.move',
                        tabId: command.viewId,
                        anchor: { side: command.direction, tabId: anchor.id },
                    },
                }));
                return;
            }

            case 'view.remove': {
                const target = live.views.find((candidate) => candidate.id === command.viewId);
                if (!target || target.synthetic) return;
                const removedViewWasSelected = view.id === target.id;
                const eligibleDestinations = live.views
                    .filter((candidate) => candidate.id !== command.viewId && !candidate.synthetic)
                    .map((candidate) => ({ viewId: candidate.id, title: viewTitle(candidate) }));
                // Removing an empty view has no item disposition to decide. A
                // non-empty view fails closed until the person explicitly chooses
                // one exact destination or explicitly unpins its placements.
                const disposition: SessionBoardViewRemovalDisposition | null = target.placements.length === 0
                    ? { kind: 'unpin' }
                    : current.chooseViewRemovalDisposition
                        ? await current.chooseViewRemovalDisposition({
                            source: { viewId: target.id, title: viewTitle(target) },
                            eligibleDestinations,
                        })
                        : null;
                if (disposition === null) {
                    setLastOutcome({ kind: 'cancelled' });
                    return;
                }
                const destination = disposition.kind === 'move'
                    ? eligibleDestinations.find((candidate) => candidate.viewId === disposition.viewId)
                    : undefined;
                if (disposition.kind === 'move' && destination === undefined) {
                    setLastOutcome({ kind: 'cancelled' });
                    return;
                }
                const confirmed = current.confirmDestructive
                    ? await current.confirmDestructive({
                        title: t('sessionBoard.views.remove.title', { title: viewTitle(target) }),
                        message: destination
                            ? t('sessionBoard.views.remove.moveMessage', { title: destination.title })
                            : t('sessionBoard.views.remove.unpinMessage'),
                        confirmText: t('common.remove'),
                        focusReturnViewId: target.id,
                    })
                    : true;
                if (!confirmed) {
                    setLastOutcome({ kind: 'cancelled' });
                    return;
                }
                await submit(command, (p) => p.updateLayout({
                    sessionId: current.sessionId,
                    expectedLayoutRevision: live.layoutRevision,
                    operation: {
                        op: 'tab.remove',
                        tabId: command.viewId,
                        disposition: disposition.kind === 'move' && destination
                            ? { kind: 'move', tabId: destination.viewId }
                            : { kind: 'unpin' },
                    },
                }), removedViewWasSelected
                    ? () => setViewRemovalFocusRequest({
                        removedViewId: target.id,
                        requestId: nextViewRemovalFocusRequestId.current++,
                    })
                    : undefined);
                // The acknowledgement is not the authoritative next layout.
                // Retain the removed view identity until repository convergence
                // so the selection owner can resolve its ordered nearest survivor
                // and the mounted view strip can transfer focus to that real tab.
                return;
            }
        }
    }, [
        activeDraftItemId,
        present,
        requestedViewId,
        retireDraftForItem,
        setViewRemovalFocusRequest,
        submit,
        supports,
        supportsItemEdit,
    ]);

    const run = React.useCallback(async (command: SessionBoardCommand): Promise<void> => {
        await runInternal(command, false);
    }, [runInternal]);
    const retryLastMutation = React.useCallback(async (): Promise<void> => {
        const retained = retainedMutationRef.current;
        if (!retained || !retained.ready || retained.kind === 'approvalPending') return;
        // This is deliberate re-entry through the ordinary command path. It
        // re-reads current revisions/content and repeats destructive confirmation;
        // it never replays the frozen transport request.
        setRetainedMutation(null);
        setLastOutcome(null);
        await runInternal(retained.command, true);
    }, [runInternal, setLastOutcome, setRetainedMutation]);

    const closeNoteDraft = React.useCallback(() => {
        const draft = noteDraftRef.current;
        if (draft) continuity?.editorDrafts.clear(sessionBoardNoteDraftBufferKey(draft.itemId, draft.expectedItemRevision));
        setNoteDraft(null);
    }, [continuity, setNoteDraft]);
    const closeHostedHtmlDraft = React.useCallback(() => {
        const draft = hostedHtmlDraftRef.current;
        if (draft) continuity?.editorDrafts.clear(sessionBoardHostedHtmlDraftBufferKey(draft.itemId));
        setHostedHtmlDraft(null);
    }, [continuity, setHostedHtmlDraft]);
    const onNoteSaved = React.useCallback((
        result: SessionBoardMutationResult | null,
        committedItemRevision?: string | null,
        draftSettled = true,
    ) => {
        const itemId = result?.result.operation === 'upsert_item'
            ? result.result.itemId
            : noteDraftRef.current?.itemId;
        const committedRevision = committedItemRevision === undefined
            ? result?.result.operation === 'upsert_item' ? result.result.itemRevision : null
            : committedItemRevision;
        const guardedRemoval = guardedRemovalRef.current;
        const retainForGuardedRemoval = itemId !== undefined
            && guardedRemoval?.itemId === itemId;
        if (retainForGuardedRemoval && committedRevision !== null) {
            guardedRemoval.committedItemRevision = committedRevision;
        }
        const expectedRevision = noteDraftRef.current?.expectedItemRevision ?? null;
        // A draft that has not settled is newer text the save never carried. Retiring the
        // editor or its continuity buffer here would destroy it under a "saved" notice.
        const retainForDraft = !draftSettled;
        if (itemId && !retainForGuardedRemoval && !retainForDraft) {
            continuity?.editorDrafts.clear(sessionBoardNoteDraftBufferKey(itemId, expectedRevision));
            setHeadingFocusRequest({
                itemId,
                requestId: nextHeadingFocusRequestId.current++,
            });
        }
        if (!retainForGuardedRemoval && !retainForDraft) setNoteDraft(null);
        setLastOutcome({ kind: 'applied' });
        publishPresentationNotice({
            key: JSON.stringify([
                'session-board-note-saved',
                boardNoticeAddressKey(stable.current.serverId, stable.current.sessionId),
                itemId,
            ]),
            message: t('sessionBoard.note.saved'),
            severity: 'info',
        });
    }, [continuity, setHeadingFocusRequest, setLastOutcome, setNoteDraft]);
    const acknowledgeHeadingFocus = React.useCallback((requestId: number) => {
        setHeadingFocusRequest((current) => current?.requestId === requestId ? null : current);
    }, []);
    const acknowledgeViewRemovalFocus = React.useCallback((requestId: number) => {
        setViewRemovalFocusRequest((current) => current?.requestId === requestId ? null : current);
    }, [setViewRemovalFocusRequest]);
    const onHostedHtmlSaved = React.useCallback((
        result?: SessionBoardMutationResult | null,
        committedItemRevision?: string | null,
        draftSettled = true,
    ) => {
        const draft = hostedHtmlDraftRef.current;
        const itemId = result?.result.operation === 'upsert_item'
            ? result.result.itemId
            : draft?.itemId;
        const committedRevision = committedItemRevision === undefined
            ? result?.result.operation === 'upsert_item' ? result.result.itemRevision : null
            : committedItemRevision;
        const guardedRemoval = guardedRemovalRef.current;
        const retainForGuardedRemoval = itemId !== undefined
            && guardedRemoval?.itemId === itemId;
        if (retainForGuardedRemoval && committedRevision !== null) {
            guardedRemoval.committedItemRevision = committedRevision;
        }
        // Same settlement contract as the Note editor: newer text keeps its editor open.
        const retainForDraft = !draftSettled;
        if (draft && !retainForGuardedRemoval && !retainForDraft) {
            continuity?.editorDrafts.clear(sessionBoardHostedHtmlDraftBufferKey(draft.itemId));
        }
        if (!retainForGuardedRemoval && !retainForDraft) setHostedHtmlDraft(null);
        setLastOutcome({ kind: 'applied' });
        publishPresentationNotice({
            key: JSON.stringify([
                'session-board-html-saved',
                boardNoticeAddressKey(stable.current.serverId, stable.current.sessionId),
                itemId ?? null,
            ]),
            message: t('common.done'),
            severity: 'info',
        });
    }, [continuity, setHostedHtmlDraft, setLastOutcome]);

    const suppliedAvailability = input.resolveSourceAvailability;
    const resolveSourceAvailability = React.useMemo<SessionBoardSourceAvailabilityResolver>(
        () => suppliedAvailability ?? defaultSessionBoardSourceAvailability,
        [suppliedAvailability],
    );

    return {
        snapshot,
        activeViewId,
        activeView,
        viewRemovalFocusRequest,
        acknowledgeViewRemovalFocus,
        recoveredItemIds: snapshot?.unplacedItemIds ?? EMPTY_IDS,
        addIntents,
        mutationsBlockedReason,
        busy: busy || input.approvalPending === true || approvalPendingRef.current,
        get noteDraft() { return noteDraftRef.current; },
        closeNoteDraft,
        onNoteSaved,
        headingFocusRequest,
        acknowledgeHeadingFocus,
        // Preserve the viewer-local draft buffer if the runtime disappears, but
        // retire it from mounted consumers until that same runtime is available
        // again. This neither leaks source into an unavailable host nor strands
        // focus/guards on an editor that cannot render.
        hostedHtmlDraft: callerHostedHtmlAvailable ? hostedHtmlDraft : null,
        closeHostedHtmlDraft,
        onHostedHtmlSaved,
        get lastOutcome() { return lastOutcomeRef.current; },
        mutationRecovery: retainedMutationState && retainedMutationState.kind !== 'approvalPending'
            ? { kind: retainedMutationState.kind, ready: retainedMutationState.ready }
            : null,
        retryLastMutation,
        announcement,
        supports,
        supportsItemEdit,
        run,
        resolveSourceAvailability,
    };
}

const EMPTY_IDS: readonly string[] = Object.freeze([]);

function resolveRemovedSessionBoardViewId(
    previousViews: readonly SessionBoardViewProjection[],
    currentViews: readonly SessionBoardViewProjection[],
    removedViewId: string,
): string | null {
    const overview = currentViews.find((view) => view.id === SESSION_BOARD_OVERVIEW_VIEW_ID);
    if (overview) return overview.id;
    if (currentViews.length === 0) return null;
    const previousIndex = previousViews.findIndex((view) => view.id === removedViewId);
    if (previousIndex < 0) return currentViews[0]?.id ?? null;
    return currentViews[Math.min(previousIndex, currentViews.length - 1)]?.id ?? null;
}
