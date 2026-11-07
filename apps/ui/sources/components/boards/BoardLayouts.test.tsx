import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1, type BoardItemRefV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { WorkBoardActionInputSchemasV1} from '@happier-dev/protocol/boards/actionsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { BoardByStatus } from './byStatus/BoardByStatus';
import { BoardCanvas, type BoardCanvasLayoutSnapshot } from './canvas/BoardCanvas';
import { buildBoardCards, type BoardCard } from './model/boardCards';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
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

// The app entry loads the real Sync owner before visible Session cards demand content.
await import('@/sync/syncEngine');

const searchRuntime = { open: () => {}, buildCommands: () => [] };
function Wrapper({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={null}><UniversalSearchRuntimeProvider value={searchRuntime}>{children}</UniversalSearchRuntimeProvider></InjectedAuthProvider>;
}

afterEach(async () => {
    vi.useRealTimers();
    await standardCleanup();
    physicalFocus.keys.length = 0;
});

function card(kind: Exclude<BoardItemRefV1['kind'], 'task'>, id: string, bucket: BoardCard['status']['bucket']): BoardCard {
    const ref: BoardItemRefV1 = { kind, qualifiedId: { serverId: 'home-a', id } };
    return {
        key: JSON.stringify([kind, 'home-a', id]),
        ref,
        picked: true,
        availability: 'ready',
        title: id,
        status: { state: bucket, bucket, tone: bucket === 'needs_you' ? 'attention' : 'neutral', word: bucket,
            attentionType: bucket === 'needs_you' ? 'decision' : null },
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
    const port = createWorkBoardUiActionPort(getContext, store.queue, store.readBoardAccess);
    return { runtime: createEntityDragDropRuntime(), scope, isCurrent: () => true, getContext, execute: async effect => {
        const { intent } = WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input);
        const saved = await port.apply(intent);
        commits.push({ ...saved.boards[0]!.positionsByItemRef });
        return { status: 'applied' };
    } };
}

describe('Board layouts', () => {
    it.each(['canvas', 'status'] as const)('reads only changed presentation inputs on a 1,000-Session %s arrival', async layout => {
        const cards = Array.from({ length: 1000 }, (_, index) => card('session', `large-${index}`, 'idle'));
        const heights = new Map(cards.map(card => [card.key, BOARD_CANVAS_METRICS.gridStepPx * 3]));
        let geometryReads = 0;
        Object.defineProperty(heights, 'has', { value(key: string) {
            geometryReads += 1;
            return Map.prototype.has.call(heights, key);
        } });
        const retainedLayout: React.RefObject<BoardCanvasLayoutSnapshot | null> = { current: {
            width: BOARD_CANVAS_METRICS.cardWidthPx * 2 + BOARD_CANVAS_METRICS.gapPx + BOARD_CANVAS_METRICS.paddingPx * 2,
            viewportHeight: BOARD_CANVAS_METRICS.gridStepPx * 20, heights, positions: new Map(),
        } };
        const props = { cards, positionsByItemRef: {}, snap: false, retainedLayout, binding: canvasBinding(cards[0]!, []), onOpen: () => {} };
        const render = (cards: readonly BoardCard[]) => layout === 'canvas'
            ? <BoardCanvas {...props} cards={cards} />
            : <BoardByStatus cards={cards} onOpen={props.onOpen} stacked={false} />;
        const started = performance.now();
        const screen = await renderScreen(render(cards));
        const mountedAt = performance.now();
        const titleReads = new Set<number>();
        const statusReads = new Set<number>();
        cards.forEach((card, index) => {
            const title = card.title;
            const word = card.status.word;
            Object.defineProperty(card, 'title', { configurable: true, enumerable: true, get() { titleReads.add(index); return title; } });
            Object.defineProperty(card.status, 'word', { configurable: true, enumerable: true, get() { statusReads.add(index); return word; } });
        });
        const next = cards.map((card, index) => index === 7 ? { ...card, title: 'Updated Session' } : card);
        titleReads.clear(); statusReads.clear(); geometryReads = 0;
        await screen.update(render(next));
        console.info('FX-125c full Board layout cost', { layout, cards: cards.length, mountMs: mountedAt - started,
            arrivalMs: performance.now() - mountedAt, titleRowsRead: titleReads.size, statusRowsRead: statusReads.size, geometryReads });
        expect(screen.getTextContent()).toContain('Updated Session');
        expect([...titleReads].filter(index => index !== 7)).toEqual([]);
        expect([...statusReads].filter(index => index !== 7)).toEqual([]);
        expect(geometryReads).toBe(0);
    });

    it('places failure-only Run Updates in Finished and concurrent real holds in Needs you', async () => {
        const rows = [false, true].map(invocationAttentionRequired => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id: invocationAttentionRequired ? 'held-failure' : 'failed', state: 'failed', failureUnseen: true,
            attentionRequired: true, invocationAttentionRequired,
        }), null));
        const cards = buildBoardCards(rows.map(row => ({ key: row.id, ref: { kind: 'workflow_run' as const,
            qualifiedId: { serverId: 'home-a', id: row.id } }, picked: true, sourced: false, available: true })), {
            nowMs: 1, session: () => null, workflow: () => null, machine: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true,
            workflowRun: ref => rows.find(row => row.id === ref.qualifiedId.id) ?? null,
        });
        const screen = await renderScreen(<BoardByStatus cards={cards} onOpen={() => {}} stacked={false} />, { wrapper: Wrapper });
        const contains = (bucket: string, key: string) => {
            const column = screen.findHostByTestId(`board-by-status:column:${bucket}`);
            return screen.findAllHostsByTestId(`board-status-card:${key}`).some(host => column?.findAll(node => node === host).length);
        };
        expect(contains('finished', 'failed')).toBe(true);
        expect(contains('needs_you', 'failed')).toBe(false);
        expect(contains('needs_you', 'held-failure')).toBe(true);
    });
    it('auto-places grid-sized card frames with the same gutter in both drop modes', async () => {
        const cards = [card('session', 'short', 'idle'), card('workflow', 'tall', 'idle'), card('machine', 'third', 'idle')];
        const props = { cards, positionsByItemRef: {}, snap: true, binding: canvasBinding(cards[0]!, []), onOpen: () => {} };
        const screen = await renderScreen(<BoardCanvas {...props} />);
        const frame = (key: string) => {
            let node = screen.findHostByTestId(`board-canvas-card:${key}`)!;
            while (typeof node.props.onLayout !== 'function' || typeof node.props.accessibilityElementsHidden !== 'boolean') node = node.parent!;
            return node;
        };
        const flatten = (style: unknown): Record<string, number> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, number> : {};
        // Work cards are built once the Canvas has reported its size (they window on it).
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 992, height: 900 } } });
        });
        await act(async () => {
            for (const [index, member] of cards.entries()) frame(member.key).props.onLayout({ nativeEvent: { layout: {
                x: 0, y: 0, width: 408, height: index === 1 ? 88 : 64,
            } } });
        });
        const check = () => {
            const first = flatten(frame(cards[0]!.key).props.style), second = flatten(frame(cards[1]!.key).props.style);
            const third = flatten(frame(cards[2]!.key).props.style);
            const inset = flatten(screen.findHostByTestId(`board-card:${cards[0]!.key}.description`)!.props.style).paddingBottom ?? 0;
            expect(first.width % 24).toBe(0);
            expect(second.left - first.left - first.width).toBe(BOARD_CANVAS_METRICS.gapPx);
            expect(third.top - first.top - (64 + inset)).toBe(BOARD_CANVAS_METRICS.gapPx);
            for (const member of cards) {
                const position = flatten(frame(member.key).props.style);
                expect((position.left - 24) % 24).toBe(0);
                expect((position.top - 24) % 24).toBe(0);
            }
        };
        check();
        await screen.update(<BoardCanvas {...props} snap={false} />);
        check();
        // The real layout callback includes the newly painted inset; that feedback must settle.
        await act(async () => frame(cards[0]!.key).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 408, height: 72 } } }));
        check();
        // A shorter refreshed card sheds its previous grid inset instead of keeping a stale height.
        await act(async () => frame(cards[0]!.key).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 408, height: 56 } } }));
        const first = flatten(frame(cards[0]!.key).props.style), third = flatten(frame(cards[2]!.key).props.style);
        expect(third.top - first.top).toBe(72);
    });
    it('mounts only the cards near the viewport of a 1,500-card Canvas and keeps its full scroll extent', async () => {
        const cards = Array.from({ length: 1500 }, (_, index) => card('session', `window-${index}`, 'idle'));
        const cardHeight = BOARD_CANVAS_METRICS.gridStepPx * 3;
        const row = cardHeight + BOARD_CANVAS_METRICS.gapPx;
        const viewportHeight = row * 15; // two columns: about 30 cards visible
        const retainedLayout: React.RefObject<BoardCanvasLayoutSnapshot | null> = { current: {
            width: BOARD_CANVAS_METRICS.cardWidthPx * 2 + BOARD_CANVAS_METRICS.gapPx + BOARD_CANVAS_METRICS.paddingPx * 2,
            viewportHeight, heights: new Map(cards.map(card => [card.key, cardHeight])), positions: new Map(),
        } };
        const screen = await renderScreen(<BoardCanvas cards={cards} positionsByItemRef={{}} snap={false} retainedLayout={retainedLayout}
            binding={canvasBinding(cards[0]!, [])} onOpen={() => {}} />);
        const mounted = () => cards.filter(card => screen.findHostByTestId(`board-canvas-card:${card.key}`) !== null).length;
        // The shared near-viewport window: one viewport above, two below, and one scroll quantum.
        const windowRows = Math.ceil((viewportHeight * 2 + BOARD_CANVAS_METRICS.gridStepPx) / row) + 1;
        expect(mounted()).toBeGreaterThanOrEqual(30);
        expect(mounted()).toBeLessThanOrEqual(windowRows * 2);
        // Unmounted cards keep their place: the scroll extent still holds every row.
        const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, unknown> : {};
        const content = screen.findHostByTestId('board-canvas-horizontal')!.children.find(child => typeof child !== 'string'
            && Number(flatten((child as { props: { style?: unknown } }).props.style).minHeight) > 0) as { props: { style?: unknown } } | undefined;
        expect(Number(flatten(content?.props.style).minHeight)).toBeGreaterThanOrEqual(750 * row);
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 400 * row } } });
        });
        expect(screen.findHostByTestId(`board-canvas-card:${cards[801]!.key}`)).not.toBeNull();
        expect(screen.findHostByTestId(`board-canvas-card:${cards[0]!.key}`)).toBeNull();
        expect(mounted()).toBeLessThanOrEqual(windowRows * 2 + 2 * Math.ceil(viewportHeight / row));
    });

    it('builds only a window of a cold Board on its first scroll: unmeasured cards are placed at the measured card height', async () => {
        const cards = Array.from({ length: 120 }, (_, index) => card('session', `cold-${index}`, 'idle'));
        const cardHeight = BOARD_CANVAS_METRICS.gridStepPx * 4;
        const row = cardHeight + BOARD_CANVAS_METRICS.gapPx;
        const viewportHeight = row * 4;
        const screen = await renderScreen(<BoardCanvas cards={cards} positionsByItemRef={{}} snap={false}
            binding={canvasBinding(cards[0]!, [])} onOpen={() => {}} />);
        const frame = (key: string) => {
            let node = screen.findHostByTestId(`board-canvas-card:${key}`);
            while (node && (typeof node.props.onLayout !== 'function' || typeof node.props.accessibilityElementsHidden !== 'boolean')) node = node.parent!;
            return node;
        };
        const built = () => cards.filter(member => screen.findHostByTestId(`board-canvas-card:${member.key}`) !== null);
        const measured = new Set<string>();
        // Every built card reports its real frame, as the browser does after the commit that builds it.
        const measureBuilt = async () => {
            for (let round = 0; round < 50; round += 1) {
                const fresh = built().filter(member => !measured.has(member.key));
                if (fresh.length === 0) return;
                await act(async () => {
                    for (const member of fresh) {
                        measured.add(member.key);
                        frame(member.key)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: cardHeight } } });
                    }
                });
            }
        };
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: {
                width: BOARD_CANVAS_METRICS.cardWidthPx * 2 + BOARD_CANVAS_METRICS.gapPx + BOARD_CANVAS_METRICS.paddingPx * 2,
                height: viewportHeight } } });
        });
        await measureBuilt();
        // The shared near-viewport window: one viewport above, two below, plus one scroll quantum; two columns.
        const windowCards = (Math.ceil((viewportHeight * 3 + BOARD_CANVAS_METRICS.gridStepPx) / row) + 1) * 2;
        // Before any card has measured, cards can only be placed at one grid step: the open builds that window once.
        const coldWindowCards = (Math.ceil((viewportHeight * 3 + BOARD_CANVAS_METRICS.gridStepPx) / BOARD_CANVAS_METRICS.gridStepPx) + 1) * 2;
        expect(measured.size).toBeLessThanOrEqual(coldWindowCards);
        await act(async () => {
            // Past the cards the open measured: the window now reaches only cards that have never been built.
            screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: viewportHeight * 4 } } });
        });
        // The first scroll builds the next window (one row of slack), not every unmeasured card its grid-step
        // lower bounds pull into view.
        expect(built().filter(member => !measured.has(member.key)).length).toBeGreaterThan(0);
        expect(built().length).toBeLessThanOrEqual(windowCards + 2);
    });

    it('redraws no Canvas card when the open Board re-renders with fresh card callbacks', async () => {
        // The open Board re-renders on every live-source update (reachability, Session rows) and hands the
        // Canvas new callback closures; a card's frame and body are unchanged, so none may redraw.
        const cards = Array.from({ length: 40 }, (_, index) => card('machine', `quiet-${index}`, 'idle'));
        const heights = new Map(cards.map(card => [card.key, BOARD_CANVAS_METRICS.gridStepPx * 3]));
        const retainedLayout: React.RefObject<BoardCanvasLayoutSnapshot | null> = { current: {
            width: BOARD_CANVAS_METRICS.cardWidthPx * 2 + BOARD_CANVAS_METRICS.gapPx + BOARD_CANVAS_METRICS.paddingPx * 2,
            viewportHeight: BOARD_CANVAS_METRICS.gridStepPx * 20, heights, positions: new Map(),
        } };
        const binding = canvasBinding(cards[0]!, []);
        const render = () => <BoardCanvas cards={cards} positionsByItemRef={{}} snap={false} retainedLayout={retainedLayout}
            binding={binding} onOpen={() => {}} onAction={() => {}} onPlaced={() => {}} />;
        const screen = await renderScreen(render());
        const titleReads = new Set<number>();
        cards.forEach((card, index) => {
            const title = card.title;
            Object.defineProperty(card, 'title', { configurable: true, enumerable: true, get() { titleReads.add(index); return title; } });
        });
        await screen.update(render());
        await screen.update(render());
        expect(titleReads.size).toBe(0);
        // A widget renderer change (widget descriptors arriving while the Board opens) is a widget input only.
        await screen.update(<BoardCanvas cards={cards} positionsByItemRef={{}} snap={false} retainedLayout={retainedLayout}
            binding={binding} onOpen={() => {}} onAction={() => {}} onPlaced={() => {}} renderWidget={() => null} />);
        expect(titleReads.size).toBe(0);
    });

    it('flows filtered cards around saved hand positions and retains geometry and identity on an unrelated update', async () => {
        const picked = [card('workflow', 'own-workflow', 'idle'), card('workflow_run', 'stopped-run', 'finished'),
            card('machine', 'own-machine', 'working'), card('session', 'own-session', 'working')];
        const filtered = Array.from({ length: 17 }, (_, index) => ({ ...card('session', `filtered-${index}`, 'needs_you'), picked: false }));
        const cards = [...picked, ...filtered];
        const positionsByItemRef = { [picked[0]!.key]: { x: 24, y: 0 }, [picked[1]!.key]: { x: 0, y: 112 },
            [picked[2]!.key]: { x: 456, y: 0 }, [picked[3]!.key]: { x: 456, y: 256 } };
        const commits: Record<string, { x: number; y: number }>[] = [];
        const props = { cards, positionsByItemRef, snap: true, binding: canvasBinding(picked[0]!, commits), onOpen: () => {} };
        const screen = await renderScreen(<BoardCanvas {...props} />);
        const frame = (key: string) => {
            let node = screen.findHostByTestId(`board-canvas-card:${key}`)!;
            while (typeof node.props.onLayout !== 'function' || typeof node.props.accessibilityElementsHidden !== 'boolean') node = node.parent!;
            return node;
        };
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 992, height: 900 } } });
        });
        await act(async () => {
            for (const [index, member] of cards.entries()) frame(member.key).props.onLayout({ nativeEvent: { layout: {
                x: 0, y: Math.max(0, Math.floor((index - picked.length) / 2)) * 88, width: 400,
                height: index < 2 ? 88 : 64,
            } } });
        });
        const rectangles = () => cards.map((member, index) => {
            const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
                ? Object.assign({}, ...style.map(flatten)) : style && typeof style === 'object' ? style as Record<string, unknown> : {};
            const style = flatten(frame(member.key).props.style);
            const flowIndex = index - picked.length;
            const inset = flatten(screen.findHostByTestId(`board-card:${member.key}.description`)!.props.style).paddingBottom ?? 0;
            return { key: member.key, x: Number(style.left ?? 24 + flowIndex % 2 * 432),
                y: Number(style.top ?? 24 + Math.floor(flowIndex / 2) * 96),
                width: Number(style.width), height: (index < 2 ? 88 : 64) + Number(inset) };
        });
        const before = rectangles();
        // No two cards share area: automatic cards avoid every hand-placed one, and stored positions that collide settle apart (FA19 W10).
        const overlaps = before.flatMap((a, index) => before.slice(index + 1).filter(b =>
            a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
            .map(b => [a.key, b.key]));
        expect(overlaps).toEqual([]);
        for (const member of picked) {
            const rectangle = before.find(rectangle => rectangle.key === member.key)!;
            expect({ x: rectangle.x - 24, y: rectangle.y - 24 }).toEqual(positionsByItemRef[member.key]);
        }
        for (const rectangle of before.slice(picked.length)) {
            expect((rectangle.x - 24) % BOARD_CANVAS_METRICS.gridStepPx).toBe(0);
            expect((rectangle.y - 24) % BOARD_CANVAS_METRICS.gridStepPx).toBe(0);
        }
        const hosts = cards.map(member => screen.findHostByTestId(`board-canvas-card:${member.key}`));
        await screen.update(<BoardCanvas {...props} cards={cards.map((member, index) => index === 20 ? { ...member, title: 'Updated session' } : member)} />);
        expect(rectangles()).toEqual(before);
        cards.forEach((member, index) => expect(screen.findHostByTestId(`board-canvas-card:${member.key}`)).toBe(hosts[index]));
        expect(commits).toEqual([]);
    });

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
        for (const card of MIXED) {
            expect(screen.findByTestId(`board-card:${card.key}:word`)).toBeNull();
            // Only work that needs the person or is in trouble keeps what it waits for, on its own line.
            expect(screen.findByTestId(`board-card:${card.key}:needs`) !== null).toBe(card.status.tone !== 'neutral');
            expect(screen.findHostByTestId(`board-status-card:${card.key}`)?.props.accessibilityLabel).toContain(card.status.word);
        }
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
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 992, height: 900 } } });
        });
        const retained = screen.findHostByTestId(`board-canvas-card:${placed.key}`);
        await act(async () => { screen.findHostByTestId(`board-canvas-card:${placed.key}`)?.props.onFocus?.(); });
        physicalFocus.keys.length = 0;
        await screen.update(<BoardCanvas {...props} positionsByItemRef={{ [placed.key]: { x: 48, y: 24 } }} />);
        expect(screen.findHostByTestId(`board-canvas-card:${placed.key}`)).toBe(retained);
        expect(physicalFocus.keys).toContain(`board-canvas-card:${placed.key}`);
        await screen.update(<BoardCanvas key="grip-focus" {...props} positionsByItemRef={{}} />);
        await act(async () => {
            screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 992, height: 900 } } });
        });
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
