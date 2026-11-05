// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, StyleSheet, Text, type ScrollView } from 'react-native';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, TodoReorderInputV1Schema,
    type TodoReorderInputV1 } from '@happier-dev/protocol';
import { createDeferred, flushHookEffects, renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useEntityDragDropRuntime } from '../entityDragDropHooks';
import type { EntityDragDropRuntime } from '../entityDragDropTypes';
import { PopoverScrollSourceProvider } from '@/components/ui/popover/PopoverScrollSource';
import { EntityFlatReorderList, EntityFlatReorderRow, entityReorderPreview, settleEntityReorderWrite, type EntityFlatReorderBinding } from './EntityFlatReorder';
import { EntityDragGripTrigger, EntityStagedMoveDock, StagedMoveDockSlotContext, type StagedMoveDockSlot } from './EntityReleasePreview';
import { TreeDropIndicatorLine } from './TreeDropIndicatorLine';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/utils/web/reactDomCjs', () => {
    // ReactTestRenderer cannot mount a DOM portal; only this rendering boundary is replaced.
    return { requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) };
});

const scope = { serverId: 'home-a', accountId: 'account-a' };
let runtime: EntityDragDropRuntime;
const screens: RenderScreenResult[] = [];
const domRows: HTMLElement[] = [];
function RuntimeProbe(props: Readonly<{ enumerate?: boolean }>) {
    runtime = useEntityDragDropRuntime();
    React.useEffect(() => props.enumerate ? runtime.subscribe(() => {
        const sourceId = runtime.getSnapshot().sourceId;
        if (sourceId) runtime.getDestinations(sourceId);
    }) : undefined, [props.enumerate]);
    return null;
}

function fixture(scrollRef?: React.RefObject<ScrollView | null>, acknowledgement?: Promise<void>, enumerate = false) {
    const model = { ids: ['a', 'b', 'c'], scope, writes: [] as TodoReorderInputV1[], pending: new Set<string>(), dockSlot: null as StagedMoveDockSlot | null };
    const binding = (): EntityFlatReorderBinding => ({
        scope: model.scope, kind: 'todo', items: model.ids.map(id => ({ id, title: id })),
        getItem: id => model.ids.includes(id) ? { kind: 'todo', scope: model.scope, todoId: id } : null,
        getSourceId: item => item.kind === 'todo' ? item.todoId : null,
        resolve: (sourceId, position) => {
            const next = resolveAnchoredListMoveV1(model.ids, sourceId, position);
            if (!next || next.every((id, offset) => id === model.ids[offset])) {
                return { status: 'refused', reason: { code: 'stale_or_noop', message: 'Unavailable' } };
            }
            return { status: 'allowed', effect: { actionId: 'tasks.internal.reorder',
                input: { scope: model.scope, sourceId, position: { ...position } },
                preview: { glyph: position.placement === 'before' ? 'above' : 'below', verb: 'Move', target: position.anchorId ?? 'List edge' } } };
        },
        // The fixture's external receiving boundary captures portable effects. Runtime, schema,
        // geometry, source/target lifecycle and gesture adapters above it remain real.
        execute: async effect => {
            model.writes.push(TodoReorderInputV1Schema.parse(effect.input));
            if (acknowledgement) await acknowledgement;
            return { status: 'applied' };
        },
    });
    const render = () => <StagedMoveDockSlotContext.Provider value={model.dockSlot}><RuntimeProbe enumerate={enumerate} /><EntityFlatReorderList binding={binding()} testID="list" alwaysOrganizing scrollRef={scrollRef}>
        {model.ids.map(id => <EntityFlatReorderRow key={id} id={id} pending={model.pending.has(id)}>
            {({ renderHandle }) => <>{renderHandle(`grip:${id}`)}<Text>{id}</Text></>}
        </EntityFlatReorderRow>)}
    </EntityFlatReorderList></StagedMoveDockSlotContext.Provider>;
    return { model, render };
}

