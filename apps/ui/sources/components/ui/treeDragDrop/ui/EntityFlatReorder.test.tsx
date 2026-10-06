// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform, StyleSheet, Text, type ScrollView } from 'react-native';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, TodoReorderInputV1Schema,
    type TodoReorderInputV1 } from '@happier-dev/protocol';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useEntityDragDropRuntime } from '../entityDragDropHooks';
import type { EntityDragDropRuntime } from '../entityDragDropTypes';
import { EntityFlatReorderList, EntityFlatReorderRow, settleEntityReorderWrite, type EntityFlatReorderBinding } from './EntityFlatReorder';
import { EntityDragGripTrigger, EntityStagedMoveDock } from './EntityReleasePreview';

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
function RuntimeProbe() { runtime = useEntityDragDropRuntime(); return null; }

function fixture(scrollRef?: React.RefObject<ScrollView | null>) {
    const model = { ids: ['a', 'b', 'c'], scope, writes: [] as TodoReorderInputV1[] };
    const binding = (): EntityFlatReorderBinding => ({
        scope: model.scope, kind: 'todo', items: model.ids.map(id => ({ id, title: id })),
        getItem: id => model.ids.includes(id) ? { kind: 'todo', scope: model.scope, todoId: id } : null,
        getSourceId: item => item.kind === 'todo' ? item.todoId : null,
        resolve: (sourceId, position) => {
            const next = resolveAnchoredListMoveV1(model.ids, sourceId, position);
            if (!next || next.every((id, offset) => id === model.ids[offset])) {
                return { status: 'refused', reason: { code: 'stale_or_noop', message: 'Unavailable' } };
            }
            return { status: 'allowed', effect: { actionId: 'todos.reorder',
                input: { scope: model.scope, sourceId, position: { ...position } },
                preview: { glyph: position.placement === 'before' ? 'above' : 'below', verb: 'Move', target: position.anchorId ?? 'List edge' } } };
        },
        // The fixture's external receiving boundary captures portable effects. Runtime, schema,
        // geometry, source/target lifecycle and gesture adapters above it remain real.
        execute: async effect => {
            model.writes.push(TodoReorderInputV1Schema.parse(effect.input));
            return { status: 'applied' };
        },
    });
    const render = () => <><RuntimeProbe /><EntityFlatReorderList binding={binding()} testID="list" initialOrganizing scrollRef={scrollRef}>
        {model.ids.map(id => <EntityFlatReorderRow key={id} id={id}>
            {({ renderHandle }) => <>{renderHandle(`grip:${id}`)}<Text>{id}</Text></>}
        </EntityFlatReorderRow>)}
    </EntityFlatReorderList></>;
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

    it('autoscrolls the actual RN Web scrollable node using its viewport and current metrics', async () => {
        const scrollNode = document.createElement('div');
        Object.defineProperty(scrollNode, 'scrollHeight', { value: 1000 });
        scrollNode.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
        // A genuine RN Web ScrollView exposes this OS adapter rather than DOM metrics itself.
        const scrollRef = { current: {
            getScrollableNode: () => scrollNode,
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        } } as unknown as React.RefObject<ScrollView | null>;
        const f = fixture(scrollRef);
        const screen = await mount(f);
        const pan = gesture(screen, 'a');
        await act(async () => { pan.__handlers.onStart!({ absoluteX: 10, absoluteY: 10 }); });
        await act(async () => { pan.__handlers.onUpdate!({ absoluteX: 10, absoluteY: 90 }); });
        await screen.update(f.render());
        expect(scrollNode.scrollTop).toBeGreaterThan(0);
        expect(f.model.writes).toEqual([]);
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
        expect(f.model.writes[0]).toMatchObject({ scope, sourceId: 'a', position: { anchorId: 'b', placement: 'after' } });
        expect(AnchoredListPositionV1Schema.safeParse(f.model.writes[0]!.position).success).toBe(true);
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
