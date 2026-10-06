import * as React from 'react';
import { I18nManager, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';

import { SessionCompanionContent } from './SessionCompanionContent';
import {
    applySessionCompanionMutationWithNotice,
    buildSessionPresentationNoticeKeyPrefix,
} from './presentation/sessionCompanionPresentationAdapter';
import { buildSessionCompanionMenuActions } from './sessionCompanionMenu';
import { SessionCompanionAddControl } from './picker/SessionCompanionAddControl';
import { useSessionCompanionBoardAdd } from './picker/useSessionCompanionBoardAdd';
import type { SessionCompanionItemRefV1 } from './state/sessionCompanionPreference';
import { useSessionCompanionController } from './state/useSessionCompanionController';
import type { SessionSummaryDestinationHandlers } from './summary/SessionSummaryCard';

const stylesheet = StyleSheet.create(() => ({
    root: { flex: 1, minHeight: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
}));

/**
 * The host-owned full-height Companion destination in the mobile Cockpit.
 *
 * It renders the SAME Companion body the wide rail does — one content owner, one
 * widget host — inside the existing Cockpit chrome. It adds no navigator, no
 * sheet lifecycle and no mobile-only Companion implementation.
 */
type SessionCompanionScreenProps = Readonly<{
    sessionId: string;
    address: SessionAddress;
    onRevealBoardItem: (itemId: string) => void;
    onRequestClose: () => void;
    summaryDestinations?: SessionSummaryDestinationHandlers;
    resolvePrimaryHost: SessionBoardPrimaryMountResolver;
}>;

export const SessionCompanionScreen = React.memo(function SessionCompanionScreen(
    props: SessionCompanionScreenProps,
) {
    const styles = stylesheet;
    const mountedBoard = useMountedSessionBoardController(props.address);
    const session = useSessionViewShellSession(props.sessionId, props.address.serverId);
    const controller = useSessionCompanionController({
        sessionId: props.sessionId,
        serverId: props.address.serverId,
        // The full surface IS this screen; it never re-navigates to itself.
        openFullSurface: () => {},
    });
    const noticeKeyPrefix = React.useMemo(
        () => buildSessionPresentationNoticeKeyPrefix(props.address, props.sessionId),
        [props.address, props.sessionId],
    );
    const mutateCompanion = React.useCallback((input: Readonly<{
        kind: string;
        message: string;
        apply: Parameters<typeof applySessionCompanionMutationWithNotice>[0]['apply'];
    }>) => applySessionCompanionMutationWithNotice({
        companion: controller,
        publishNotice: publishPresentationNotice,
        noticeKeyPrefix,
        ...input,
    }), [controller, noticeKeyPrefix]);
    const addBoard = useSessionCompanionBoardAdd(mountedBoard);
    const addItem = React.useCallback(async (item: SessionCompanionItemRefV1) => {
        const outcome = mutateCompanion({
            kind: 'companion.item.add',
            message: t('sessionBoard.companion.notices.added'),
            apply: (companion) => companion.addItem(item),
        });
        if (!outcome) throw new Error('session_companion_write_refused');
    }, [mutateCompanion]);
    const boardSnapshot = mountedBoard?.binding.status === 'ready' ? mountedBoard.binding.snapshot : null;
    const navAddBinding = React.useMemo(() => ({
        ...addBoard,
        refs: controller.preference.items,
        snapshot: boardSnapshot,
        addItem,
    }), [addBoard, addItem, boardSnapshot, controller.preference.items]);
    const manageBoardItemPlugin = React.useCallback((itemId: string) => {
        if (!mountedBoard?.controller.supports('item.managePlugin')) return;
        void mountedBoard.controller.run({ kind: 'item.managePlugin', itemId });
    }, [mountedBoard]);
    const canManageBoardItemPlugin = mountedBoard?.controller.supports('item.managePlugin') === true;
    const menuActions = React.useMemo(
        () => buildSessionCompanionMenuActions({
            preference: controller.preference,
            layoutDirection: I18nManager.isRTL ? 'rtl' : 'ltr',
            setEdge: (edge) => { mutateCompanion({
                kind: 'companion.edge.set',
                message: t('sessionBoard.companion.notices.moved'),
                apply: (companion) => companion.setEdge(edge),
            }); },
            setDensity: (density) => { mutateCompanion({
                kind: 'companion.density.set',
                message: density === 'compact'
                    ? t('sessionBoard.companion.actions.compact')
                    : t('sessionBoard.companion.actions.comfortable'),
                apply: (companion) => companion.setDensity(density),
            }); },
            // This surface is always full height, so collapse/expand would be
            // controls with no observable effect; they are absent, not disabled.
            setCollapsed: () => {},
            hide: () => {
                mutateCompanion({
                    kind: 'companion.hide',
                    message: t('sessionBoard.companion.notices.hidden'),
                    apply: (companion) => companion.hide(),
                });
                props.onRequestClose();
            },
        }).filter((action) => action.id !== 'collapse' && action.id !== 'expand'),
        [controller.preference, mutateCompanion, props.onRequestClose],
    );

    // The cockpit's large title is the one heading (session-tabs lab Cp). The Companion tells it where
    // it lives and how much it holds, and hands it the one menu (side, size, Hide).
    const itemCount = controller.preference.items.length;
    // Phone (lab CAp): + in the navigation bar opens the same picker as the rail's
    // "Add to Companion" row, beside the one options menu.
    const headerAction = React.useMemo(() => (controller.availability === 'ready' ? (
        <View style={styles.headerActions}>
            <SessionCompanionAddControl
                binding={navAddBinding}
                variant="icon"
                testID="session-companion-screen-add"
            />
            <ItemRowActions
                title={t('sessionBoard.companion.title')}
                actions={menuActions}
                compactThreshold={Number.POSITIVE_INFINITY}
                overflowTriggerTestID="session-companion-screen-menu"
                overflowTriggerAccessibilityLabel={t('sessionBoard.companion.actions.menuA11y')}
                iconSize={18}
                gap={6}
            />
        </View>
    ) : null), [controller.availability, menuActions, navAddBinding, styles.headerActions]);
    const headerLine = React.useMemo(() => ({
        segments: itemCount > 0
            ? [t('sessionBoard.companion.pane.besideChat'), t('sessionBoard.companion.pane.itemCount', { count: itemCount })]
            : [t('sessionBoard.companion.pane.justForYou')],
    }), [itemCount]);
    usePaneHeaderSlotContent(React.useMemo(
        () => ({ line: headerLine, action: headerAction }),
        [headerAction, headerLine],
    ));

    if (!session) {
        return (
            <SurfaceStateCard
                testID="session-companion-screen-loading"
                kind="loading"
                title={t('sessionBoard.board.loading.title')}
                reason={t('sessionBoard.board.loading.reason')}
                accessibilitySemantics="status"
            />
        );
    }

    if (controller.availability !== 'ready') {
        return (
            <SurfaceStateCard
                testID="session-companion-screen-unavailable"
                kind="unavailable"
                title={t('sessionBoard.board.unavailable.title')}
                reason={t('sessionBoard.board.unavailable.reason')}
                diagnosticCode="session_companion_preference_realm_unavailable"
                accessibilitySemantics="status"
            />
        );
    }

    return (
        <View style={styles.root} testID="session-companion-screen">
            <SessionCompanionContent
                session={session}
                serverId={props.address.serverId}
                controller={controller}
                boardBinding={mountedBoard?.binding ?? null}
                resolvePrimaryHost={props.resolvePrimaryHost}
                {...(mountedBoard?.pluginRuntime ? { pluginRuntime: mountedBoard.pluginRuntime } : {})}
                {...(mountedBoard
                    ? { resolveSourceAvailability: mountedBoard.controller.resolveSourceAvailability }
                    : {})}
                {...(mountedBoard?.callerHostedHtmlRuntime
                    ? { callerHostedHtmlRuntime: mountedBoard.callerHostedHtmlRuntime }
                    : {})}
                {...(props.summaryDestinations ? { summaryDestinations: props.summaryDestinations } : {})}
                onRevealBoardItem={props.onRevealBoardItem}
                {...(canManageBoardItemPlugin ? { onManageBoardItemPlugin: manageBoardItemPlugin } : {})}
                addBinding={addBoard}
                addPlacement="external"
                revealTranscript={props.onRequestClose}
                presentation="full"
            />
        </View>
    );
});