async function mount(f: ReturnType<typeof fixture>, domRow?: HTMLElement) {
    const screen = await renderScreen(f.render(), {
        createNodeMock: node => {
            const props = node.props;
            if (!props || typeof props !== 'object') return null;
            if ('testID' in props && props.testID === 'list') return {
                getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 300 }),
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 300),
            };
            return domRow && 'onLayout' in props && typeof props.onLayout === 'function' ? domRow : null;
        },
    });
    screens.push(screen);
    await measureRows(screen, f.model.ids);
    return screen;
}

async function measureRows(screen: RenderScreenResult, ids: readonly string[]) {
    await act(async () => {
        for (const [offset, id] of ids.entries()) {
            const row = screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function'
                && node.props.testID !== 'list' && node.findAll(child => child.props.testID === `grip:${id}`).length > 0);
            if (!row) throw new Error(`Missing current row ${id}`);
            row.props.onLayout({ nativeEvent: { layout: { x: 0, y: offset * 50, width: 300, height: 50 } } });
        }
    });
}

function gesture(screen: RenderScreenResult, id: string): TestGestureChain {
    const detector = screen.findAllByType('GestureDetector').find(node => node.findAll(child => child.props.testID === `grip:${id}`).length > 0);
    if (!detector) throw new Error(`Missing gesture ${id}`);
    return detector.props.gesture as TestGestureChain;
}

async function key(screen: RenderScreenResult, id: string, value: string) {
    await act(async () => {
        const grip = screen.findHostByTestId(`grip:${id}`);
        if (!grip || typeof grip.props.onKeyDown !== 'function') throw new Error(`Missing keyboard grip ${id}`);
        grip.props.onKeyDown({ key: value, preventDefault() {}, stopPropagation() {} });
    });
}

beforeEach(() => { Reflect.set(Platform, 'OS', 'web'); });
afterEach(async () => {
    for (const screen of screens.splice(0)) await screen.unmount();
    for (const row of domRows.splice(0)) row.remove();
    window.getSelection()?.removeAllRanges();
    runtime?.cancel('test-end');
    vi.useRealTimers();
});

