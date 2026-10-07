import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { View } from 'react-native';
import {
    buildWorkBoardItemKeyV1, buildWorkBoardWidgetKeyV1, createWorkBoardV1, WorkBoardActionInputSchemasV1,
    WorkBoardsV1Schema, type BoardItemRefV1, type WorkBoardIntentV1, type WorkBoardV1, type WorkBoardWidgetPlacementV1,
} from '@happier-dev/protocol';
import { widgetCandidateDefinitionV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { buildAccountWidgetAddSections } from '@/components/widgets/add/accountWidgetAddSections';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

import { BoardByStatus } from './byStatus/BoardByStatus';
import { BoardCanvas, type BoardCanvasWidget, type BoardCanvasWidgetRender } from './canvas/BoardCanvas';
import { BoardWidgetCard } from './cards/BoardWidgetCard';
import type { BoardCard } from './model/boardCards';
import { BOARD_CANVAS_METRICS } from './model/boardCanvasGeometry';
import { projectBoardMembership } from './model/boardMembership';
import { createWorkBoardAccountStore } from './model/workBoardAccountStore';
import { createWorkBoardUiActionPort } from './model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from './model/workBoardEntityBinding';
import { useAcknowledgedBoardWidgetArrivals } from './model/useBoardWidgetArrivals';

vi.mock('react-native', async () => {
    const native = await import('@/dev/testkit/mocks/reactNative');
    // Render the platform FlatList boundary; keep the actual shared row/control logic beneath it.
    const FlatList = React.forwardRef<unknown, { data: readonly unknown[];
        renderItem: (args: { item: unknown; index: number }) => React.ReactNode;
        keyExtractor: (item: unknown, index: number) => string; children?: React.ReactNode }>((props, ref) => {
        React.useImperativeHandle(ref, () => ({ scrollToIndex() {}, scrollToOffset() {}, scrollToEnd() {}, getScrollResponder: () => ({ scrollTo() {} }) }));
        return React.createElement('FlatList', props, props.data.map((item, index) =>
            <React.Fragment key={props.keyExtractor(item, index)}>{props.renderItem({ item, index })}</React.Fragment>));
    });
    return native.createReactNativeWebMock({ FlatList, Pressable: native.createFocusablePressableMock(() => {}, () => {}) });
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Board cards must not render markdown'); },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/sync/domains/state/storage', async () => (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({}));
vi.mock('@/sync/store/hooks', async () => await import('@/sync/domains/state/storage'));
// The platform recycler is a native boundary; the Collection model and rows remain real.
vi.mock('@legendapp/list/react-native', async original => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
// The app shell's admitted plugin projection is the external daemon feed; no plugin is installed here.
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ pluginUiProjection: null }),
    useProjectedPluginLocalizedTextResolver: () => undefined,
}));

const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}

afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
});

/**
 * WorkBoard widgets (lab `dashboards` L1/L1p, G1): configured copies sit on the Board beside its work
 * cards, through the Board's one intent owner — added from the shared gallery, one or two card columns
 * wide, placed with the Canvas's keyboard controls, first in By status, and an arrival's Undo removes
 * exactly the copies that arrived.
 */
const scope = { serverId: 'home-a', accountId: 'account-a' } as const;
const surface = { ...scope, owner: { kind: 'workBoard', boardId: 'b1' } } as const;
const work: BoardItemRefV1 = { kind: 'session', qualifiedId: { serverId: 'home-a', id: 'checkout' } };
const CHECKS: WidgetCandidate = {
    sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
    surface: { pluginId: 'acme.ci', localId: 'checks' }, key: 'acme.ci/checks', title: 'Checks', pluginName: 'CI',
    sharedPluginName: false, icon: 'check-circle', homeDefault: 'available', target: 'app',
    inputs: { fields: [{ path: 'branch', title: 'Branch', widget: 'text' }] },
};
const NOTES: WidgetCandidate = {
    sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
    surface: { pluginId: 'acme.notes', localId: 'status' }, key: 'acme.notes/status', title: 'Notes', pluginName: 'Notes',
    sharedPluginName: false, icon: 'note', homeDefault: 'available', target: 'app',
};
const SUMMARY: WidgetCandidate = {
    sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
    surface: { pluginId: 'happier.sessions', localId: 'summary' }, key: 'happier.sessions/summary', title: 'Summary',
    pluginName: 'Sessions', sharedPluginName: false, icon: 'chat-circle', homeDefault: 'available', target: 'session',
    sessionInputPath: 'session', inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true }] },
};

