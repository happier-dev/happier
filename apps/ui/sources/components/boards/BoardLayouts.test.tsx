import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1, WorkBoardActionInputSchemasV1, type BoardItemRefV1 } from '@happier-dev/protocol';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { BoardByStatus } from './byStatus/BoardByStatus';
import { BoardCanvas } from './canvas/BoardCanvas';
import type { BoardCard } from './model/boardCards';
import { BOARD_CANVAS_METRICS } from './model/boardCanvasGeometry';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from './model/workBoardAccountStore';
import { projectBoardMembership } from './model/boardMembership';
import { createWorkBoardUiActionPort } from './model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from './model/workBoardEntityBinding';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

const physicalFocus = vi.hoisted(() => ({ keys: [] as string[] }));
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
    return native.createReactNativeWebMock({ FlatList, Pressable: native.createFocusablePressableMock(() => {},
        props => { if (typeof props.testID === 'string') physicalFocus.keys.push(props.testID); }) });
});
// Unused third-party markdown import below the real presentation host; this checkout lacks its web artifact.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Board cards must not render markdown'); },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The platform recycler is a native boundary; the Collection model and rows remain real.
vi.mock('@legendapp/list/react-native', async original => (await import('@/dev/testkit/mocks/legendList'))
    .createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}

afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
    physicalFocus.keys.length = 0;
});

function card(kind: BoardItemRefV1['kind'], id: string, bucket: BoardCard['status']['bucket']): BoardCard {
    const ref: BoardItemRefV1 = { kind, qualifiedId: { serverId: 'home-a', id } };
    return {
        key: JSON.stringify([kind, 'home-a', id]),
        ref,
        picked: true,
        availability: 'ready',
        title: id,
        status: { bucket, tone: bucket === 'needs_you' ? 'attention' : 'neutral', word: bucket },
        body: { kind: 'none' },
    };
}

const MIXED = [
    card('session', 'checkout', 'needs_you'),
    card('workflow_run', 'release', 'needs_you'),
    card('machine', 'macbook', 'working'),
    card('session', 'runbook', 'finished'),
    card('workflow', 'nightly', 'idle'),
    card('machine', 'build-vps', 'offline'),
];