describe('shared flat reorder UI binding', () => {
    it('gives neighboring descriptions of one effective gap the same identity', async () => {
        const f = fixture();
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        const afterB = runtime.getSnapshot().destinationKey;
        expect(afterB).toBeTypeOf('string');
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 110 }); });
        expect(runtime.getSnapshot().destinationKey).toBe(afterB);
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 140 }); });
        expect(runtime.getSnapshot().destinationKey).not.toBe(afterB);
    });

    it('keeps a release press from opening the grip chooser while its pointer move waits for acknowledgement', async () => {
        const acknowledgement = createDeferred<void>();
        const f = fixture(undefined, acknowledgement.promise);
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        try {
            await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
            await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
            await act(async () => { pan.__handlers.onEnd!({ absoluteX: 10, absoluteY: 90 }, true); });
            expect(runtime.getSnapshot().phase).toBe('pending');
            // Released: the insertion line is gone and the row itself shows where it landed (see the next test).
            expect(screen.root.findAllByType(TreeDropIndicatorLine)).toHaveLength(0);
            await screen.pressByTestIdAsync('grip:a');
            await flushHookEffects({ cycles: 1, frames: 1 });
            expect(screen.root.findAllByType(DropdownMenu).every(menu => !menu.props.open)).toBe(true);
            expect(f.model.writes).toHaveLength(1);
            await act(async () => { acknowledgement.resolve(); });
            expect(runtime.getSnapshot().phase).toBe('settled');
            expect(screen.root.findAllByType(TreeDropIndicatorLine)).toHaveLength(0);
            // A later intentional press still opens the ordinary Move chooser.
            await screen.pressByTestIdAsync('grip:a');
            await flushHookEffects({ cycles: 1, frames: 1 });
            expect(screen.root.findAllByType(DropdownMenu).some(menu => menu.props.open)).toBe(true);
        } finally { acknowledgement.resolve(); }
    });

    it('keeps the released row at its new slot until the owner\'s list shows the move, then follows the owner', async () => {
        const acknowledgement = createDeferred<void>();
        const f = fixture(undefined, acknowledgement.promise);
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        const order = () => [...new Set(screen.root.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('grip:'))
            .map(node => String(node.props.testID)))];
        try {
            expect(order()).toEqual(['grip:a', 'grip:b', 'grip:c']);
            await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
            await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
            await act(async () => { pan.__handlers.onEnd!({ absoluteX: 10, absoluteY: 90 }, true); });
            expect(runtime.getSnapshot().phase).toBe('pending');
            expect(order()).toEqual(['grip:b', 'grip:a', 'grip:c']);
        } finally { acknowledgement.resolve(); }
        await act(async () => { await acknowledgement.promise; });
        expect(runtime.getSnapshot().phase).toBe('settled');
        // The drag runtime has settled, but the owner's list has not shown the move yet: the row stays where it landed.
        expect(order()).toEqual(['grip:b', 'grip:a', 'grip:c']);
        // The owner's own list then carries the move, and the row follows it.
        f.model.ids = ['b', 'a', 'c'];
        await act(async () => { screen.tree.update(f.render()); });
        expect(order()).toEqual(['grip:b', 'grip:a', 'grip:c']);
    });

    it('lands the committed chooser destination despite enumeration and clears feedback on early acknowledgement', async () => {
        const acknowledgement = createDeferred<void>();
        const f = fixture(undefined, acknowledgement.promise, true);
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        const sourceId = runtime.getSnapshot().sourceId!;
        await act(async () => { runtime.cancel(); });
        const destination = runtime.getDestinations(sourceId).find(entry =>
            AnchoredListPositionV1Schema.safeParse(entry.destination).data?.anchorId === 'c'
            && AnchoredListPositionV1Schema.safeParse(entry.destination).data?.placement === 'before')!;
        // A mounted chooser enumerates destinations on semantic notifications; enumeration is read-only.
        const unsubscribe = runtime.subscribe(() => { runtime.getDestinations(sourceId); });
        let move: Promise<unknown> | undefined;
        const order = () => [...new Set(screen.root.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('grip:'))
            .map(node => String(node.props.testID)))];
        const row = () => screen.findAllByType('View').find(node => node.props.onLayout
            && node.props.testID !== 'list' && node.findAll(child => child.props.testID === 'grip:a').length > 0)!;
        try {
            await act(async () => { move = runtime.perform(sourceId, destination.targetId, destination.destination); });
            expect(runtime.getSnapshot().phase).toBe('pending');
            expect.soft(order()).toEqual(['grip:b', 'grip:a', 'grip:c']);
            expect(StyleSheet.flatten(row().props.style)?.opacity).toBeLessThan(1);
            const announcement = () => screen.findByTestId('list.status')!.findAllByType(Text)
                .map(node => node.props.children).join('');
            expect(announcement()).toContain('entityDragDrop.preview.pendingDetail');
            f.model.ids = ['b', 'a', 'c'];
            await screen.update(f.render());
            expect.soft(StyleSheet.flatten(row().props.style)?.opacity ?? 1).toBe(1);
            expect.soft(screen.findByTestId('list.staged') === null).toBe(true);
            expect.soft(announcement()).toBe('');
            await act(async () => { acknowledgement.resolve(); await move; });
            expect(order()).toEqual(['grip:b', 'grip:a', 'grip:c']);
            expect(StyleSheet.flatten(row().props.style)?.opacity ?? 1).toBe(1);
            expect(announcement()).toBe('');
        } finally { unsubscribe(); acknowledgement.resolve(); await move; }
    });

    it('draws the staged-move dock for a keyboard carry only, never over the rows after a chooser commit', async () => {
        const acknowledgement = createDeferred<void>();
        const f = fixture(undefined, acknowledgement.promise, true);
        const screen = await mount(f);
        try {
            await key(screen, 'a', ' ');
            expect(runtime.getSnapshot().phase).toBe('carrying');
            expect(screen.findByTestId('list.staged')).not.toBeNull();
            const sourceId = runtime.getSnapshot().sourceId!;
            await act(async () => { runtime.cancel(); });
            const destination = runtime.getDestinations(sourceId).find(entry =>
                AnchoredListPositionV1Schema.safeParse(entry.destination).data?.anchorId === 'c'
                && AnchoredListPositionV1Schema.safeParse(entry.destination).data?.placement === 'before')!;
            await act(async () => { void runtime.perform(sourceId, destination.targetId, destination.destination, 'chooser'); });
            expect(runtime.getSnapshot().phase).toBe('pending');
            // The row itself waits half-dimmed at its landing slot; a key-hint card there would sit over its neighbours.
            expect(screen.findByTestId('list.staged')).toBeNull();
        } finally { acknowledgement.resolve(); }
    });

    it('hands the staged-move dock to a host footer rather than drawing it over the rows', async () => {
        const f = fixture();
        const docks: React.ReactNode[] = [];
        f.model.dockSlot = dock => { docks.push(dock); };
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        // The footer owner draws it; the list keeps nothing over its foot rows.
        expect(screen.findByTestId('list.staged')).toBeNull();
        const staged = docks.at(-1);
        expect(React.isValidElement(staged) && staged.type === EntityStagedMoveDock).toBe(true);
        await key(screen, 'a', 'Escape');
        expect(docks.at(-1)).toBeNull();
    });

    it('dims a row whose owner has a write in flight, as a released move waits', async () => {
        const f = fixture();
        f.model.pending.add('b');
        const screen = await mount(f);
        const opacity = (id: string) => StyleSheet.flatten(screen.findAllByType('View').find(node => node.props.onLayout
            && node.props.testID !== 'list' && node.findAll(child => child.props.testID === `grip:${id}`).length > 0)!.props.style)?.opacity ?? 1;
        expect([opacity('a'), opacity('c')]).toEqual([1, 1]);
        expect(opacity('b')).toBeLessThan(1);
    });

    it('keeps repeated row drops in the foreground list over smaller underlying widget targets', async () => {
        const f = fixture();
        const screen = await mount(f);
        const background = runtime.registerTarget({ id: 'underlying-home-widget', scope, acceptedKinds: ['todo'],
            isCurrent: () => true, getBounds: () => ({ x: 0, y: 70, width: 40, height: 25 }),
            resolve: () => ({ status: 'refused', reason: { code: 'widget_instance_changed', message: 'Layout changed' } }),
            execute: async () => { throw new Error('The page behind the list must not receive its drop'); },
        });
        try {
            for (const id of ['a', 'b']) {
                const pan = gesture(screen, id);
                await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: f.model.ids.indexOf(id) * 50 + 10 }); });
                const sourceId = runtime.getSnapshot().sourceId!;
                expect.soft(runtime.getSourceBounds(sourceId)).toEqual({ x: 0, y: f.model.ids.indexOf(id) * 50, width: 300, height: 50 });
                await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
                expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { actionId: 'tasks.internal.reorder' } });
                await act(async () => { pan.__handlers.onEnd!({ absoluteX: 10, absoluteY: 90 }, true); });
                expect(runtime.getSnapshot()).toMatchObject({ phase: 'settled', outcome: { status: 'applied' } });
                const committed = f.model.writes.at(-1)!;
                f.model.ids = resolveAnchoredListMoveV1(f.model.ids, committed.sourceId, committed.position)!;
                await screen.update(f.render());
                await measureRows(screen, f.model.ids);
            }
            expect(f.model.writes.map(write => write.sourceId)).toEqual(['a', 'b']);
            expect(f.model.ids).toEqual(['a', 'b', 'c']);
        } finally { background(); }
    });

    it('moves through a grip accessibility action and exposes the same focus target for restoration', async () => {
        const moves: string[] = [];
        let focusTarget: unknown;
        const node = { focus: vi.fn() };
        const screen = await renderScreen(<EntityDragGripTrigger accessibilityLabel="Move task" testID="accessible-grip"
            onPress={() => {}} accessibilityActions={[{ name: 'moveRight', label: 'Move right' }]}
            onAccessibilityAction={event => moves.push(event.nativeEvent.actionName)}
            controlRef={target => { focusTarget = target; }} />, { createNodeMock: () => node });
        screens.push(screen);
        const grip = screen.findHostByTestId('accessible-grip')!;
        expect(grip.props.accessibilityActions).toEqual([{ name: 'moveRight', label: 'Move right' }]);
        await act(async () => { grip.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveRight' } }); });
        expect(moves).toEqual(['moveRight']);
        expect(focusTarget).toBe(node);
    });
    it('tints the grip during a press and clears it on release without opening Move early', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(<EntityDragGripTrigger accessibilityLabel="Move task" density="touch"
            testID="press-grip" onPress={onPress} />);
        screens.push(screen);
        const grip = screen.findHostByTestId('press-grip')!;
        const background = (pressed: boolean) => StyleSheet.flatten(
            typeof grip.props.style === 'function' ? grip.props.style({ pressed }) : grip.props.style,
        )?.backgroundColor;
        const resting = background(false);
        expect(background(true)).toBeTruthy();
        expect(background(true)).not.toBe(resting);
        expect(background(false)).toBe(resting);
        expect(onPress).not.toHaveBeenCalled();
        await act(async () => { grip.props.onPress(); });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('settles checked save acknowledgements and preserves definitive versus uncertain Action failures', async () => {
        expect(await settleEntityReorderWrite(async () => {})).toEqual({ status: 'applied' });
        for (const [code, status] of [
            ['home_hub_anchor_not_found', 'refused'],
            ['outcome_unknown', 'unknown'],
            ['server_unreachable', 'unknown'],
            ['action_failed', 'unknown'],
        ] as const) {
            // The checked Account save/Action acknowledgement is the external receiving boundary.
            expect(await settleEntityReorderWrite(async () => { throw Object.assign(new Error(code), { code }); }))
                .toMatchObject({ status, reason: { code } });
        }
        expect(await settleEntityReorderWrite(async () => { throw new Error('unclassified transport'); }))
            .toMatchObject({ status: 'unknown' });
    });

    it('autoscrolls the scroller of the overlay it sits in when no scrollRef is passed (Home Sections popover, L77)', async () => {
        const scrollNode = document.createElement('div');
        Object.defineProperty(scrollNode, 'scrollHeight', { value: 1000 });
        scrollNode.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
        scrollNode.scrollTop = 100;
        const overlayScroller = { current: {
            getScrollableNode: () => scrollNode,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        } };
        const base = fixture();
        const f = { model: base.model, render: () => <PopoverScrollSourceProvider scrollSourceRef={overlayScroller}>{base.render()}</PopoverScrollSourceProvider> };
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBeGreaterThan(100);
    });

    it('autoscrolls the RN Web viewport only for this list\'s admitted target and stops on exit, refusal, cancel and unmount', async () => {
        const scrollNode = document.createElement('div');
        Object.defineProperty(scrollNode, 'scrollHeight', { value: 1000 });
        scrollNode.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
        scrollNode.scrollTop = 100;
        // A genuine RN Web ScrollView exposes this OS adapter rather than DOM metrics itself.
        const scrollRef = { current: {
            getScrollableNode: () => scrollNode,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        } } as unknown as React.RefObject<ScrollView | null>;
        const f = fixture(scrollRef);
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        // The source is in this list, but its current place is refused as a no-op.
        expect(runtime.getSnapshot().admission?.status).toBe('refused');
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBe(100);

        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBeGreaterThan(100);
        const offset = scrollNode.scrollTop;

        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 310, absoluteY: 90 }); });
        expect(runtime.getSnapshot().targetId).toBeNull();
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBe(offset);

        // An admitted target elsewhere in the realm must not keep this viewport scrolling.
        let unregister = () => {};
        await act(async () => { unregister = runtime.registerTarget({ id: 'other-list', scope, acceptedKinds: ['todo'],
            isCurrent: () => true, getBounds: () => ({ x: 300, y: 0, width: 300, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'tasks.internal.reorder', input: {},
                preview: { glyph: 'below', verb: 'Move', target: 'Other list' } } }),
            execute: async () => ({ status: 'applied' }),
        }); });
        try {
            await act(async () => { runtime.autoscroll(); });
            expect(runtime.getSnapshot()).toMatchObject({ targetId: 'other-list', admission: { status: 'allowed' } });
            await screen.update(f.render());
            expect(scrollNode.scrollTop).toBe(offset);
        } finally { await act(async () => { unregister(); }); }

        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 10 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('refused');
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBe(offset);

        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        await screen.update(f.render());
        const beforeCancel = scrollNode.scrollTop;
        expect(beforeCancel).toBeGreaterThan(offset);
        await act(async () => { runtime.cancel('pointer-cancel'); });
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBe(beforeCancel);

        // Scrolling belongs to the target list, even when the source is registered elsewhere.
        let unregisterSource = () => {};
        await act(async () => { unregisterSource = runtime.registerSource({ id: 'other-source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'a' }),
        }); });
        try {
            await act(async () => { runtime.begin('other-source')!.move({ x: 10, y: 90 }); runtime.autoscroll(); });
            expect(runtime.getSnapshot().admission?.status).toBe('allowed');
            await screen.update(f.render());
            expect(scrollNode.scrollTop).toBeGreaterThan(beforeCancel);
            await act(async () => { runtime.cancel(); });
        } finally { await act(async () => { unregisterSource(); }); }

        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        await screen.update(f.render());
        const beforeUnmount = scrollNode.scrollTop;
        await screen.unmount();
        screens.splice(screens.indexOf(screen), 1);
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); runtime.autoscroll(); });
        expect(scrollNode.scrollTop).toBe(beforeUnmount);
        expect(runtime.getSnapshot().phase).toBe('idle');
        expect(f.model.writes).toEqual([]);
    });

    it('keeps autoscrolling an engaged carry while the pointer is over the scroller\'s trailing space past the last row, and stops once it leaves the viewport', async () => {
        const scrollNode = document.createElement('div');
        Object.defineProperty(scrollNode, 'scrollHeight', { value: 1000 });
        // The viewport is taller than the three 50 px rows: its bottom edge band lies partly past the last row.
        scrollNode.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
        scrollNode.scrollTop = 100;
        const scrollRef = { current: {
            getScrollableNode: () => scrollNode,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 200),
        } } as unknown as React.RefObject<ScrollView | null>;
        const f = fixture(scrollRef);
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 145 }); });
        expect(runtime.getSnapshot()).toMatchObject({ targetId: expect.stringContaining('"c"'), admission: { status: 'allowed' } });
        await screen.update(f.render());
        const engaged = scrollNode.scrollTop;
        expect(engaged).toBeGreaterThan(100);

        // Trailing padding or an item after the list is no drop place, yet the edge zone still belongs to this carry.
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 190 }); });
        expect(runtime.getSnapshot().targetId).toBeNull();
        await screen.update(f.render());
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBeGreaterThan(engaged);

        const beforeExit = scrollNode.scrollTop;
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 310, absoluteY: 190 }); });
        await screen.update(f.render());
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBe(beforeExit);
        await act(async () => { runtime.cancel('pointer-cancel'); });
    });

    it('captures real DOM pointer targets before body gestures without swallowing main-row activation', async () => {
        const f = fixture();
        f.model.ids = ['a'];
        // This is the native View ref boundary, not a simulated React capture prop:
        // RNWeb does not forward onPointerDownCapture, so actual DOM capture must own the guard.
        const row = document.createElement('div');
        const input = document.createElement('input');
        const button = document.createElement('button');
        const main = document.createElement('div');
        main.setAttribute('role', 'button');
        main.setAttribute('data-entity-drag-body', 'true');
        const mainText = document.createElement('span');
        mainText.textContent = 'Main row';
        main.append(mainText);
        const background = document.createElement('span');
        background.textContent = 'Selectable row text';
        row.append(input, button, main, background);
        document.body.append(row);
        domRows.push(row);
        const screen = await mount(f, row);
        const pan = gesture(screen, 'a');
        const fail = vi.fn();
        const pointerDown = async (target: HTMLElement) => {
            fail.mockClear();
            const event = new MouseEvent('pointerdown', { bubbles: true });
            Object.defineProperty(event, 'pointerType', { value: 'mouse' });
            await act(async () => {
                target.dispatchEvent(event);
                pan.__handlers.onTouchesDown!({}, { fail });
            });
        };
        await pointerDown(input);
        expect(fail).toHaveBeenCalledOnce();
        await pointerDown(button);
        expect(fail).toHaveBeenCalledOnce();
        await pointerDown(mainText);
        expect(fail).not.toHaveBeenCalled();
        await pointerDown(background);
        expect(fail).not.toHaveBeenCalled();

        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(background);
        selection?.addRange(range);
        expect(selection?.toString()).toBe('Selectable row text');
        await pointerDown(background);
        expect(fail).toHaveBeenCalledOnce();
        selection?.removeAllRanges();
        await pointerDown(background);
        expect(fail).not.toHaveBeenCalled();
        expect(f.model.writes).toEqual([]);
    });

    it.each(['ios', 'android'])('cancels an unsuccessful native %s end and finalize without dispatch', async platform => {
        Reflect.set(Platform, 'OS', platform);
        const f = fixture();
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        await act(async () => {
            pan.__handlers.onEnd!({ absoluteX: 10, absoluteY: 90 }, false);
            pan.__handlers.onFinalize!();
        });
        expect(f.model.writes).toEqual([]);
        expect(runtime.getSnapshot().phase).toBe('idle');

        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        await act(async () => { pan.__handlers.onFinalize!(); });
        expect(f.model.writes).toEqual([]);
        expect(runtime.getSnapshot().phase).toBe('idle');
    });

    it('stages keyboard movement, cancels without writes, and dispatches the same semantic anchor on Enter', async () => {
        const f = fixture();
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        expect(runtime.getSnapshot().admission).toMatchObject({ status: 'allowed', effect: { input: {
            sourceId: 'a', position: { anchorId: 'b', placement: 'after' },
        } } });
        expect(screen.root.findByType(EntityStagedMoveDock).props.outcome.glyph).toBe('below');
        expect(f.model.writes).toEqual([]);
        await key(screen, 'a', 'Escape');
        expect(f.model.writes).toEqual([]);
        expect(runtime.getSnapshot().phase).toBe('idle');
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        await key(screen, 'a', 'Enter');
        expect(f.model.writes).toEqual([{ scope, sourceId: 'a', position: { anchorId: 'b', placement: 'after' } }]);
    });

    it('draws the same insertion line for a keyboard carry at the staged place that a drag draws', async () => {
        const f = fixture();
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        expect(screen.root.findAllByType(TreeDropIndicatorLine)).toHaveLength(0);
        await key(screen, 'a', 'ArrowDown');
        const lines = screen.root.findAllByType(TreeDropIndicatorLine);
        expect(lines).toHaveLength(1);
        expect(lines[0]!.props.visual).toMatchObject({ edge: 'bottom' });
        await key(screen, 'a', 'Escape');
        expect(screen.root.findAllByType(TreeDropIndicatorLine)).toHaveLength(0);
    });

    it('uses current chooser destinations and performs the same semantic effect', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const screen = await mount(f);
        await screen.pressByTestIdAsync('grip:a');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        const menu = screen.findAllByType(DropdownMenu).find(node => node.findAll(child => child.props.testID === 'grip:a').length > 0);
        if (!menu) throw new Error('Missing source chooser');
        const sourceId = runtime.getSnapshot().sourceId;
        // Opening a chooser must not begin a carry or dispatch an effect.
        expect(sourceId).toBeNull();
        expect(f.model.writes).toEqual([]);
        const option = (menu.props.items as Array<{ id: string; disabled?: boolean; title: string }>).find(item => !item.disabled);
        if (!option) throw new Error('Missing current b destination');
        await act(async () => { menu.props.onSelect(option.id); });
        expect(f.model.writes).toHaveLength(1);
        expect(f.model.writes[0]).toMatchObject({ scope, sourceId: 'a', position: { anchorId: 'c', placement: 'before' } });
        expect(AnchoredListPositionV1Schema.safeParse(f.model.writes[0]!.position).success).toBe(true);
    });

    it('lists each place a row can go once: between two rows is "before" the lower one, and only the end is "after"', async () => {
        vi.useFakeTimers();
        const f = fixture();
        const screen = await mount(f);
        await screen.pressByTestIdAsync('grip:a');
        await act(async () => { await vi.runOnlyPendingTimersAsync(); });
        const menu = screen.findAllByType(DropdownMenu).find(node => node.findAll(child => child.props.testID === 'grip:a').length > 0);
        if (!menu) throw new Error('Missing source chooser');
        const available = (menu.props.items as Array<{ id: string; disabled?: boolean }>).filter(item => !item.disabled);
        // a, b, c: "a" can go between b and c, or to the end. The gap b|c is not offered as "after b" too.
        expect(available).toHaveLength(2);
        const orders = new Set<string>();
        for (const option of available) {
            await act(async () => { menu.props.onSelect(option.id); });
            const write = f.model.writes.at(-1)!;
            orders.add(JSON.stringify(resolveAnchoredListMoveV1(['a', 'b', 'c'], 'a', write.position)));
        }
        expect(orders.size).toBe(2);
    });

    it('names a place in a horizontal list by reading order, and in a vertical list by above and below', () => {
        const items = [{ id: 'a', title: 'Design reviews' }, { id: 'b', title: 'Launch' }];
        expect(entityReorderPreview({ anchorId: 'b', placement: 'before' }, items, 'horizontal').verb)
            .toMatch(/^entityDragDrop\.preview\.moveBefore\(/);
        expect(entityReorderPreview({ anchorId: 'b', placement: 'after' }, items, 'horizontal').verb)
            .toMatch(/^entityDragDrop\.preview\.moveAfter\(/);
        expect(entityReorderPreview({ anchorId: 'b', placement: 'before' }, items).verb).toMatch(/^entityDragDrop\.preview\.moveAbove\(/);
        expect(entityReorderPreview({ anchorId: 'b', placement: 'after' }, items, 'vertical').verb).toMatch(/^entityDragDrop\.preview\.moveBelow\(/);
    });

    it('revalidates added membership and removed sources at release', async () => {
        const f = fixture();
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        f.model.ids = ['a', 'inserted', 'b', 'c'];
        await screen.update(f.render());
        await measureRows(screen, f.model.ids);
        await key(screen, 'a', 'Enter');
        expect(f.model.writes).toEqual([{ scope, sourceId: 'a', position: { anchorId: 'b', placement: 'after' } }]);
        expect(resolveAnchoredListMoveV1(f.model.ids, 'a', f.model.writes[0]!.position)).toEqual(['inserted', 'b', 'a', 'c']);
        f.model.writes.length = 0;
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        f.model.ids = ['inserted', 'b', 'c'];
        await screen.update(f.render());
        expect(await runtime.release()).toBeNull();
        expect(f.model.writes).toEqual([]);
    });

    it('retires an Account-scoped staged move before another Account can answer', async () => {
        const f = fixture();
        const screen = await mount(f);
        await key(screen, 'a', ' ');
        await key(screen, 'a', 'ArrowDown');
        f.model.scope = { ...scope, accountId: 'account-b' };
        await screen.update(f.render());
        expect(await runtime.release()).toBeNull();
        expect(f.model.writes).toEqual([]);
    });
});
