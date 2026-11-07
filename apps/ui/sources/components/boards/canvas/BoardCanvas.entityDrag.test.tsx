import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1, buildWorkBoardItemKeyV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { WorkBoardActionInputSchemasV1} from '@happier-dev/protocol/boards/actionsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { createWorkBoardAccountStore } from '../model/workBoardAccountStore';
import { createWorkBoardUiActionPort } from '../model/workBoardEntityDrop';
import { projectBoardMembership } from '../model/boardMembership';
import { buildBoardCards, type BoardCard } from '../model/boardCards';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { BoardCanvas } from './BoardCanvas';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';

const motion = vi.hoisted(() => ({ settles: [] as number[] }));
// Native animation is a system boundary: read the current transform without a UI thread.
vi.mock('react-native-reanimated', async () => {
    const mock = (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock();
    return { ...mock,
        useAnimatedStyle: (read: () => { transform: unknown }) => ({ get transform() { return read().transform; } }),
        withSpring: (value: number) => { motion.settles.push(value); return value; },
    };
});

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Portal placement/focus are browser boundaries; keep the actual menu and its carry callbacks.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 640, maxWidth: 360, placement: 'bottom' }));
// Keyboard focus also opens the grip tooltip, which imports the Popover leaf directly.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 640, maxWidth: 360, placement: 'bottom' }));
vi.mock('@/components/ui/overlays/FloatingOverlay', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    FloatingOverlay: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Board cards must not render markdown'); },
}));
afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); setReducedMotionPreferenceOverride(null); motion.settles = []; });

const ref = { kind: 'machine', qualifiedId: { serverId: 'other-home', id: 'machine-a' } } as const;
const key = buildWorkBoardItemKeyV1(ref);
const card: BoardCard = { key, ref, picked: true, availability: 'ready', title: 'Machine',
    status: { state: 'idle', attentionType: null, bucket: 'idle', tone: 'neutral', word: 'Idle' }, body: { kind: 'none' } };

async function canvas(snap = false, displayedCard = card) {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Board' }), source: { picked: [displayedCard.ref] },
        positionsByItemRef: { [displayedCard.key]: { x: 48, y: 24 } } };
    const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
    const store = createWorkBoardAccountStore(persistence.transport, () => true);
    const getContext = () => {
        const board = persistence.acknowledged().boards[0]!;
        return { scope, board, membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
    };
    const port = createWorkBoardUiActionPort(getContext, store.queue, store.readBoardAccess);
    const runtime = createEntityDragDropRuntime();
    const binding: WorkBoardEntityBinding = { scope, runtime, getContext, isCurrent: () => true,
        execute: async effect => { await port.apply(WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input).intent); return { status: 'applied' }; } };
    const content = { x: 0, y: 0, width: 1200, height: 1200 };
    const screen = await renderScreen(<BoardCanvas cards={[displayedCard]} positionsByItemRef={board.positionsByItemRef} snap={snap} binding={binding} onOpen={() => {}} onAction={() => {}} />,
        { createNodeMock: element => ({ offsetTop: 0, offsetHeight: 32, getBoundingClientRect: () => {
            const bounds = element.type === 'ScrollView' ? { x: 0, y: 0, width: 800, height: 800 } : content;
            return { ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
        } }) });
    const pan = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
    return { screen, pan, runtime, persistence, content, binding };
}

