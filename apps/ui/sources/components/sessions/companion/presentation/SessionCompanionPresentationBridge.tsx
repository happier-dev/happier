import * as React from 'react';

import type {
    CurrentSessionPresentationIntentResultV1,
    CurrentSessionPresentationIntentV1,
} from '@happier-dev/protocol/sessions';

import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionBoardContinuity } from '@/components/sessions/board/SessionBoardContinuity';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { deriveSessionBoardItemState, resolveActiveSessionBoardViewId } from '@/sync/domains/session/board';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { SessionWorkPresentationContext, type SessionWorkPresentationIntent } from '@/components/sessions/work/sessionWorkPresentation';

import { useSessionCompanionController } from '../state/useSessionCompanionController';
import { canAddSessionCompanionItem } from '../sessionCompanionContentModel';
import {
    applySessionPresentationIntent,
    buildSessionPresentationNoticeKeyPrefix,
    type SessionBoardPresentationPort,
    type SessionPresentationMutationOutcome,
    type SessionCompanionMutationObserver,
} from './sessionCompanionPresentationAdapter';

export type SessionPresentationIntentApplier =
    (intent: CurrentSessionPresentationIntentV1, onCompanionMutation?: SessionCompanionMutationObserver) => CurrentSessionPresentationIntentResultV1;

/**
 * Publishes this mounted Session's local presentation port to PEP's current-UI
 * owner, which already owns binding, currentness, dedupe and acknowledgement.
 *
 * It renders nothing. Its only job is to keep the exact mounted Session's
 * Board/Companion/navigation ports reachable from the incumbent composer
 * presentation target, so an admitted Agent command and a human gesture run the
 * same controller mutations. No command bus, queue or ack store is introduced.
 *
 * Readability is answered from the canonical Board repository, not assumed: a
 * view or widget this viewer cannot currently resolve is refused with a typed
 * result and changes nothing.
 */
