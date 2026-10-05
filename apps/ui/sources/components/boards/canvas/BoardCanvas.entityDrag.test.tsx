import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkBoardV1, WorkBoardActionInputSchemasV1, buildWorkBoardItemKeyV1 } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { createWorkBoardAccountStore } from '../model/workBoardAccountStore';
import { createWorkBoardUiActionPort } from '../model/workBoardEntityDrop';
import { projectBoardMembership } from '../model/boardMembership';
import type { BoardCard } from '../model/boardCards';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { BoardCanvas } from './BoardCanvas';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Portal placement/focus are browser boundaries; keep the actual menu and its carry callbacks.
vi.mock('@/components/ui/popover', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Popover: (props: { open: boolean; children: React.ReactNode | ((bounds: { maxHeight: number; maxWidth: number }) => React.ReactNode) }) => props.open
        ? React.createElement(React.Fragment, null, typeof props.children === 'function' ? props.children({ maxHeight: 640, maxWidth: 360 }) : props.children) : null,
}));
vi.mock('@/components/ui/overlays/FloatingOverlay', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    FloatingOverlay: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Board cards must not render markdown'); },
}));
afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); });

const ref = { kind: 'machine', qualifiedId: { serverId: 'other-home', id: 'machine-a' } } as const;
const key = buildWorkBoardItemKeyV1(ref);
const card: BoardCard = { key, ref, picked: true, availability: 'ready', title: 'Machine',
    status: { bucket: 'idle', tone: 'neutral', word: 'Idle' }, body: { kind: 'none' } };

async function canvas() {
    const scope = { serverId: 'home-a', accountId: 'account-a' };
    const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Board' }), source: { picked: [ref] },
        positionsByItemRef: { [key]: { x: 48, y: 24 } } };
    const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [board] });
    const store = createWorkBoardAccountStore(persistence.transport, () => true);
    const getContext = () => {
        const board = persistence.acknowledged().boards[0]!;
        return { scope, board, membership: projectBoardMembership(board, { isHomeMounted: () => true, sections: {}, filtered: null }), isHomeMounted: () => true };
    };
    const port = createWorkBoardUiActionPort(getContext, store.queue);
    const runtime = createEntityDragDropRuntime();
    const binding: WorkBoardEntityBinding = { scope, runtime, getContext, isCurrent: () => true,
        execute: async effect => { await port.apply(WorkBoardActionInputSchemasV1['boards.apply'].parse(effect.input).intent); return { status: 'applied' }; } };
    const content = { x: 0, y: 0, width: 1200, height: 1200 };
    const screen = await renderScreen(<BoardCanvas cards={[card]} positionsByItemRef={board.positionsByItemRef} snap={false} binding={binding} onOpen={() => {}} />,
        { createNodeMock: element => ({ offsetTop: 0, offsetHeight: 32, getBoundingClientRect: () => {
            const bounds = element.type === 'ScrollView' ? { x: 0, y: 0, width: 800, height: 800 } : content;
            return { ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
        } }) });
    const pan = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
    return { screen, pan, runtime, persistence, content };
}

describe('WorkBoard mounted canvas carry', () => {
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
        const { pan, runtime, persistence } = await canvas();
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 100, absoluteY: 100 });
            pan.__handlers.onUpdate!({ absoluteX: 131, absoluteY: 107 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        await act(async () => { pan.__handlers.onEnd!({ absoluteX: 131, absoluteY: 107 }, false); pan.__handlers.onFinalize!(); });
        expect(persistence.acknowledged().boards[0]!.positionsByItemRef[key]).toEqual({ x: 48, y: 24 });
        expect(runtime.getSnapshot().phase).not.toBe('pending');
    });
});