function canvasBinding(placed: BoardCard, commits: Record<string, { x: number; y: number }>[]): WorkBoardEntityBinding {
    const board = { ...createWorkBoardV1({ id: 'b1', name: 'Board' }), source: { picked: [placed.ref] }, positionsByItemRef: { [placed.key]: { x: 48, y: 24 } } };
    const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
    const store = createWorkBoardAccountStore(persistence.transport, () => true);
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const getContext = () => {
        const current = persistence.acknowledged().boards[0]!;
        return { scope, board: current, membership: projectBoardMembership(current, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
    };
    const port = createWorkBoardUiActionPort(getContext, store.queue);
    return { runtime: createEntityDragDropRuntime(), scope, isCurrent: () => true, getContext, execute: async effect => {
        const { intent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input);
        const saved = await port.apply(intent);
        commits.push({ ...saved.boards[0]!.positionsByItemRef });
        return { status: 'applied' };
    } };
}

describe('Board layouts', () => {
    it('has one primary tab stop and moves through status columns with the shared Collection cursor', async () => {
        const cards = MIXED.filter(card => card.status.bucket !== 'finished');
        const screen = await renderScreen(<BoardByStatus cards={cards} onOpen={() => {}} stacked={false} />, { wrapper: Wrapper });
        const target = (index: number) => screen.findHostByTestId(`board-status-card:${MIXED[index]!.key}`);
        const stops = () => MIXED.filter((_card, index) => target(index)?.props.tabIndex === 0);
        expect(stops()).toEqual([MIXED[0]]);
        await act(() => { target(0)?.props.onKeyDown?.({ key: 'ArrowDown', preventDefault() {} }); });
        expect(stops()).toEqual([MIXED[1]]);
        await act(() => { target(1)?.props.onKeyDown?.({ key: 'ArrowRight', preventDefault() {} }); });
        expect(stops()).toEqual([MIXED[2]]);
        expect(screen.findHostByTestId('board-by-status:column:finished')).not.toBeNull();
        await act(() => { target(2)?.props.onKeyDown?.({ key: 'ArrowRight', preventDefault() {} }); });
        expect(stops()).toEqual([MIXED[4]]);
        await act(() => { target(4)?.props.onKeyDown?.({ key: 'ArrowLeft', preventDefault() {} }); });
        expect(stops()).toEqual([MIXED[2]]);
        const opened: string[] = [];
        await act(async () => screen.update(<BoardByStatus cards={cards.map(card => ({ ...card }))} onOpen={card => opened.push(card.key)} stacked={false} />));
        expect(stops()).toEqual([MIXED[2]]);
        await screen.pressByTestIdAsync(`board-status-card:${MIXED[2]!.key}`);
        expect(opened).toEqual([MIXED[2]!.key]);
    });

    it('By status shows the five shared buckets with every kind in its status column', async () => {
        const screen = await renderScreen(<BoardByStatus cards={MIXED} onOpen={() => {}} stacked={false} />, { wrapper: Wrapper });
        const column = (bucket: string) => screen.findHostByTestId(`board-by-status:column:${bucket}`);
        for (const bucket of ['needs_you', 'working', 'finished', 'idle', 'offline']) expect(column(bucket)).not.toBeNull();
        const keysIn = (bucket: string) => MIXED
            .filter((candidate) => screen.findAllHostsByTestId(`board-status-card:${candidate.key}`)
                .some((host) => column(bucket)?.findAll((node) => node === host).length))
            .map((candidate) => candidate.ref.qualifiedId.id);
        expect(keysIn('needs_you')).toEqual(['checkout', 'release']);
        expect(keysIn('working')).toEqual(['macbook']);
        expect(keysIn('offline')).toEqual(['build-vps']);
    });

    it('on a phone, By status stacks only the statuses that hold something', async () => {
        const screen = await renderScreen(<BoardByStatus cards={MIXED.slice(0, 3)} onOpen={() => {}} stacked />, { wrapper: Wrapper });
        expect(screen.findHostByTestId('board-by-status:column:needs_you')).not.toBeNull();
        expect(screen.findHostByTestId('board-by-status:column:finished')).toBeNull();
    });

    it('returns physical focus and retained stacked scroll after an item or Canvas visit and refresh', async () => {
        const scrolls: number[] = [];
        const opened: string[] = [];
        const props = { cards: MIXED, onOpen: (card: BoardCard) => { opened.push(card.key); }, stacked: true };
        const screen = await renderScreen(<BoardByStatus {...props} active />, { wrapper: Wrapper,
            createNodeMock: element => String(element.type) === 'ScrollView' ? { scrollTo: (value: { y?: number }) => {
                if (value.y !== undefined) scrolls.push(value.y);
            } } : null });
        const scroller = screen.tree.findAll(node => String(node.type) === 'ScrollView' && typeof node.props.onScroll === 'function')[0];
        await act(() => scroller?.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 144 } } }));
        await screen.pressByTestIdAsync(`board-status-card:${MIXED[2]!.key}`);
        expect(opened).toEqual([MIXED[2]!.key]);
        await screen.update(<BoardByStatus {...props} active={false} visible={false} />);
        physicalFocus.keys.length = 0;
        await screen.update(<BoardByStatus {...props} cards={MIXED.map(card => ({ ...card }))} active visible />);
        expect(scrolls).toContain(144);
        expect(physicalFocus.keys).toContain(`board-status-card:${MIXED[2]!.key}`);
    });

    it('restores physical focus when an unplaced card becomes a saved XY card', async () => {
        const placed = MIXED[0]!;
        const binding = canvasBinding(placed, []);
        const props = { cards: [placed], snap: true, binding, onOpen: () => {} };
        const screen = await renderScreen(<BoardCanvas {...props} positionsByItemRef={{}} />);
        await act(async () => { screen.findHostByTestId(`board-canvas-card:${placed.key}`)?.props.onFocus?.(); });
        physicalFocus.keys.length = 0;
        await screen.update(<BoardCanvas {...props} positionsByItemRef={{ [placed.key]: { x: 48, y: 24 } }} />);
        expect(physicalFocus.keys).toContain(`board-canvas-card:${placed.key}`);
        await screen.update(<BoardCanvas key="grip-focus" {...props} positionsByItemRef={{}} />);
        physicalFocus.keys.length = 0;
        await act(async () => { screen.findHostByTestId(`board-canvas-organize:${placed.key}`)?.props.onFocus?.(); });
        expect(physicalFocus.keys).toEqual([]);
        await screen.update(<BoardCanvas key="grip-focus" {...props} positionsByItemRef={{ [placed.key]: { x: 72, y: 24 } }} />);
        expect(physicalFocus.keys).toContain(`board-canvas-card:${placed.key}`);
    });

    it('stages grid moves until Enter, and Escape cancels without a delayed save', async () => {
        vi.useFakeTimers();
        const placed = MIXED[0]!;
        const commits: Record<string, { x: number; y: number }>[] = [];
        const screen = await renderScreen(
            <BoardCanvas
                cards={[placed]}
                positionsByItemRef={{ [placed.key]: { x: 48, y: 24 } }}
                snap
                binding={canvasBinding(placed, commits)}
                onOpen={() => {}}
            />,
        );
        const target = screen.findHostByTestId(`board-canvas-card:${placed.key}`);
        const press = (key: string) => act(async () => { target?.props.onKeyDown?.({ key, preventDefault: () => {} }); });
        await press(' ');
        await press('ArrowRight');
        await press('ArrowRight');
        await press('ArrowDown');
        expect(commits).toEqual([]);
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(commits).toEqual([]);
        await press('Enter');
        const step = BOARD_CANVAS_METRICS.gridStepPx;
        expect(commits).toEqual([{ [placed.key]: { x: 48 + 2 * step, y: 24 + step } }]);
        await press(' ');
        await press('ArrowLeft');
        await press('Escape');
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(commits).toHaveLength(1);
    });

    it('offers a screen reader the same grid moves as named accessibility actions (touch, §5.1)', async () => {
        vi.useFakeTimers();
        const placed = MIXED[0]!;
        const commits: Record<string, { x: number; y: number }>[] = [];
        const screen = await renderScreen(
            <BoardCanvas
                cards={[placed]}
                positionsByItemRef={{ [placed.key]: { x: 48, y: 24 } }}
                snap
                binding={canvasBinding(placed, commits)}
                onOpen={() => {}}
            />,
        );
        const target = screen.findHostByTestId(`board-canvas-card:${placed.key}`);
        const actions = (target?.props.accessibilityActions ?? []) as readonly { name: string }[];
        expect(actions.map((action) => action.name)).toEqual(expect.arrayContaining(['moveUp', 'moveDown', 'moveLeft', 'moveRight']));
        await act(() => { target?.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'moveLeft' } }); });
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(commits).toEqual([{ [placed.key]: { x: 48 - BOARD_CANVAS_METRICS.gridStepPx, y: 24 } }]);
        // A second action uses the acknowledged board, not the stale layout props.
        await act(async () => { target?.props.onAccessibilityAction?.({ nativeEvent: { actionName: 'moveDown' } }); });
        expect(commits.at(-1)).toEqual({ [placed.key]: { x: 48 - BOARD_CANVAS_METRICS.gridStepPx, y: 24 + BOARD_CANVAS_METRICS.gridStepPx } });
    });
});
