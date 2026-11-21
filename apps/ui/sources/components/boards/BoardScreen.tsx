import * as React from 'react';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { useIsFocused } from '@react-navigation/native';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createWorkBoardV1, buildWorkBoardItemKeyV1, buildWorkBoardWidgetKeyV1, type BoardItemRefV1, type WorkBoardIntentV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { normalizeWidgetSizeForSurfaceV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { HappierSurfaceStateFrame } from '@happier-dev/plugin-ui/presentation';

import { useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DetailsPaneHost, type DetailsPaneContent } from '@/components/appShell/panes/details/DetailsPaneHost';
import { ITEM_DETAILS_PREFERRED_WIDTH_PX } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import { InboxItemDetail } from '@/components/inbox/detail/InboxItemDetail';
import { useAppShellPluginUiProjectionModel } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readWidgetDescriptor, resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { createInboxItemRoute, type InboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { useEntityDropDomBinding, type WindowBounds } from '@/components/ui/treeDragDrop';
import { entityDragKindV1 } from '@happier-dev/protocol/plugins/ui';
import { measureWindowBounds, readWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import { Typography } from '@/constants/Typography';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { refreshWorkflowRunById } from '@/sync/engine/workflows/refreshWorkflowRun';
import { storage } from '@/sync/domains/state/storage';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { BoardByStatus } from './byStatus/BoardByStatus';
import { BoardCanvas, type BoardCanvasLayoutSnapshot, type BoardCanvasWidget, type BoardCanvasWidgetRender } from './canvas/BoardCanvas';
import { BoardWidgetCard } from './cards/BoardWidgetCard';
import { AddToBoardButton, AddToBoardPopover } from './header/AddToBoardPopover';
import { BoardSettingsButton } from './header/BoardSettingsPopover';
import { countBoardCardsNeedingYou, describeBoardItemCount, describeBoardNeedYouCount, hasWorkBoardContent, type BoardCard } from './model/boardCards';
import { describeBoardSources } from './model/boardSourcePresentation';
import { resolveBoardPruneMembership, type BoardUndeterminedMembership } from './model/boardMembership';
import { resolveWorkBoardAdd, resolveWorkBoardEntityDrop, workBoardWidgetSurface } from './model/workBoardEntityDrop';
import { useWorkBoardEntityBinding } from './model/workBoardEntityBinding';
import { widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { useBoardLiveCards } from './model/useBoardContent';
import { useBoardWidgetArrivals } from './model/useBoardWidgetArrivals';
import { readBoardCardDetailFocus, resolveBoardCardOpenTarget, type BoardCardAction } from './model/boardCardOpenTarget';
import { resolveBoardSaveFailure } from './model/boardSaveFailure';
import { useDispatchWorkBoardIntent, useWorkBoard, useWorkBoardReadState, useWorkBoardSaveQueue, useWorkBoardSaveState, useWorkBoardSummaries } from './model/useWorkBoards';
import { BoardReadState, useBoardIndexSaidByColumn, useBoardReadRetryCommand } from './BoardReadState';
import { BoardUndeterminedLine } from './BoardUndeterminedLine';
import { BoardsInboxBoundary } from './BoardsInboxBoundary';
import { BOARDS_ROUTE } from './boardsRoutes';
import { BoardSaveFailureLine, describeBoardSaveFailure } from './BoardSaveFailureLine';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { PopoverScope } from '@/components/ui/popover';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { BoardTaskRefreshContext } from './model/useBoardTaskItems';

/**
 * One board (lab `boards-B1`…`B5`): the header — title, the source line, Canvas | By status, Add to
 * board and ⋯ — then the board in its layout. A phone shows By status only; Canvas positions stay saved.
 */
export const BoardScreen = React.memo(function BoardScreen(props: Readonly<{ boardId: string }>) {
    const board = useWorkBoard(props.boardId);
    const read = useWorkBoardReadState(props.boardId);
    if (!board && read.status === 'loading') return <BoardOpening boardId={props.boardId} />;
    if (!board && read.status !== 'ready') return <BoardReadState boardId={props.boardId} />;
    if (!board) return <MissingBoard boardId={props.boardId} />;
    // The Needs you section reads the Inbox's own model, mounted once for the open board.
    return <BoardsInboxBoundary boards={[board]}><BoardBody board={board} /></BoardsInboxBoundary>;
});

/**
 * A board being read: its page already stands where it will (the header with the name the column shows, the
 * body saying quietly that it is checking what belongs there, as the read board says until its sources answer,
 * unless the column beside it is already saying the index is being read), so nothing moves when it lands.
 */
const BoardOpening = React.memo(function BoardOpening(props: Readonly<{ boardId: string }>) {
    const phone = useDeviceType() === 'phone';
    const name = useWorkBoardSummaries().find(board => board.id === props.boardId)?.name ?? t('boards.title');
    const saidByColumn = useBoardIndexSaidByColumn();
    return (
        <View style={styles.root} testID="board-opening">
            <PageHeader testID="board-header" title={name} alwaysShowTitle columnWidth="pane" />
            <View style={styles.body}>
                {saidByColumn ? null : <SurfaceStateCard testID="board-pending" size={phone ? 'phone' : 'page'} kind="loading" title={t('boards.empty.pendingTitle')} />}
            </View>
        </View>
    );
});

/** The same Board read projection over a URL filter, with no Artifact or edit binding. */
export const FilteredBoardScreen = React.memo(function FilteredBoardScreen(props: Readonly<{ filter: SessionListFilterV1 }>) {
    const routeFocused = useIsFocused();
    const phone = useDeviceType() === 'phone';
    const board = React.useMemo(() => ({ ...createWorkBoardV1({ id: 'filtered-view', name: t('boards.title') }),
        mode: 'by_status' as const, source: { picked: [], filter: props.filter } }), [props.filter]);
    const { cards, membership } = useBoardLiveCards(board, { enabled: routeFocused });
    const opener = useOpenBoardCard();
    const onOpen = opener.open;
    useLoadPickedRuns(cards);
    return <BoardCardDetailsHost opener={opener}><BoardTaskRefreshContext.Provider value={membership.refreshTaskItems}><View style={styles.root} testID="board-filter-view">
        <PageHeader title={board.name} alwaysShowTitle columnWidth="pane" />
        <BoardByStatus cards={cards} onOpen={onOpen} onAction={onOpen} stacked={phone} active={routeFocused} />
    </View></BoardTaskRefreshContext.Provider></BoardCardDetailsHost>;
});

/**
 * A board that is not in this Home's boards: gone, or never made because its create was refused —
 * then the page says why and offers Retry, rather than "This board is gone".
 */
const MissingBoard = React.memo(function MissingBoard(props: Readonly<{ boardId: string }>) {
    const saveQueue = useWorkBoardSaveQueue();
    const failure = resolveBoardSaveFailure(useWorkBoardSaveState(), props.boardId);
    const summary = useWorkBoardSummaries().find(board => board.id === props.boardId);
    const read = useWorkBoardReadState(props.boardId);
    const retryRead = useBoardReadRetryCommand(!failure && summary ? read.retry : undefined, props.boardId, summary?.name);
    if (failure) {
        return (
            <EmptyState
                testID="board-create-failed"
                layout="page"
                iconName="squares-four"
                title={t('boards.saveFailed.createTitle')}
                subtitle={describeBoardSaveFailure(failure.reason)}
                primaryAction={failure.reason === 'not_found' ? undefined : { label: t('boards.saveFailed.retry'), onPress: () => { void saveQueue.retry(); } }}
            />
        );
    }
    if (summary) {
        return <SurfaceStateCard testID="board-unreadable" kind="error"
            title={t('surfaceState.couldNotOpen', { name: summary.name })}
            action={{ label: t('surfaceState.tryAgain'), onPress: retryRead }} accessibilitySemantics="alert" />;
    }
    return (
        <EmptyState
            testID="board-not-found"
            layout="page"
            iconName="squares-four"
            title={t('boards.notFound.title')}
            subtitle={t('boards.notFound.body')}
        />
    );
});

type BoardCardOpener = Readonly<{
    open: (card: BoardCard, action?: BoardCardAction) => void;
    details: DetailsPaneContent | null;
    close: () => void;
}>;

/**
 * The one way a card opens, for every kind and the task card's Session button. Where a pane can stand
 * beside the page, a card with a detail opens over the board and the route does not change; on a phone,
 * or for a kind with no detail, it goes to the item's own page.
 */
function useOpenBoardCard(): BoardCardOpener {
    const router = useRouter();
    const destinations = useCompactAppDestinations();
    const inboxAvailable = destinations.some((destination) => destination.id === 'inbox');
    const inPlace = useDetailsPaneAvailable();
    const [opened, setOpened] = React.useState<Readonly<{ focus: InboxItemFocus; inboxWork: boolean }> | null>(null);
    const close = React.useCallback(() => setOpened(null), []);
    const open = React.useCallback((card: BoardCard, action?: BoardCardAction) => {
        const target = resolveBoardCardOpenTarget(card, { inboxAvailable, action });
        if (!target) return;
        const focus = inPlace ? readBoardCardDetailFocus(target) : null;
        if (focus) {
            setOpened({ focus, inboxWork: target.kind === 'inbox' });
            return;
        }
        setOpened(null);
        if (target.kind === 'inbox') {
            // The Inbox owns needs-you work; the board never answers it. It opens on this card's item.
            router.push(createInboxItemRoute(target.item) as never);
            return;
        }
        const { serverId, id } = target.ref.qualifiedId;
        switch (target.ref.kind) {
            case 'task': {
                if (card.body.kind !== 'task' || !card.body.item.page) return;
                const page = card.body.item.page;
                router.push(buildPluginAppPageRoutePath({ pluginId: target.ref.pluginId, localId: page.pageId,
                    ...(page.subPath === undefined ? {} : { subPath: page.subPath }) }) as never);
                return;
            }
            case 'session':
                router.push(buildScopedSessionRouteHref({ sessionId: id, serverId }) as never);
                return;
            case 'workflow_run':
                router.push(createWorkflowRunRoute(id, serverId) as never);
                return;
            case 'workflow':
                router.push({ pathname: '/workflows/[id]', params: { id, serverId, ...(target.intent ? { intent: target.intent } : {}) } } as never);
                return;
            case 'machine':
                // Qualified: the machine's own Home, never the focused Home's same-id machine. Outside
                // Settings, a machine opens through the rail door (plan machine-resources 10 MPG-2).
                router.push(machinePageHref({ door: 'rail', target: { machineId: id, serverId } }) as never);
                return;
        }
    }, [inPlace, inboxAvailable, router]);
    const details = React.useMemo<DetailsPaneContent | null>(() => opened === null ? null : {
        overPage: true,
        accessibilityLabel: t('ui.modalPane.details'),
        content: <InboxItemDetail focus={opened.focus} resolvedReceipt={opened.inboxWork} onClose={close} />,
    }, [close, opened]);
    return React.useMemo(() => ({ open, details, close }), [close, details, open]);
}

/**
 * The board and the card opened over it. Nothing dims the board: the next card is one press away and swaps
 * the detail in place. The shared overlay closes on a press on the board itself.
 */
const BoardCardDetailsHost = React.memo(function BoardCardDetailsHost(props: Readonly<{ opener: BoardCardOpener; children: React.ReactNode }>) {
    const { details, close } = props.opener;
    return <DetailsPaneHost testID="board-card-details" details={details} onCloseDetails={close}
        detailsPreferredWidthPx={ITEM_DETAILS_PREFERRED_WIDTH_PX}
        main={props.children} />;
});

/** Picked runs that no window has loaded are read once each, by the exact-run owner. */
function useLoadPickedRuns(cards: readonly BoardCard[]): void {
    const requested = React.useRef(new Set<string>());
    const missing = cards
        .filter((card) => card.ref.kind === 'workflow_run' && card.picked && card.availability === 'not_loaded')
        .map((card) => card.ref.qualifiedId.id)
        .join('\n');
    React.useEffect(() => {
        for (const runId of missing ? missing.split('\n') : []) {
            if (requested.current.has(runId)) continue;
            requested.current.add(runId);
            void refreshWorkflowRunById(runId).catch(() => {});
        }
    }, [missing]);
}


const BoardBody = React.memo(function BoardBody(props: Readonly<{ board: WorkBoardV1 }>) {
    const { board } = props;
    const router = useRouter();
    const { theme } = useUnistyles();
    const routeFocused = useIsFocused();
    const { homes, membership, cards, widgets } = useBoardLiveCards(board, { enabled: routeFocused });
    const dispatchIntent = useDispatchWorkBoardIntent({ board, membership, isHomeMounted: homes.isHomeMounted });
    const dispatch = React.useCallback((intent: WorkBoardIntentV1) => { void dispatchIntent(intent); }, [dispatchIntent]);
    const saveState = useWorkBoardSaveState();
    const phone = useDeviceType() === 'phone';
    const mode = phone ? 'by_status' : board.mode;
    const binding = useWorkBoardEntityBinding({ board, membership, isHomeMounted: homes.isHomeMounted }, routeFocused);
    const canvasLayout = React.useMemo<React.RefObject<BoardCanvasLayoutSnapshot | null>>(
        () => ({ current: null }), [board.id, binding?.scope]);
    const [addOpen, setAddOpen] = React.useState(false);
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    /** The card just added with ⌘↵ "Add and place": focused on Canvas so arrows or a drag place it. */
    const [placingKey, setPlacingKey] = React.useState<string | null>(null);
    const clearPlacing = React.useCallback(() => setPlacingKey(null), []);
    const opener = useOpenBoardCard();
    const onOpen = opener.open;
    useLoadPickedRuns(cards);

    const onBoardKeys = React.useMemo(() => new Set(membership.members.map((member) => member.key)), [membership.members]);
    const pickedCards = React.useMemo(() => cards.filter((card) => card.picked), [cards]);
    const needYou = countBoardCardsNeedingYou(cards);

    const onAdd = React.useCallback((ref: BoardItemRefV1, options: Readonly<{ place: boolean }>) => {
        if (!binding?.isCurrent()) return;
        const admission = resolveWorkBoardAdd(ref, binding.getContext());
        if (admission.status !== 'allowed') return;
        void binding.execute(admission.effect).then(outcome => {
            if (outcome.status === 'applied' && binding.isCurrent() && options.place && mode === 'canvas') setPlacingKey(buildWorkBoardItemKeyV1(ref));
        });
    }, [binding, mode]);

    const root = React.useRef<View | null>(null);
    const nativeBounds = React.useRef<WindowBounds | null>(null);
    const targetId = `work-board-add:${React.useId()}`;
    const getBounds = React.useCallback(() => readWindowBounds(toTreeDropMeasurableRef(root.current)) ?? nativeBounds.current, []);
    const dropDom = useEntityDropDomBinding(binding?.runtime);
    const rootRef = React.useCallback((node: View | null) => { root.current = node; dropDom(node); }, [dropDom]);
    React.useEffect(() => {
        if (!binding) return;
        return binding.runtime.registerTarget({ id: targetId, scope: binding.scope, isCurrent: binding.isCurrent, getBounds,
            get acceptedKinds() {
                const item = binding.runtime.getSnapshot().item;
                return item ? [entityDragKindV1(item)] : ['session', 'work-board-item'] as const;
            },
            listDestinations: item => (item.kind === 'work-board-item' || item.kind === 'work-board-widget') && item.boardId === binding.getContext().board.id ? []
                : [{ destination: { kind: 'add' }, label: binding.getContext().board.name, group: binding.getContext().board.name }],
            resolve: ({ item }) => {
                const admission = resolveWorkBoardEntityDrop({ item, context: binding.getContext(), destination: null, canvasAvailable: false });
                return admission.status === 'allowed' && admission.effect.actionId === 'widgets.item.move'
                    ? binding.admitWidgetMovement?.(admission.effect) ?? widgetMovementRefused('widget_admission_unavailable', admission.effect.preview)
                    : admission;
            },
            execute: binding.execute,
        });
    }, [binding, targetId, getBounds]);

    // ---- configured widgets (lab `dashboards` L1, G1): one writer, the Board's widget intents ----
    const boardOwnerAccountId = storage(state => state.artifacts[board.id]?.ownerAccountId);
    const admittedViewer = binding?.scope;
    const widgetSurface = React.useMemo(() => admittedViewer && boardOwnerAccountId
        ? workBoardWidgetSurface({ serverId: admittedViewer.serverId, accountId: boardOwnerAccountId }, board.id)
        : null, [admittedViewer, board.id, boardOwnerAccountId]);
    const widgetInstances = React.useMemo(() => widgets.map(placement => placement.instance), [widgets]);
    /** Copies this device added: their arrival is no news, and only someone else's arrival offers Undo. */
    const ownAdds = React.useRef(new Set<string>());
    const addWidgetInstance = React.useCallback(async (instance: WidgetInstanceV1, options: Readonly<{ place: boolean; size?: import('@happier-dev/protocol/widgets').WidgetSizeV1 }>) => {
        if (!widgetSurface) throw new Error('board_scope_unavailable');
        const ref = { surface: widgetSurface, instanceId: instance.id };
        ownAdds.current.add(instance.id);
        const outcome = await dispatchIntent({ kind: 'widget_add', boardId: board.id, ref, instance, ...(options.size ? { size: options.size } : {}) });
        if (outcome.status === 'pending') return { ok: true as const, approvalPending: true as const };
        if (outcome.status !== 'applied') throw Object.assign(new Error(outcome.code), {
            code: outcome.status === 'unknown' ? 'outcome_unknown' : outcome.code,
            ...('details' in outcome ? { details: outcome.details } : {}),
        });
        if (options.place && mode === 'canvas') setPlacingKey(buildWorkBoardWidgetKeyV1(ref));
        return { ok: true as const };
    }, [board.id, dispatchIntent, mode, widgetSurface]);
    const addWidgets = React.useMemo(() => ({ scope: widgetSurface, instances: widgetInstances, addInstance: addWidgetInstance }),
        [addWidgetInstance, widgetInstances, widgetSurface]);
    const pluginUi = useAppShellPluginUiProjectionModel();
    const localizeWidgetText = usePluginLocalizedTextResolver({ projection: pluginUi });
    const installedCandidates = React.useMemo(() => widgetInstances.flatMap(instance => {
        const descriptor = readWidgetDescriptor(pluginUi, instance.definition, instance.displayName ? undefined : localizeWidgetText);
        return descriptor ? [descriptor] : [];
    }), [pluginUi, widgetInstances, localizeWidgetText]);
    const widgetDescriptors = useWidgetInstanceDescriptors(widgetSurface, widgetInstances, installedCandidates);
    const canvasWidgets = React.useMemo((): readonly BoardCanvasWidget[] => widgets.map((placement, index) => ({
        key: buildWorkBoardWidgetKeyV1(placement.ref),
        title: resolveWidgetInstanceTitle(placement.instance, widgetDescriptors[index]),
        size: normalizeWidgetSizeForSurfaceV1('workBoard', placement.size, widgetDescriptors[index]?.sizeDeclaration),
        placement,
    })), [widgetDescriptors, widgets]);
    const arrivals = useBoardWidgetArrivals(board.id, ownAdds.current, dispatchIntent);
    const renderWidget = React.useCallback<BoardCanvasWidgetRender>((widget, state) => (
        <BoardWidgetCard
            boardId={board.id}
            placement={widget.placement}
            scope={widgetSurface}
            admittedViewer={admittedViewer}
            descriptor={widgetDescriptors[widgets.indexOf(widget.placement)] ?? null}
            size={widget.size!}
            index={widgets.indexOf(widget.placement)}
            count={widgets.length}
            dispatch={dispatchIntent}
            grip={state.grip}
            active={routeFocused && state.active}
            fresh={arrivals.arrived.has(widget.placement.instance.id)}
            testID={`board-widget:${widget.placement.instance.id}`}
        />
    ), [admittedViewer, arrivals.arrived, board.id, dispatchIntent, routeFocused, widgetDescriptors, widgetSurface, widgets]);

    const onRemoveItem = React.useCallback((ref: BoardItemRefV1) => {
        dispatch({
            kind: 'remove_item',
            boardId: board.id,
            ref,
            membership: resolveBoardPruneMembership(board, membership, homes.isHomeMounted),
        });
    }, [board, dispatch, homes.isHomeMounted, membership]);

    const hasSource = hasWorkBoardContent(board);
    // A board with nothing on it: no source at all, or a source that matches nothing (now: what arrives later replaces this).
    const empty = membership.settled && cards.length === 0 && widgets.length === 0;
    const pending = !membership.settled && cards.length === 0 && widgets.length === 0;
    // Only this board's refused save shows here; another board's failure belongs on that board.
    const failure = resolveBoardSaveFailure(saveState, board.id);

    return (
        <BoardCardDetailsHost opener={opener}>
        <BoardTaskRefreshContext.Provider value={membership.refreshTaskItems}>
        <View ref={rootRef} collapsable={false} testID={`board:${board.id}`} style={styles.root} onLayout={() => {
            void measureWindowBounds(toTreeDropMeasurableRef(root.current)).then(bounds => { nativeBounds.current = bounds; binding?.runtime.refresh(); });
        }}>
            {/* The Board's menus and its Add surface float inside this page column, never over the sidebar. */}
            <PopoverScope boundaryRef={root}>
            <PageHeader
                testID="board-header"
                title={board.name}
                alwaysShowTitle
                columnWidth="pane"
                details={(
                    <BoardSourceLine
                        board={board}
                        itemCount={membership.settled ? cards.length + widgets.length : null}
                        needYou={membership.settled ? needYou : null}
                        undetermined={membership.settled ? membership.undetermined : undefined}
                        onPress={() => setSettingsOpen(true)}
                    />
                )}
                actions={(
                    <View style={styles.actions}>
                        {phone ? null : (
                            <SegmentedTabBar
                                testIDPrefix="board-header.layout"
                                accessibilityLabel={t('boards.header.layoutA11y')}
                                segmentSizing="content"
                                tabs={[
                                    { id: 'canvas' as const, label: t('boards.header.canvas') },
                                    { id: 'by_status' as const, label: t('boards.header.byStatus') },
                                ]}
                                activeTabId={board.mode}
                                onSelectTab={(next) => dispatch({ kind: 'update', boardId: board.id, patch: { mode: next } })}
                            />
                        )}
                        <AddToBoardButton
                            anchorRef={addAnchorRef}
                            open={addOpen}
                            onOpenChange={setAddOpen}
                        />
                        <BoardSettingsButton
                            board={board}
                            homes={homes}
                            pickedCards={pickedCards}
                            canvasAvailable={!phone}
                            dispatch={dispatchIntent}
                            onRemoveItem={onRemoveItem}
                            open={settingsOpen}
                            onOpenChange={setSettingsOpen}
                            onAddByHand={() => setAddOpen(true)}
                            onDeleted={() => router.replace(BOARDS_ROUTE as never)}
                        />
                    </View>
                )}
            />
            <AddToBoardPopover
                anchorRef={addAnchorRef}
                homes={homes}
                onBoardKeys={onBoardKeys}
                onAdd={onAdd}
                widgets={addWidgets}
                open={addOpen}
                onOpenChange={setAddOpen}
            />
            {/* The Board's state lines stand on the cards' edge, one inset for all of them (F9). */}
            <View style={styles.lines}>
                <BoardReadState boardId={board.id} retained />
                {membership.settled ? <BoardUndeterminedLine undetermined={membership.undetermined}
                    taskItemsComplete={membership.taskItemsComplete} onRetryTasks={membership.refreshTaskItems} /> : null}
                {failure ? (
                    <View style={styles.failure}>
                        <BoardSaveFailureLine testID="board-save-failed" failure={failure} context={{ board, membership, isHomeMounted: homes.isHomeMounted }} />
                    </View>
                ) : null}
            </View>
            {arrivals.pending.length > 0 ? (
                <View style={styles.line}>
                    <SurfaceStateCard
                        testID="board-widgets-arrived"
                        kind="success"
                        size="line"
                        title={t('boards.widgets.arrived', { count: arrivals.pending.length })}
                        action={{ label: t('boards.widgets.undo'), testID: 'board-widgets-arrived.undo', onPress: arrivals.undo }}
                        secondaryAction={{ label: t('boards.widgets.dismiss'), onPress: arrivals.dismiss }}
                    />
                </View>
            ) : null}
            {empty ? (
                <HappierSurfaceStateFrame size={phone ? 'phone' : 'page'}>
                    <EmptyState
                        testID="board-empty"
                        layout="centered"
                        size={phone ? 'phone' : 'page'}
                        scene="emptyBoard"
                        title={t(!hasSource ? 'boards.empty.title' : membership.undetermined.count > 0 || membership.taskItemsComplete === false ? 'boards.empty.uncheckedTitle' : 'boards.empty.sourcedTitle')}
                        subtitle={t(hasSource ? 'boards.empty.sourcedBody' : 'boards.empty.body')}
                        action={<RoundButton testID="board-empty.add" size="normal" title={t('boards.empty.action')}
                            leading={<Icon name="plus" color={theme.colors.button.primary.tint} />}
                            onPress={() => setAddOpen(true)} />}
                    />
                </HappierSurfaceStateFrame>
            ) : <View style={styles.body}>
            {mode === 'canvas' && binding ? (
                <BoardCanvas
                    retainedLayout={canvasLayout}
                    cards={cards}
                    widgets={canvasWidgets}
                    renderWidget={renderWidget}
                    order={board.itemOrder}
                    positionsByItemRef={board.positionsByItemRef}
                    snap={board.snap}
                    placingKey={placingKey}
                    onPlaced={clearPlacing}
                    onOpen={onOpen}
                    onAction={onOpen}
                    binding={binding}
                />
            ) : null}
                <BoardByStatus cards={cards} widgets={canvasWidgets} renderWidget={renderWidget} onOpen={onOpen} onAction={onOpen} stacked={phone}
                    visible={mode === 'by_status'} active={routeFocused && mode === 'by_status'} />
            {pending ? (
                // A source that has not answered yet: the reserved canvas stays and says so quietly; it is
                // never an empty board, and it leaves once the first card (or the settled answer) arrives.
                <View style={styles.pending} pointerEvents="none">
                    <SurfaceStateCard testID="board-pending" size={phone ? 'phone' : 'page'} kind="loading" title={t('boards.empty.pendingTitle')} />
                </View>
            ) : null}
            </View>}
            </PopoverScope>
        </View>
        </BoardTaskRefreshContext.Provider>
        </BoardCardDetailsHost>
    );
});

/** The header's one meta line: the source chip (opens Board settings), the item count when there is one, and who needs you. */
const BoardSourceLine = React.memo(function BoardSourceLine(props: Readonly<{
    board: WorkBoardV1;
    itemCount: number | null;
    needYou: number | null;
    /** Unresolved candidates make the counts floors. */
    undetermined?: BoardUndeterminedMembership;
    onPress: () => void;
}>) {
    const { theme } = useUnistyles();
    const { board } = props;
    const source = describeBoardSources({ sections: [...board.source.sections ?? []], hasFilter: board.source.filter !== undefined, pickedCount: board.source.picked.length });
    return (
        <View style={styles.sourceLine}>
            <Pressable
                testID="board-header.source"
                accessibilityRole="button"
                accessibilityLabel={`${source}, ${t('boards.header.settings')}`}
                onPress={props.onPress}
                style={styles.sourceChip}
            >
                <Icon name="funnel-simple" size={14} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.meta}>{source}</Text>
                <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
            </Pressable>
            {/* An empty board's empty state already says so; the meta line only counts what is there. */}
            {/* The chip's own gap parts it from the count; "·" only joins the facts after it (F9). */}
            {props.itemCount === null || props.itemCount === 0 ? null : <Text style={styles.meta}>{describeBoardItemCount(props.itemCount, props.undetermined)}</Text>}
            {props.needYou !== null && props.needYou > 0 ? (
                <Text testID="board-header.need-you" style={[styles.meta, workStatusWordStyle('attention')]}>
                    {props.itemCount === null || props.itemCount === 0 ? '' : '· '}{describeBoardNeedYouCount(props.needYou, props.undetermined)}
                </Text>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
    body: {
        flex: 1,
        minHeight: 0,
    },
    pending: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    lines: {
        paddingHorizontal: theme.space.s24,
    },
    failure: {
        paddingBottom: theme.space.s8,
    },
    line: {
        paddingHorizontal: theme.space.s24,
        paddingBottom: theme.space.s8,
    },
    sourceLine: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s6,
    },
    sourceChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        minWidth: 0,
        flexShrink: 1,
    },
    meta: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
