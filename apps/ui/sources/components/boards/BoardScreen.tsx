import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { buildWorkBoardItemKeyV1, buildWorkBoardWidgetKeyV1, type BoardItemRefV1, type WorkBoardIntentV1, type WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { normalizeWidgetSizeForSurfaceV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { HappierSurfaceStateFrame } from '@happier-dev/plugin-ui/presentation';

import { useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { createInboxItemRoute } from '@/components/inbox/inboxItemFocus';
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
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { BoardByStatus } from './byStatus/BoardByStatus';
import { BoardCanvas, type BoardCanvasWidget, type BoardCanvasWidgetRender } from './canvas/BoardCanvas';
import { BoardWidgetCard, describeBoardWidgetTitle } from './cards/BoardWidgetCard';
import { AddToBoardButton } from './header/AddToBoardPopover';
import { BoardSettingsButton } from './header/BoardSettingsPopover';
import { countBoardCardsNeedingYou, hasWorkBoardContent, type BoardCard } from './model/boardCards';
import { describeBoardSources } from './model/boardSourcePresentation';
import { resolveBoardPruneMembership } from './model/boardMembership';
import { resolveWorkBoardAdd, resolveWorkBoardEntityDrop, workBoardWidgetSurface } from './model/workBoardEntityDrop';
import { useWorkBoardEntityBinding } from './model/workBoardEntityBinding';
import { widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';
import { useBoardLiveCards } from './model/useBoardContent';
import { useBoardWidgetArrivals } from './model/useBoardWidgetArrivals';
import { resolveBoardCardOpenTarget } from './model/boardCardOpenTarget';
import { resolveBoardSaveFailure } from './model/boardSaveFailure';
import { useDispatchWorkBoardIntent, useWorkBoard, useWorkBoardReadState, useWorkBoardSaveQueue, useWorkBoardSaveState, useWorkBoardSummaries } from './model/useWorkBoards';
import { BoardReadState } from './BoardReadState';
import { BoardsInboxBoundary } from './BoardsInboxBoundary';
import { BOARDS_ROUTE } from './boardsRoutes';
import { BoardSaveFailureLine, describeBoardSaveFailure } from './BoardSaveFailureLine';

/**
 * One board (lab `boards-B1`…`B5`): the header — title, the source line, Canvas | By status, Add to
 * board and ⋯ — then the board in its layout. A phone shows By status only; Canvas positions stay saved.
 */
export const BoardScreen = React.memo(function BoardScreen(props: Readonly<{ boardId: string }>) {
    const board = useWorkBoard(props.boardId);
    const read = useWorkBoardReadState();
    if (!board && read.status !== 'ready') return <BoardReadState />;
    if (!board) return <MissingBoard boardId={props.boardId} />;
    // The Needs you section reads the Inbox's own model, mounted once for the open board.
    return <BoardsInboxBoundary boards={[board]}><BoardBody board={board} /></BoardsInboxBoundary>;
});

/**
 * A board that is not in this Home's boards: gone, or never made because its create was refused —
 * then the page says why and offers Retry, rather than "This board is gone".
 */
const MissingBoard = React.memo(function MissingBoard(props: Readonly<{ boardId: string }>) {
    const saveQueue = useWorkBoardSaveQueue();
    const failure = resolveBoardSaveFailure(useWorkBoardSaveState(), props.boardId);
    const summary = useWorkBoardSummaries().find(board => board.id === props.boardId);
    const read = useWorkBoardReadState();
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
            action={{ label: t('surfaceState.tryAgain'), onPress: read.retry }} accessibilitySemantics="alert" />;
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

function useOpenBoardCard(): (card: BoardCard) => void {
    const router = useRouter();
    const destinations = useCompactAppDestinations();
    const inboxAvailable = destinations.some((destination) => destination.id === 'inbox');
    return React.useCallback((card: BoardCard) => {
        const target = resolveBoardCardOpenTarget(card, { inboxAvailable });
        if (!target) return;
        if (target.kind === 'inbox') {
            // The Inbox owns needs-you work; the board never answers it. It opens on this card's item.
            router.push(createInboxItemRoute(target.item) as never);
            return;
        }
        const { serverId, id } = target.ref.qualifiedId;
        switch (target.ref.kind) {
            case 'session':
                router.push(buildScopedSessionRouteHref({ sessionId: id, serverId }) as never);
                return;
            case 'workflow_run':
                router.push(createWorkflowRunRoute(id) as never);
                return;
            case 'workflow':
                router.push({ pathname: '/workflows/[id]', params: { id } } as never);
                return;
            case 'machine':
                // Qualified: the machine's own Home, never the focused Home's same-id machine.
                router.push({ pathname: '/machine/[id]', params: { id, serverId } } as never);
                return;
        }
    }, [inboxAvailable, router]);
}

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
    const [addOpen, setAddOpen] = React.useState(false);
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    /** The card just added with ⌘↵ "Add and place": focused on Canvas so arrows or a drag place it. */
    const [placingKey, setPlacingKey] = React.useState<string | null>(null);
    const onOpen = useOpenBoardCard();
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
    const widgetSurface = React.useMemo(() => binding ? workBoardWidgetSurface(binding.scope, board.id) : null, [binding, board.id]);
    const widgetInstances = React.useMemo(() => widgets.map(placement => placement.instance), [widgets]);
    /** Copies this device added: their arrival is no news, and only someone else's arrival offers Undo. */
    const ownAdds = React.useRef(new Set<string>());
    const addWidgetInstance = React.useCallback(async (instance: WidgetInstanceV1, options: Readonly<{ place: boolean; size?: import('@happier-dev/protocol/widgets').WidgetSizeV1 }>) => {
        if (!widgetSurface) throw new Error('board_scope_unavailable');
        const ref = { surface: widgetSurface, instanceId: instance.id };
        ownAdds.current.add(instance.id);
        const outcome = await dispatchIntent({ kind: 'widget_add', boardId: board.id, ref, instance, ...(options.size ? { size: options.size } : {}) });
        if (outcome.status !== 'applied') throw new Error(outcome.code);
        if (options.place && mode === 'canvas') setPlacingKey(buildWorkBoardWidgetKeyV1(ref));
    }, [board.id, dispatchIntent, mode, widgetSurface]);
    const addWidgets = React.useMemo(() => ({ scope: widgetSurface, instances: widgetInstances, addInstance: addWidgetInstance }),
        [addWidgetInstance, widgetInstances, widgetSurface]);
    const pluginUi = useAppShellPluginUiProjection().pluginUiProjection;
    const installedCandidates = React.useMemo(() => widgetInstances.flatMap(instance => {
        const descriptor = readWidgetDescriptor(pluginUi, instance.definition);
        return descriptor ? [descriptor] : [];
    }), [pluginUi, widgetInstances]);
    const widgetDescriptors = useWidgetInstanceDescriptors(widgetSurface, widgetInstances, installedCandidates);
    const canvasWidgets = React.useMemo((): readonly BoardCanvasWidget[] => widgets.map((placement, index) => ({
        key: buildWorkBoardWidgetKeyV1(placement.ref),
        title: describeBoardWidgetTitle(placement, widgetDescriptors[index]),
        size: normalizeWidgetSizeForSurfaceV1('workBoard', placement.size, widgetDescriptors[index]?.sizeDeclaration),
        placement,
    })), [widgetDescriptors, widgets]);
    const arrivals = useBoardWidgetArrivals(board.id, ownAdds.current, dispatchIntent);
    const widgetRuntimeScopes = React.useMemo(() => widgets.map(placement => widgetSurface
        ? { ...placement.ref.surface, serverId: widgetSurface.serverId }
        : null), [widgets, widgetSurface]);
    const renderWidget = React.useCallback<BoardCanvasWidgetRender>((widget, state) => (
        <BoardWidgetCard
            boardId={board.id}
            placement={widget.placement}
            scope={widgetRuntimeScopes[widgets.indexOf(widget.placement)] ?? null}
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
    ), [arrivals.arrived, board.id, dispatchIntent, routeFocused, widgetDescriptors, widgetRuntimeScopes, widgets]);

    const onRemoveItem = React.useCallback((ref: BoardItemRefV1) => {
        dispatch({
            kind: 'remove_item',
            boardId: board.id,
            ref,
            membership: resolveBoardPruneMembership(board, membership, homes.isHomeMounted),
        });
    }, [board, dispatch, homes.isHomeMounted, membership]);

    const hasSource = hasWorkBoardContent(board);
    // Only this board's refused save shows here; another board's failure belongs on that board.
    const failure = resolveBoardSaveFailure(saveState, board.id);

    return (
        <View ref={rootRef} collapsable={false} testID={`board:${board.id}`} style={styles.root} onLayout={() => {
            void measureWindowBounds(toTreeDropMeasurableRef(root.current)).then(bounds => { nativeBounds.current = bounds; binding?.runtime.refresh(); });
        }}>
            <PageHeader
                testID="board-header"
                title={board.name}
                alwaysShowTitle
                columnWidth="pane"
                details={(
                    <BoardSourceLine
                        board={board}
                        itemCount={cards.length + widgets.length}
                        needYou={needYou}
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
                            board={board}
                            homes={homes}
                            onBoardKeys={onBoardKeys}
                            onAdd={onAdd}
                            widgets={addWidgets}
                            open={addOpen}
                            onOpenChange={setAddOpen}
                        />
                        <BoardSettingsButton
                            board={board}
                            homes={homes}
                            pickedCards={pickedCards}
                            canvasAvailable={!phone}
                            dispatch={dispatch}
                            onRemoveItem={onRemoveItem}
                            open={settingsOpen}
                            onOpenChange={setSettingsOpen}
                            onAddByHand={() => setAddOpen(true)}
                            onDeleted={() => router.replace(BOARDS_ROUTE as never)}
                        />
                    </View>
                )}
            />
            <BoardReadState retained />
            {failure ? (
                <View style={styles.failure}>
                    <BoardSaveFailureLine testID="board-save-failed" failure={failure} context={{ board, membership, isHomeMounted: homes.isHomeMounted }} />
                </View>
            ) : null}
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
            {!hasSource ? (
                <HappierSurfaceStateFrame size={phone ? 'phone' : 'page'}>
                    <EmptyState
                        testID="board-empty"
                        layout="centered"
                        size={phone ? 'phone' : 'page'}
                        scene="emptyBoard"
                        title={t('boards.empty.title')}
                        subtitle={t('boards.empty.body')}
                        action={<RoundButton size="normal" title={t('boards.empty.action')}
                            leading={<Icon name="plus" color={theme.colors.button.primary.tint} />}
                            onPress={() => setAddOpen(true)} />}
                    />
                </HappierSurfaceStateFrame>
            ) : <>
            {mode === 'canvas' && binding ? (
                <BoardCanvas
                    cards={cards}
                    widgets={canvasWidgets}
                    renderWidget={renderWidget}
                    order={board.itemOrder}
                    positionsByItemRef={board.positionsByItemRef}
                    snap={board.snap}
                    placingKey={placingKey}
                    onPlaced={() => setPlacingKey(null)}
                    onOpen={onOpen}
                    binding={binding}
                />
            ) : null}
                <BoardByStatus cards={cards} widgets={canvasWidgets} renderWidget={renderWidget} onOpen={onOpen} stacked={phone}
                    visible={mode === 'by_status'} active={routeFocused && mode === 'by_status'} />
            </>}
        </View>
    );
});

/** The header's one meta line: the source chip (opens Board settings), the item count, and who needs you. */
const BoardSourceLine = React.memo(function BoardSourceLine(props: Readonly<{
    board: WorkBoardV1;
    itemCount: number;
    needYou: number;
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
            <Text style={styles.meta}>· {props.itemCount === 0 ? t('boards.settings.addedByHandNone') : t('boards.meta.items', { count: props.itemCount })}</Text>
            {props.needYou > 0 ? (
                <Text testID="board-header.need-you" style={[styles.meta, workStatusWordStyle('attention')]}>
                    · {t('boards.meta.needYou', { count: props.needYou })}
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
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    failure: {
        paddingHorizontal: 24,
        paddingBottom: 8,
    },
    line: {
        paddingHorizontal: 24,
        paddingBottom: 8,
    },
    sourceLine: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 6,
    },
    sourceChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        flexShrink: 1,
    },
    meta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
}));