function copy(id: string, candidate: WidgetCandidate = CHECKS, branch?: string): WidgetInstanceV1 {
    return { v: 1, id, definition: widgetCandidateDefinitionV1(candidate), bindings: branch ? { branch: { kind: 'value', value: branch } } : {} };
}
function placement(instance: WidgetInstanceV1, columns: 1 | 2 = 1): WorkBoardWidgetPlacementV1 {
    return { kind: 'widget', ref: { surface, instanceId: instance.id }, instance, size: columns === 2 ? 'full' : 'medium' };
}
const keyOf = (placed: WorkBoardWidgetPlacementV1) => buildWorkBoardWidgetKeyV1(placed.ref);

function boardWith(widgets: readonly WorkBoardWidgetPlacementV1[], positions: Record<string, { x: number; y: number }> = {}): WorkBoardV1 {
    return WorkBoardsV1Schema.parse({ v: 1, boards: [{ ...createWorkBoardV1({ id: 'b1', name: 'Launch' }),
        source: { picked: [work] }, widgets, positionsByItemRef: positions }] }).boards[0]!;
}

/** Artifact CAS is the persistence boundary; the reducer, queue, projection and replay above it are real. */
function boardStore(board: WorkBoardV1) {
    const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
    const store = createWorkBoardAccountStore(persistence.transport, () => true);
    return { persistence, store, board: () => persistence.acknowledged().boards[0]! };
}

function workCard(): BoardCard {
    return { key: buildWorkBoardItemKeyV1(work), ref: work, picked: true, availability: 'ready', title: 'checkout',
        status: { bucket: 'working', tone: 'neutral', word: 'working' }, body: { kind: 'none' } };
}

function canvasWidgets(board: WorkBoardV1): readonly BoardCanvasWidget[] {
    return (board.widgets ?? []).map(placed => ({ key: keyOf(placed), title: placed.instance.id, placement: placed }));
}

/** The Canvas host draws each widget's frame; here a stub that keeps the grip the Canvas hands it. */
const renderStub: BoardCanvasWidgetRender = (widget, state) => <View testID={`stub:${widget.placement.instance.id}`}>{state.grip}</View>;

function flatStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('WorkBoard widgets', () => {
    it('demands only nearby Canvas widget bodies and retains offscreen frames when scrolling', async () => {
        const top = placement(copy('top'));
        const bottom = placement(copy('bottom'));
        const board = boardWith([top, bottom], { [keyOf(top)]: { x: 0, y: 0 }, [keyOf(bottom)]: { x: 0, y: 4000 } });
        const b = boardStore(board);
        await b.store.refresh();
        const demanded = new Set<string>();
        function RuntimeBody({ id }: { id: string }) {
            React.useEffect(() => { demanded.add(id); return () => { demanded.delete(id); }; }, [id]);
            return <View testID={`demand:${id}`} />;
        }
        const render: BoardCanvasWidgetRender = (widget, state) => <View testID={`frame:${widget.placement.instance.id}`}>
            {state.active !== false ? <RuntimeBody id={widget.placement.instance.id} /> : null}{state.grip}
        </View>;
        const screen = await renderScreen(<BoardCanvas cards={[]} widgets={canvasWidgets(board)} renderWidget={render}
            positionsByItemRef={board.positionsByItemRef} snap binding={canvasBinding(b, [])} onOpen={() => {}} />);
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 900, height: 200 } } });
            for (const placed of [top, bottom]) {
                let node = screen.findHostByTestId(`board-canvas-widget:${keyOf(placed)}`)!;
                while (!node.props.onLayout) node = node.parent!;
                node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 100 } } });
            }
        });
        expect([...demanded]).toEqual(['top']);
        expect(screen.findHostByTestId('frame:bottom')).not.toBeNull();
        // Keyboard focus continues demanding its card, even while its frame is outside the window.
        await act(async () => { screen.findHostByTestId(`board-canvas-organize:${keyOf(bottom)}`)!.props.onFocus(); });
        expect([...demanded]).toEqual(['top', 'bottom']);
        await act(async () => { screen.findHostByTestId(`board-canvas-organize:${keyOf(bottom)}`)!.props.onBlur(); });
        expect([...demanded]).toEqual(['top']);
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 4000 } } });
        });
        expect([...demanded]).toEqual(['bottom']);
        expect(screen.findHostByTestId('frame:top')).not.toBeNull();
    });

    it('lays widgets out beside retained work cards, a two-card widget across two columns', async () => {
        const board = boardWith([placement(copy('c1')), placement(copy('c2', CHECKS, 'web'), 2)]);
        const b = boardStore(board);
        await b.store.refresh();
        const binding = canvasBinding(b, []);
        const screen = await renderScreen(<BoardCanvas cards={[workCard()]} widgets={canvasWidgets(board)} renderWidget={renderStub}
            positionsByItemRef={{}} snap binding={binding} onOpen={() => {}} />);
        const layout = (width: number) => act(async () => {
            screen.findHostByTestId('board-canvas')?.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 900 } } });
        });
        const twoCards = BOARD_CANVAS_METRICS.cardWidthPx * 2 + BOARD_CANVAS_METRICS.gapPx;
        const widthsAround = (testID: string) => {
            const host = screen.findHostByTestId(testID);
            expect(host).not.toBeNull();
            return screen.tree.findAll(node => node.findAll(child => child === host).length > 0)
                .map(node => flatStyle((node.props as { style?: unknown }).style).width).filter(width => typeof width === 'number');
        };
        await layout(1440);
        expect(screen.findHostByTestId(`board-canvas-card:${buildWorkBoardItemKeyV1(work)}`)).not.toBeNull();
        expect(screen.findHostByTestId('stub:c1')).not.toBeNull();
        expect(widthsAround(`board-canvas-widget:${keyOf(board.widgets![1]!)}`)).toContain(twoCards);
        // A one-card widget keeps the work card's column width.
        expect(widthsAround(`board-canvas-widget:${keyOf(board.widgets![0]!)}`)).not.toContain(twoCards);
        // A Canvas one column wide draws it one card wide; its saved width is untouched.
        await layout(BOARD_CANVAS_METRICS.cardWidthPx + BOARD_CANVAS_METRICS.paddingPx * 2);
        expect(widthsAround(`board-canvas-widget:${keyOf(board.widgets![1]!)}`)).not.toContain(twoCards);
        expect(b.board().widgets?.[1]?.size).toBe('full');
    });

    it('places a widget with the shared grip keyboard and accessibility controls, saving its qualified key and keeping the work card', async () => {
        const placed = placement(copy('c1'));
        const board = boardWith([placed], { [keyOf(placed)]: { x: 48, y: 24 } });
        const b = boardStore(board);
        await b.store.refresh();
        const commits: Record<string, { x: number; y: number }>[] = [];
        const screen = await renderScreen(<BoardCanvas cards={[workCard()]} widgets={canvasWidgets(board)} renderWidget={renderStub}
            positionsByItemRef={board.positionsByItemRef} snap binding={canvasBinding(b, commits)} onOpen={() => {}} />);
        const grip = screen.findHostByTestId(`board-canvas-organize:${keyOf(placed)}`);
        const press = (key: string) => act(async () => { grip?.props.onKeyDown?.({ key, preventDefault: () => {}, stopPropagation: () => {} }); });
        await press(' ');
        await press('ArrowRight');
        await press('ArrowDown');
        await press('Enter');
        const step = BOARD_CANVAS_METRICS.gridStepPx;
        expect(commits).toEqual([{ [keyOf(placed)]: { x: 48 + step, y: 24 + step } }]);
        expect(grip?.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveLeft' }), expect.objectContaining({ name: 'moveDown' }),
        ]));
        await act(async () => { grip?.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'moveLeft' } }); });
        expect(commits).toEqual([
            { [keyOf(placed)]: { x: 48 + step, y: 24 + step } },
            { [keyOf(placed)]: { x: 48, y: 24 + step } },
        ]);
        expect(b.board().source.picked).toEqual([work]);
        expect(b.board().widgets?.map(widget => widget.instance.id)).toEqual(['c1']);
    });

    it('edits one copy from its ⋯ — two cards wide, then removed — leaving its sibling and the work card', async () => {
        const first = placement(copy('c1', CHECKS, 'main'));
        const second = placement(copy('c2', CHECKS, 'web'));
        const b = boardStore(boardWith([first, second]));
        await b.store.refresh();
        const screen = await renderScreen(<>
            <BoardWidgetCard boardId="b1" placement={first} descriptor={CHECKS} size={first.size} index={0} count={2} dispatch={b.store.queue.dispatch} active={false} testID="board-widget:c1" />
            <BoardWidgetCard boardId="b1" placement={second} descriptor={CHECKS} size={second.size} index={1} count={2} dispatch={b.store.queue.dispatch} active={false} testID="board-widget:c2" />
        </>, { wrapper: Wrapper });
        const actions = (testID: string) => (screen.tree.findAll(node =>
            (node.props as { overflowTriggerTestID?: string }).overflowTriggerTestID === `${testID}.menu`
            && Array.isArray((node.props as { actions?: unknown }).actions)).at(-1)?.props as { actions: ReadonlyArray<{ id: string; selected?: boolean; disabled?: boolean; onPress: () => void }> }).actions;
        expect(actions('board-widget:c1').map(action => action.id)).toEqual(expect.arrayContaining(['rename', 'size-medium', 'size-full', 'moveDown', 'remove']));
        expect(actions('board-widget:c1').find(action => action.id === 'size-medium')?.selected).toBe(true);
        // The first card has no "earlier" entry to show disabled: a step that does nothing is absent.
        expect(actions('board-widget:c1').find(action => action.id === 'moveUp')).toBeUndefined();
        expect(actions('board-widget:c1').at(-1)?.id).toBe('remove');

        await act(async () => { actions('board-widget:c1').find(action => action.id === 'size-full')!.onPress(); });
        await vi.waitFor(() => expect(b.board().widgets?.map(widget => [widget.instance.id, widget.size])).toEqual([['c1', 'full'], ['c2', 'medium']]));

        await act(async () => { actions('board-widget:c1').find(action => action.id === 'remove')!.onPress(); });
        await vi.waitFor(() => expect(b.board().widgets?.map(widget => widget.instance.id)).toEqual(['c2']));
        expect(b.board().widgets?.[0]?.instance.bindings).toEqual(second.instance.bindings);
        expect(b.board().source.picked).toEqual([work]);
    });

    it('adds from the shared Add surface through the Board intent: another copy from its pane, a Session asked for, never borrowed', async () => {
        const b = boardStore(boardWith([placement(copy('c1', CHECKS, 'main'))]));
        await b.store.refresh();
        const added: WidgetInstanceV1[] = [];
        const sections = buildAccountWidgetAddSections({
            candidates: [CHECKS, NOTES, SUMMARY],
            instances: (b.board().widgets ?? []).map(widget => widget.instance),
            scope: surface,
            labels: { count: count => `on the board ×${count}`, submit: 'Add to board' },
            addInstance: async (instance) => {
                added.push(instance);
                const outcome = await b.store.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref: { surface, instanceId: instance.id }, instance });
                if (outcome.status !== 'applied') throw new Error(outcome.code);
            },
        });
        const entry = (key: string) => sections.flatMap(section => section.entries).find(candidate => candidate.id === `plugin-${key}`)!;
        // A copy is already here: counted, and still offered for another.
        expect(entry(CHECKS.key).count).toBe('on the board ×1');
        const checks = entry(CHECKS.key).setup!();
        await expect(checks.submit(checks.initial)).resolves.toEqual({ ok: true });
        expect(b.board().widgets?.map(widget => widget.instance.id)).toEqual(['c1', added[0]!.id]);
        expect(added[0]!.id).not.toBe('c1');
        expect(b.board().source.picked).toEqual([work]);

        // A Board has no Session of its own: Summary asks for one instead of borrowing.
        const summary = entry(SUMMARY.key).setup!();
        expect(summary.resolve(summary.initial).status).toBe('selection_required');
        // Even without inputs, useful size variants are chosen in the same pane.
        expect(entry(NOTES.key).setup!().sizeChoices?.sizes.length).toBeGreaterThan(1);
    });

    it('By status leads with the Board’s widgets, in Board order, before the work status groups', async () => {
        const board = boardWith([placement(copy('c2')), placement(copy('c1'))]);
        const screen = await renderScreen(<BoardByStatus cards={[workCard()]} widgets={canvasWidgets(board)} renderWidget={renderStub}
            onOpen={() => {}} stacked />, { wrapper: Wrapper });
        const widgets = screen.findHostByTestId('board-by-status:column:widgets');
        const working = screen.findHostByTestId('board-by-status:column:working');
        expect(widgets).not.toBeNull();
        expect(working).not.toBeNull();
        const order = screen.tree.findAll(node => typeof node.props.testID === 'string'
            && /^(board-by-status:column:|stub:)/.test(node.props.testID as string)).map(node => node.props.testID as string);
        const unique = order.filter((id, index) => order.indexOf(id) === index);
        expect(unique).toEqual(['board-by-status:column:widgets', 'stub:c2', 'stub:c1', 'board-by-status:column:working']);
    });

    it.each(['rename', 'inputs', 'size', 'frame', 'order', 'position'] as const)(
        'mounted arrival Undo preserves an acknowledged %s edit and removes the untouched arrivals', async (edit) => {
        const mine = placement(copy('mine', CHECKS, 'main'));
        const agentA = placement(copy('agent-a', CHECKS, 'main'));
        const agentB = placement(copy('agent-b', NOTES));
        const agentC = placement(copy('agent-c', NOTES));
        const old = placement(copy('old', NOTES));
        const b = boardStore(boardWith([old]));
        await b.store.refresh();
        const ownAdds = new Set(['mine']);
        const hook = await renderHook(() => {
            const acknowledged = React.useSyncExternalStore(b.store.subscribe, b.store.getBoards, b.store.getBoards);
            return useAcknowledgedBoardWidgetArrivals('b1', acknowledged.boards[0] ?? null, ownAdds, b.store.queue.dispatch);
        });
        expect(hook.getCurrent().pending).toEqual([]);
        // Another device's Artifact write becomes arrival news only once this Board acknowledges it.
        const external = createWorkBoardAccountStore(b.persistence.transport, () => true);
        await external.refresh();
        for (const placed of [mine, agentA, agentB, agentC]) {
            await external.queue.dispatch({ kind: 'widget_add', boardId: 'b1', ref: placed.ref, instance: placed.instance });
        }
        expect(hook.getCurrent().pending).toEqual([]);
        await act(async () => { await b.store.refresh(); });
        expect(hook.getCurrent().pending.map(widget => widget.instance.id)).toEqual(['agent-a', 'agent-b', 'agent-c']);
        expect([...hook.getCurrent().arrived]).toEqual(['agent-a', 'agent-b', 'agent-c']);
        const target = { boardId: 'b1', ref: agentA.ref };
        const edits: Record<typeof edit, WorkBoardIntentV1> = {
            rename: { ...target, kind: 'widget_rename', displayName: 'Mine now' },
            inputs: { ...target, kind: 'widget_inputs', bindings: { branch: { kind: 'value', value: 'changed' } } },
            size: { ...target, kind: 'widget_size', size: 'full' },
            frame: { ...target, kind: 'widget_frame', frameStyle: 'plain' },
            order: { ...target, kind: 'widget_move', nativeIndex: 0 },
            position: { kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [keyOf(agentA)]: { x: 48, y: 24 } } },
        };
        await act(async () => {
            expect((await b.store.queue.dispatch(edits[edit])).status).toBe('applied');
        });
        const edited = b.board().widgets?.find(widget => widget.instance.id === 'agent-a');
        const position = b.board().positionsByItemRef[keyOf(agentA)];
        const fresh = hook.getCurrent().arrived;
        await act(async () => { await hook.getCurrent().undo(); });
        expect(b.board().widgets?.map(widget => widget.instance.id)).toEqual(['old', 'mine', 'agent-a']);
        expect(b.board().widgets?.find(widget => widget.instance.id === 'agent-a')).toEqual(edited);
        expect(b.board().positionsByItemRef[keyOf(agentA)]).toEqual(position);
        expect(b.board().source.picked).toEqual([work]);
        expect(hook.getCurrent().pending).toEqual([]);
        expect(hook.getCurrent().arrived).toBe(fresh);
    });
});

function canvasBinding(b: ReturnType<typeof boardStore>, commits: Record<string, { x: number; y: number }>[]): WorkBoardEntityBinding {
    const getContext = () => {
        const current = b.board();
        return { scope, board: current, membership: projectBoardMembership(current, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
    };
    const port = createWorkBoardUiActionPort(getContext, b.store.queue);
    return { runtime: createEntityDragDropRuntime(), scope, isCurrent: () => true, getContext, execute: async effect => {
        const { intent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input);
        const saved = await port.apply(intent);
        commits.push({ ...saved.boards[0]!.positionsByItemRef });
        return { status: 'applied' };
    } };
}
