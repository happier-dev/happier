import * as React from 'react';

import type {
    CurrentSessionPresentationIntentResultV1,
    CurrentSessionPresentationIntentV1,
} from '@happier-dev/protocol/sessions';

import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionBoardContinuity } from '@/components/sessions/board/SessionBoardContinuity';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveActiveSessionBoardViewId } from '@/sync/domains/session/board';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

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
        // Freshness is not authorization. An Agent's own Board write marks this
        // repository stale before it reveals what it just made, so gating
        // navigation on freshness would refuse the Board the viewer is looking
        // at. Executable currentness keeps its own separate owner
        // (`sessionBoardExecutableCurrentness`); per-target `canReadView` /
        // `canReadItem` below still supply target validity.
        const boardAvailable = boardBinding?.status === 'ready'
            && boardBinding.snapshot.reachability === 'reachable';
        const snapshot = boardAvailable ? boardBinding.snapshot : null;

        const board = React.useMemo((): SessionBoardPresentationPort => {
            const readableItem = (widgetId: string, viewId?: string) => {
                if (snapshot?.itemsById.get(widgetId)?.state.kind !== 'ready') return false;
                if (viewId === undefined) return true;
                return snapshot.views.some((view) => (
                    view.id === viewId
                    && view.placements.some((placement) => placement.itemId === widgetId)
                ));
            };
            const readableView = (viewId: string) => (
                snapshot?.views.some((view) => view.id === viewId) === true
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
                if (!address || !readableView(viewId)) return { status: 'unavailable' };
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
        }, [address, boardAvailable, boardContinuity, openBoard, revealBoardItem, snapshot]);

        const applier = React.useCallback((
            intent: CurrentSessionPresentationIntentV1,
            onCompanionMutation?: SessionCompanionMutationObserver,
        ): CurrentSessionPresentationIntentResultV1 => applySessionPresentationIntent({
            companion: controller,
            board,
            canAddCompanionItem: (item) => canAddSessionCompanionItem(item, mountedBoard?.pluginRuntime ?? null, board.canReadItem),
            returnToChat,
            openFullSurface: props.openFullSurface,
            publishNotice: publishPresentationNotice,
            noticeKeyPrefix: buildSessionPresentationNoticeKeyPrefix(address, sessionId),
        }, intent, onCompanionMutation), [address, board, controller, mountedBoard?.pluginRuntime, props.openFullSurface, returnToChat, sessionId]);

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