export const SessionCompanionPresentationBridge = React.memo(
    function SessionCompanionPresentationBridge(props: Readonly<{
        sessionId: string;
        serverId?: string | null;
        /** The ref the mounted composer presentation target reads. */
        applierRef: React.MutableRefObject<SessionPresentationIntentApplier | null>;
        /** Reveals the Board beside Chat or in focused Details, via the pane owner. */
        openBoard: SessionBoardPresentationPort['open'];
        revealBoardItem: (widgetId: string) => SessionPresentationMutationOutcome;
        returnToChat: () => SessionPresentationMutationOutcome;
        openFullSurface: () => SessionPresentationMutationOutcome;
    }>) {
        const { openBoard, revealBoardItem, returnToChat, serverId = null, sessionId } = props;
        // Only this exact Session's mounted viewer owner answers viewer intents; absent, they are
        // typed unavailable rather than claiming a rendered viewer.
        const viewer = useOptionalSessionViewerController()?.port;
        const workPresentationRef = React.useContext(SessionWorkPresentationContext);
        const controller = useSessionCompanionController({
            sessionId,
            serverId,
            openFullSurface: props.openFullSurface,
        });
        const address = React.useMemo(
            () => normalizeSessionAddress(serverId, sessionId),
            [serverId, sessionId],
        );
        const boardContinuity = useSessionBoardContinuity(address);
        const mountedBoard = useMountedSessionBoardController(address);
        const boardBinding = mountedBoard?.binding ?? null;
        // Opening the local pane creates Board content demand. A closed pane
        // has no inventory/reachability observation yet, so requiring one here
        // would prevent the very navigation that starts it. The binding owner
        // retains feature/access refusal; exact item/view reads below retain
        // target validity, independently of network readiness or freshness.
        const boardAvailable = boardBinding?.status === 'ready';
        const snapshot = boardBinding?.status === 'ready' ? boardBinding.snapshot : null;
        const resolveInlineTranscriptOccurrence = mountedBoard?.resolveInlineTranscriptOccurrence;

        const board = React.useMemo((): SessionBoardPresentationPort => {
            const readableItem: SessionBoardPresentationPort['canReadItem'] = (widgetId, viewId) => {
                // A current transcript occurrence can be ahead of the bulk
                // Board inventory that feeds `snapshot`. Its mounted demand is
                // the presentation owner's exact local readability witness.
                if (viewId === undefined && resolveInlineTranscriptOccurrence?.(widgetId)) return true;
                const state = snapshot ? snapshot.itemsById.get(widgetId)?.state
                    ?? deriveSessionBoardItemState(undefined, { complete: !snapshot.incomplete }) : null;
                if (state?.kind === 'loading') return null;
                if (state?.kind !== 'ready') return false;
                if (viewId === undefined) return true;
                if (snapshot?.layoutState.kind === 'loading') return null;
                return snapshot?.views.some((view) => (
                    view.id === viewId
                    && view.placements.some((placement) => placement.itemId === widgetId)
                )) === true;
            };
            const readableView: SessionBoardPresentationPort['canReadView'] = (viewId) => (
                snapshot?.layoutState.kind === 'loading' ? null
                    : snapshot?.views.some((view) => view.id === viewId) === true
            );
            const combineOutcomes = (
                first: SessionPresentationMutationOutcome,
                second: SessionPresentationMutationOutcome,
            ): SessionPresentationMutationOutcome => {
                if (first.status === 'unavailable' || second.status === 'unavailable') {
                    return { status: 'unavailable' };
                }
                if (first.status === 'unchanged' && second.status === 'unchanged') {
                    return { status: 'unchanged' };
                }
                const inverses = [first.undo, second.undo].filter(
                    (undo): undo is () => void => undo !== undefined,
                );
                return {
                    status: 'applied',
                    ...(inverses.length > 0
                        ? { undo: () => { for (const undo of inverses) undo(); } }
                        : {}),
                };
            };
            const requestView = (viewId: string): SessionPresentationMutationOutcome => {
                if (!address || !snapshot || !boardContinuity) return { status: 'unavailable' };
                const previousRequest = boardContinuity.viewSelection.read();
                if (resolveActiveSessionBoardViewId(snapshot, previousRequest) === viewId) {
                    return { status: 'unchanged' };
                }
                // The Board controller still reconciles this request against the
                // shared layout; this only makes the request reachable.
                boardContinuity.viewSelection.request(viewId);
                return {
                    status: 'applied',
                    undo: () => {
                        // Restore only the selection field this request applied.
                        // A newer manual selection wins and leaves this inverse inert.
                        if (boardContinuity.viewSelection.read() !== viewId) return;
                        if (previousRequest === null) boardContinuity.viewSelection.clear(viewId);
                        else boardContinuity.viewSelection.request(previousRequest);
                    },
                };
            };
            const selectView = (viewId: string): SessionPresentationMutationOutcome => {
                if (!address || readableView(viewId) !== true) return { status: 'unavailable' };
                const openOutcome = openBoard('beside_chat');
                if (openOutcome.status === 'unavailable') return openOutcome;
                return combineOutcomes(openOutcome, requestView(viewId));
            };
            return {
                availability: boardAvailable ? 'ready' : 'unavailable',
                open: (mode) => boardAvailable ? openBoard(mode) : { status: 'unavailable' },
                selectView,
                revealItem: ({ widgetId, viewId }) => {
                    const owningView = viewId
                        ?? snapshot?.views.find(
                            (view) => view.placements.some((placement) => placement.itemId === widgetId),
                        )?.id;
                    const revealOutcome = revealBoardItem(widgetId);
                    if (revealOutcome.status === 'unavailable' || !owningView) return revealOutcome;
                    return combineOutcomes(revealOutcome, requestView(owningView));
                },
                canReadView: readableView,
                canReadItem: readableItem,
            };
        }, [address, boardAvailable, boardContinuity, openBoard, resolveInlineTranscriptOccurrence, revealBoardItem, snapshot]);

        const showInlineTranscriptItem = mountedBoard?.showInlineTranscriptItem;
        const showItemInChat = React.useCallback((itemId: string, occurrenceId?: string): SessionPresentationMutationOutcome => (
            { status: showInlineTranscriptItem?.(itemId, occurrenceId) ?? 'unavailable' }
        ), [showInlineTranscriptItem]);

        const work = React.useMemo(() => ({
            apply: (intent: SessionWorkPresentationIntent): CurrentSessionPresentationIntentResultV1 => {
                const mounted = workPresentationRef?.current;
                return address && mounted?.address.serverId === address.serverId && mounted.address.sessionId === address.sessionId
                    ? mounted.apply(intent) : { status: 'unavailable' };
            },
        }), [address, workPresentationRef]);

        const applier = React.useCallback((
            intent: CurrentSessionPresentationIntentV1,
            onCompanionMutation?: SessionCompanionMutationObserver,
        ): CurrentSessionPresentationIntentResultV1 => applySessionPresentationIntent({
            companion: controller,
            board,
            viewer,
            work,
            canAddCompanionItem: (item) => canAddSessionCompanionItem(item, mountedBoard?.pluginRuntime ?? null,
                (widgetId) => board.canReadItem(widgetId) === true),
            returnToChat,
            showItemInChat,
            openFullSurface: props.openFullSurface,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix: buildSessionPresentationNoticeKeyPrefix(address, sessionId),
        }, intent, onCompanionMutation), [address, board, controller, mountedBoard?.pluginRuntime, props.openFullSurface, viewer, work, returnToChat, showItemInChat, sessionId]);

        const applierRef = props.applierRef;
        React.useEffect(() => {
            applierRef.current = applier;
            // Unmounting retires the port: a stale request then resolves to the
            // typed unavailable result rather than touching another Session.
            return () => {
                if (applierRef.current === applier) applierRef.current = null;
            };
        }, [applier, applierRef]);

        return null;
    },
);
