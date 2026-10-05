import type {
    CurrentSessionPresentationIntentResultV1,
    CurrentSessionPresentationIntentV1,
} from '@happier-dev/protocol/sessions';

import type { PresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

import type { SessionCompanionItemRefV1 } from '../state/sessionCompanionPreference';
import type {
    SessionCompanionController,
    SessionCompanionMutationOutcome,
} from '../state/useSessionCompanionController';

/**
 * Lane 08's local presentation semantics over PEP's current-UI command owner.
 *
 * PEP owns the command union, projection, transport, bind/nonce/client checks,
 * dedupe and acknowledgement. This module owns only what a Board/Companion intent
 * MEANS for this viewer: which incumbent controller operation it maps to, whether
 * the exact target is currently readable, and what typed result the wire gets.
 * There is no command bus, queue, ack store or Lane 08 transport here — a human
 * gesture and an admitted command call exactly the same ports.
 */

export type SessionPresentationMutationOutcome = Readonly<{
    status: 'applied' | 'unchanged' | 'unavailable';
    /** Caller-bound local inverse; the pane owner re-checks its live fields. */
    undo?: () => void;
}>;

export type SessionBoardPresentationMutationOutcome = SessionPresentationMutationOutcome;
export type SessionCompanionMutationObserver = (outcome: SessionCompanionMutationOutcome) => void;

export type SessionBoardPresentationPort = Readonly<{
    /** Exact mounted Board binding is current and reachable for presentation. */
    availability: 'ready' | 'unavailable';
    /** Reveals the Board beside Chat or in focused Details. */
    open: (mode: 'beside_chat' | 'focus') => SessionBoardPresentationMutationOutcome;
    selectView: (viewId: string) => SessionBoardPresentationMutationOutcome;
    revealItem: (input: Readonly<{ widgetId: string; viewId?: string }>) => SessionBoardPresentationMutationOutcome;
    /** The current Board repository resolves this view and the viewer may read it. */
    canReadView: (viewId: string) => boolean;
    /** Exact current item, optionally constrained to the requested current view. */
    canReadItem: (widgetId: string, viewId?: string) => boolean;
}>;

export type SessionPresentationPorts = Readonly<{
    companion: SessionCompanionController;
    board: SessionBoardPresentationPort;
    /** Exact mounted Session catalogs admit new personal references; existing refs remain editable when unavailable. */
    canAddCompanionItem: (item: SessionCompanionItemRefV1) => boolean;
    /** Returns to Chat preserving draft, selection, anchor and keyboard focus. */
    returnToChat: () => SessionPresentationMutationOutcome;
    /** Opens the incumbent full Companion destination; it owns route currentness. */
    openFullSurface: () => SessionPresentationMutationOutcome;
    publishNotice: (notice: PresentationNotice) => void;
    /** Opaque qualified Session key, so one notice cannot retire another realm's. */
    noticeKeyPrefix: string | null;
}>;

const APPLIED: CurrentSessionPresentationIntentResultV1 = Object.freeze({ status: 'applied' });
const UNCHANGED: CurrentSessionPresentationIntentResultV1 = Object.freeze({ status: 'unchanged' });
const UNAVAILABLE: CurrentSessionPresentationIntentResultV1 = Object.freeze({ status: 'unavailable' });
const INVALID_TARGET: CurrentSessionPresentationIntentResultV1 = Object.freeze({ status: 'invalidTarget' });

export function buildSessionPresentationNoticeKeyPrefix(
    address: SessionAddress | null,
    _sessionId: string,
): string | null {
    return address ? sessionAddressKey(address) : null;
}

function noticeKey(ports: SessionPresentationPorts, kind: string): string {
    return `session-presentation:${ports.noticeKeyPrefix}:${kind}`;
}

/**
 * Publishes through the app's ONE existing notice owner. A Companion change
 * carries a safe local inverse; navigation does not, because the inverse of
 * "opened the Board" is an ordinary manual navigation the person can already do
 * and reversing it could fight a newer deliberate move.
 */
export function publishSessionCompanionMutationNotice(input: Readonly<{
    companion: SessionCompanionController;
    publishNotice: (notice: PresentationNotice) => void;
    noticeKeyPrefix: string | null;
    kind: string;
    message: string;
    outcome: SessionCompanionMutationOutcome | null;
}>): void {
    if (!input.noticeKeyPrefix || !input.outcome) return;
    const outcome = input.outcome;
    // The notice outlives this render and is app-global, so the realm that authored the
    // mutation travels with it. The controller refuses the inverse when the live realm or
    // its own mounted lifetime no longer matches.
    const realmKey = input.companion.realmKey;
    input.publishNotice({
        key: `session-presentation:${input.noticeKeyPrefix}:${input.kind}`,
        message: input.message,
        severity: 'info',
        undo: {
            label: t('sessionBoard.companion.actions.undo'),
            run: () => { input.companion.applyLocalInverse(outcome, realmKey); },
        },
    });
}

/**
 * The single mounted-human/command seam for a viewer-local Companion mutation.
 * It refuses an unqualified realm, publishes exactly once after a real change,
 * and binds Undo to the same exact controller that applied the mutation.
 */
export function applySessionCompanionMutationWithNotice(input: Readonly<{
    companion: SessionCompanionController;
    publishNotice: (notice: PresentationNotice) => void;
    noticeKeyPrefix: string | null;
    kind: string;
    message: string;
    apply: (companion: SessionCompanionController) => SessionCompanionMutationOutcome | null;
}>): SessionCompanionMutationOutcome | null {
    if (input.companion.availability !== 'ready' || !input.noticeKeyPrefix) return null;
    const outcome = input.apply(input.companion);
    if (!outcome) return null;
    publishSessionCompanionMutationNotice({
        companion: input.companion,
        publishNotice: input.publishNotice,
        noticeKeyPrefix: input.noticeKeyPrefix,
        kind: input.kind,
        message: input.message,
        outcome,
    });
    return outcome;
}

/**
 * The one human/inline entry point for placing a readable Board item in this
 * viewer's exact-Session Companion. The controller owns preference mutation and
 * `presentationNotices` owns the single safe local inverse; callers only decide
 * whether their current Board item is readable and whether another placement
 * needs an additional navigation gesture after the preference becomes visible.
 */
export function showSessionBoardItemInCompanion(input: Readonly<{
    companion: SessionCompanionController;
    publishNotice: (notice: PresentationNotice) => void;
    noticeKeyPrefix: string | null;
    itemId: string;
    /** Exact mounted Session-shell destination; invoked only after a real write. */
    revealAfterMutation: (outcome: SessionCompanionMutationOutcome) => void;
}>): SessionCompanionMutationOutcome | null {
    const outcome = applySessionCompanionMutationWithNotice({
        companion: input.companion,
        publishNotice: input.publishNotice,
        noticeKeyPrefix: input.noticeKeyPrefix,
        kind: 'companion.item.add',
        message: t('sessionBoard.companion.notices.added'),
        apply: (companion) => companion.show({ kind: 'widget', widgetId: input.itemId }),
    });
    if (outcome) input.revealAfterMutation(outcome);
    return outcome;
}

function announce(
    ports: SessionPresentationPorts,
    kind: string,
    message: string,
    outcome?: SessionCompanionMutationOutcome | null,
    localUndo?: (() => void) | null,
): void {
    if (outcome) {
        publishSessionCompanionMutationNotice({
            companion: ports.companion,
            publishNotice: ports.publishNotice,
            noticeKeyPrefix: ports.noticeKeyPrefix,
            kind,
            message,
            outcome,
        });
        return;
    }
    ports.publishNotice({
        key: noticeKey(ports, kind),
        message,
        severity: 'info',
        ...(localUndo
            ? { undo: { label: t('sessionBoard.companion.actions.undo'), run: localUndo } }
            : {}),
    });
}

function fromCompanionOutcome(
    ports: Pick<SessionPresentationPorts, 'companion' | 'publishNotice' | 'noticeKeyPrefix'>,
    kind: string,
    message: string,
    apply: () => SessionCompanionMutationOutcome | null,
    onCompanionMutation?: SessionCompanionMutationObserver,
    unchangedResult: CurrentSessionPresentationIntentResultV1 = UNCHANGED,
): CurrentSessionPresentationIntentResultV1 {
    if (ports.companion.availability !== 'ready') return UNAVAILABLE;
    const outcome = applySessionCompanionMutationWithNotice({
        companion: ports.companion,
        publishNotice: ports.publishNotice,
        noticeKeyPrefix: ports.noticeKeyPrefix,
        kind,
        message,
        apply: () => apply(),
    });
    if (!outcome) return unchangedResult;
    onCompanionMutation?.(outcome);
    return APPLIED;
}

function fromPresentationOutcome(
    ports: SessionPresentationPorts,
    kind: string,
    message: string,
    outcome: SessionPresentationMutationOutcome,
): CurrentSessionPresentationIntentResultV1 {
    if (outcome.status === 'unavailable') return UNAVAILABLE;
    if (outcome.status === 'unchanged') return UNCHANGED;
    announce(ports, kind, message, null, outcome.undo);
    return APPLIED;
}

/** The mounted human and bound agent share the same reference placement owner. */
export function applySessionCompanionItemPresentationIntent(
    ports: Pick<SessionPresentationPorts, 'companion' | 'publishNotice' | 'noticeKeyPrefix' | 'canAddCompanionItem'>,
    intent: Extract<CurrentSessionPresentationIntentV1, { kind: 'companion.item.add' | 'companion.item.move' }>,
    onCompanionMutation?: SessionCompanionMutationObserver,
): CurrentSessionPresentationIntentResultV1 {
    if (!ports.noticeKeyPrefix || ports.companion.availability !== 'ready') return UNAVAILABLE;
    if (intent.kind === 'companion.item.add') {
        if (!ports.canAddCompanionItem(intent.item)) return INVALID_TARGET;
        return fromCompanionOutcome(ports, intent.kind, t('sessionBoard.companion.notices.added'),
            () => intent.index === undefined ? ports.companion.addItem(intent.item) : ports.companion.addItem(intent.item, intent.index), onCompanionMutation);
    }
    return fromCompanionOutcome(ports, intent.kind, t('sessionBoard.companion.notices.reordered'),
        () => ports.companion.moveItem(intent.item, intent.toIndex), onCompanionMutation);
}

export function applySessionPresentationIntent(
    ports: SessionPresentationPorts,
    intent: CurrentSessionPresentationIntentV1,
    onCompanionMutation?: SessionCompanionMutationObserver,
): CurrentSessionPresentationIntentResultV1 {
    if (!ports.noticeKeyPrefix) return UNAVAILABLE;
    const exactPorts = { ...ports, noticeKeyPrefix: ports.noticeKeyPrefix };
    if (
        intent.kind.startsWith('companion.')
        && exactPorts.companion.availability !== 'ready'
    ) {
        return UNAVAILABLE;
    }
    if (
        intent.kind.startsWith('board.')
        && exactPorts.board.availability !== 'ready'
    ) {
        return UNAVAILABLE;
    }
    switch (intent.kind) {
        case 'chat.return':
            return fromPresentationOutcome(
                exactPorts,
                'chat.return',
                t('sessionBoard.companion.notices.returnedToChat'),
                exactPorts.returnToChat(),
            );

        case 'board.open':
            return fromPresentationOutcome(
                exactPorts,
                'board.open',
                t('sessionBoard.companion.notices.boardOpened'),
                exactPorts.board.open(intent.mode),
            );

        case 'board.view.select': {
            if (!exactPorts.board.canReadView(intent.viewId)) return INVALID_TARGET;
            return fromPresentationOutcome(
                exactPorts,
                'board.view.select',
                t('sessionBoard.companion.notices.boardViewSelected'),
                exactPorts.board.selectView(intent.viewId),
            );
        }

        case 'board.item.reveal': {
            if (!exactPorts.board.canReadItem(intent.widgetId, intent.viewId)) return INVALID_TARGET;
            if (intent.viewId !== undefined && !exactPorts.board.canReadView(intent.viewId)) return INVALID_TARGET;
            return fromPresentationOutcome(
                exactPorts,
                'board.item.reveal',
                t('sessionBoard.companion.notices.boardItemRevealed'),
                exactPorts.board.revealItem({
                    widgetId: intent.widgetId,
                    ...(intent.viewId === undefined ? {} : { viewId: intent.viewId }),
                }),
            );
        }

        case 'companion.show':
            return fromCompanionOutcome(
                exactPorts,
                'companion.show',
                t('sessionBoard.companion.notices.shown'),
                () => exactPorts.companion.show(),
            );

        case 'companion.hide':
            return fromCompanionOutcome(
                exactPorts,
                'companion.hide',
                t('sessionBoard.companion.notices.hidden'),
                () => exactPorts.companion.hide(),
            );

        case 'companion.item.add':
        case 'companion.item.move':
            return applySessionCompanionItemPresentationIntent(exactPorts, intent, onCompanionMutation);

        case 'companion.item.remove':
            if (intent.expectedPresentation && !intent.expectedInstance) return INVALID_TARGET;
            return fromCompanionOutcome(
                exactPorts,
                'companion.item.remove',
                t('sessionBoard.companion.notices.removed'),
                () => intent.expectedInstance ? exactPorts.companion.removeItem(intent.item, {
                    expectedInstance: intent.expectedInstance,
                    ...(intent.expectedPresentation ? { expectedPresentation: intent.expectedPresentation } : {}),
                }) : exactPorts.companion.removeItem(intent.item),
                onCompanionMutation,
                intent.expectedInstance ? INVALID_TARGET : UNCHANGED,
            );


        case 'companion.item.frameStyle.set':
            return fromCompanionOutcome(
                exactPorts,
                'companion.item.frameStyle.set',
                t('common.done'),
                () => exactPorts.companion.setItemFrameStyle(intent.item, intent.frameStyle),
            );

        case 'companion.instance.inputs.set':
        case 'companion.instance.inputs.reset':
        case 'companion.instance.rename': {
            if (!exactPorts.companion.preference.items.some((item) => item.kind === 'instance' && item.instance.id === intent.instanceId)) return INVALID_TARGET;
            return fromCompanionOutcome(exactPorts, intent.kind, t('common.done'), () => intent.kind === 'companion.instance.rename'
                ? exactPorts.companion.renameInstance(intent.instanceId, intent.displayName)
                : exactPorts.companion.setInstanceInputs(intent.instanceId, intent.kind === 'companion.instance.inputs.set' ? intent.bindings : {}));
        }

        case 'companion.edge.set':
            return fromCompanionOutcome(
                exactPorts,
                'companion.edge.set',
                t('sessionBoard.companion.notices.moved'),
                () => exactPorts.companion.setEdge(intent.edge),
            );

        case 'companion.collapse.set':
            return fromCompanionOutcome(
                exactPorts,
                'companion.collapse.set',
                intent.collapsed
                    ? t('sessionBoard.companion.actions.collapse')
                    : t('sessionBoard.companion.actions.expand'),
                () => exactPorts.companion.setCollapsed(intent.collapsed),
            );

        case 'companion.density.set':
            return fromCompanionOutcome(
                exactPorts,
                'companion.density.set',
                intent.density === 'compact'
                    ? t('sessionBoard.companion.actions.compact')
                    : t('sessionBoard.companion.actions.comfortable'),
                () => exactPorts.companion.setDensity(intent.density),
            );

        case 'companion.open_full':
            return fromPresentationOutcome(
                exactPorts,
                'companion.open_full',
                t('sessionBoard.companion.notices.fullOpened'),
                exactPorts.openFullSurface(),
            );
    }
}