describe('WorkBoard mounted canvas carry', () => {
    it('draws a returning Canvas from its last measurement before fresh layout events', async () => {
        const { screen, binding } = await canvas();
        const retainedLayout = { current: null };
        const props = { cards: [card], positionsByItemRef: {}, snap: false, binding,
            onOpen: () => {}, retainedLayout };
        await screen.update(<BoardCanvas {...props} />);
        const layout = { x: 0, y: 0, width: 800, height: 800 };
        const frame = () => screen.findAllByType('View').find(node =>
            typeof node.props.onLayout === 'function' && typeof node.props.accessibilityElementsHidden === 'boolean')!;
        await act(async () => { screen.findByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout } }); });
        await act(async () => { frame().props.onLayout({ nativeEvent: { layout: { ...layout, width: 408, height: 240 } } }); });
        expect(frame().props.accessibilityElementsHidden).toBe(false);
        await screen.update(<></>);
        // Phone By status has replaced Canvas. Returning must not wait for the
        // native/browser measurement round trip to show this already known card.
        await screen.update(<BoardCanvas {...props} />);
        expect(frame().props.accessibilityElementsHidden).toBe(false);
    });

    it('retains the held card action and its accessible disabled state during carry', async () => {
        const runRef = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'held' } } as const;
        const held = buildBoardCards([{ key: buildWorkBoardItemKeyV1(runRef), ref: runRef, picked: true, sourced: false, available: true }], {
            nowMs: Date.now(), session: () => null, machine: () => null, workflow: () => null,
            machineSessionCounts: new Map(), accountScopedHome: () => true,
            workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ state: 'waiting_for_review' }), null),
        })[0]!;
        const { screen, pan } = await canvas(true, held);
        expect(screen.findHostByTestId(`board-card:${held.key}:review`)).not.toBeNull();
        // The action is the card's sibling target inside one frame, never a button inside the card's own button.
        const target = screen.findAllByType('Pressable').find(node => node.props.testID === 'board-canvas-card:' + held.key)!;
        expect(target.findAll(node => node.props.testID === `board-card:${held.key}:review`)).toHaveLength(0);
        expect(screen.findByTestId(`board-card:${held.key}`)!.findAll(node => node.props.testID === `board-card:${held.key}:review`).length).toBeGreaterThan(0);
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 });
            pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        const review = screen.findHostByTestId(`board-card:${held.key}:review`);
        expect(review).not.toBeNull();
        expect(review!.props.accessibilityState).toMatchObject({ disabled: true });
    });

    it.each([false, true])('lifts and carries one-to-one, previews the snapped destination, and settles through motion preference %s', async reduced => {
        setReducedMotionPreferenceOverride(reduced);
        const { screen, pan, persistence, binding } = await canvas(true);
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 });
            pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        const carried = screen.findAllByType('Animated.View')[0]!;
        expect(carried.props.style[0].transform).toEqual([{ translateX: 31 }, { translateY: 7 }, { scale: reduced ? 1 : motionTokens.drag.liftScale }]);
        expect(screen.findByTestId('board-canvas-snap-target')).not.toBeNull();
        expect(screen.findByTestId('board-canvas-snap-guide-x')).not.toBeNull();
        expect(screen.findByTestId('board-canvas-snap-guide-y')).not.toBeNull();
        expect(screen.getTextContent()).toContain('boards.canvas.snapsHere');
        // Same admitted grid cell: numeric pointer frames must still move the carried card.
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 135, absoluteY: 111 }); });
        expect(carried.props.style[0].transform).toEqual([{ translateX: 35 }, { translateY: 11 }, { scale: reduced ? 1 : motionTokens.drag.liftScale }]);
        motion.settles = [];
        await act(async () => { pan.__handlers.onEnd!({ absoluteX: 135, absoluteY: 111 }, true); pan.__handlers.onFinalize!(); });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 72, y: 24 });
        expect(motion.settles.length > 0).toBe(!reduced);
        expect(screen.findByTestId('board-canvas-snap-target')).toBeNull();
        await screen.update(<BoardCanvas cards={[card]} positionsByItemRef={persistence.acknowledged().boards[0]!.positionsByItemRef}
            snap binding={binding} onOpen={() => {}} />);
        expect(screen.findAllByType('Animated.View')[0]!.props.style[0].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });

    it('keeps card taps and scrolling outside the intentional native drag grip', async () => {
        const { screen } = await canvas();
        const recognizer = screen.findAllByType('GestureDetector')[0]!;
        // The native recognizer's child region decides which touches can start a carry.
        expect(recognizer.findAll(node => String(node.type) === 'Pressable' && node.props.testID === 'board-canvas-card:' + key).length).toBe(0);
        expect(recognizer.findAll(node => String(node.type) === 'Pressable' && node.props.testID === 'board-canvas-organize:' + key).length).toBe(1);
    });

    it('offers current grid positions to the shared chooser and executes the same Board intent', async () => {
        const { screen, runtime, persistence } = await canvas();
        await act(async () => { screen.findHostByTestId('board-canvas-organize:' + key)?.props.onKeyDown?.({ key: 'ContextMenu', preventDefault() {} }); });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', item: { kind: 'work-board-item' } });
        expect(screen.findAllByType(DropdownMenu).some(node => node.props.open)).toBe(true);
        const sourceId = runtime.getSnapshot().sourceId!;
        const choices = runtime.getDestinations(sourceId);
        expect(choices).toHaveLength(4);
        const right = choices.find(choice => JSON.stringify(choice.destination) === JSON.stringify({ kind: 'grid-step', direction: 'right' }));
        expect(right).toBeDefined();
        await act(async () => {
            const chooser = screen.findAllByType(DropdownMenu).find(node => node.props.open)!;
            chooser.props.onSelect(String(choices.indexOf(right!)));
        });
        await vi.waitFor(() => expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 72, y: 24 }));
    });

    it('uses current scrolled bounds, preserves grab offset, and snaps once while Shift is held', async () => {
        const events = new EventTarget();
        vi.stubGlobal('window', events);
        const { pan, runtime, persistence, content } = await canvas();
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: { intent: { positionsByItemRef: { [key]: { x: 79, y: 31 } } } } } });
        content.x = -40; content.y = -60;
        await act(async () => { events.dispatchEvent(new Event('scroll')); });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: { intent: { positionsByItemRef: { [key]: { x: 119, y: 91 } } } } } });
        await act(async () => { events.dispatchEvent(Object.assign(new Event('dragover'), { shiftKey: true })); });
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: { intent: { positionsByItemRef: { [key]: { x: 120, y: 96 } } } } } });
        await act(async () => {
            pan.__handlers.onEnd!({ absoluteX: 131, absoluteY: 107 }, true);
            pan.__handlers.onFinalize!();
        });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 120, y: 96 });
    });

    it('forwards a failed native end so finalize cannot save an allowed position', async () => {
        const { screen, pan, runtime, persistence } = await canvas();
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 });
            pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        await act(async () => { pan.__handlers.onEnd!({ absoluteX: 131, absoluteY: 107 }, false); pan.__handlers.onFinalize!(); });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 48, y: 24 });
        expect(runtime.getSnapshot().phase).not.toBe('pending');
        expect(screen.findAllByType('Animated.View')[0]!.props.style[0].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });

    it('returns the carried card when persistence fails after an allowed release', async () => {
        const { screen, pan, runtime, persistence } = await canvas(true);
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 });
            pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        persistence.offline(true);
        await act(async () => { pan.__handlers.onEnd!({ absoluteX: 131, absoluteY: 107 }, true); pan.__handlers.onFinalize!(); });
        expect(runtime.getSnapshot().phase).toBe('settled');
        expect(runtime.getSnapshot().outcome).toBeDefined();
        expect(runtime.getSnapshot().outcome!.status).not.toBe('applied');
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 48, y: 24 });
        expect(screen.findAllByType('Animated.View')[0]!.props.style[0].transform).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });
});
