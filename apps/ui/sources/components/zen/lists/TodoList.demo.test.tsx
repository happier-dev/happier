import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import TodoDemoScreen from '@/app/(app)/dev/todo-demo';
import { EntityFlatReorderList } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { Button: 'Button' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

// Outward transport is the boundary: the sample must never reach an Account write.
const serverFetch = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(), serverFetch,
}));

describe('Todo demo shared list', () => {
    it('reorders local samples through the real list runtime without changing Account todos', async () => {
        const accountState = storage.getState().todoState;
        const hook = await renderHook(() => useEntityDragDropRuntime());
        const runtime = hook.getCurrent();
        const screen = await renderScreen(<TodoDemoScreen />);
        for (const title of ['First', 'Second', 'Third']) {
            await act(async () => { screen.findByType('TextInput').props.onChangeText(title); });
            await act(async () => { screen.findAllByType('Button').find(button => button.props.title === 'Add')!.props.onPress(); });
        }
        const binding = screen.findByType(EntityFlatReorderList).props.binding;
        expect(binding.items.map((todo: { title: string }) => todo.title)).toEqual(['Third', 'Second', 'First']);
        const source = binding.items[0].id;
        const anchor = binding.items[2].id;
        await screen.pressByTestIdAsync('zen.todos.organize');
        const detector = screen.findAllByType('GestureDetector').find(node => node.findAll(child => child.props.testID === `zen.todos.${source}.move`).length > 0)!;
        await act(async () => { detector.props.gesture.__handlers.onStart({ absoluteX: 10, absoluteY: 10 }); });
        const sourceId = runtime.getSnapshot().sourceId!;
        const destination = runtime.getDestinations(sourceId).find(entry => entry.admission.status === 'allowed'
            && entry.destination && typeof entry.destination === 'object' && !Array.isArray(entry.destination)
            && 'anchorId' in entry.destination && 'placement' in entry.destination
            && entry.destination.anchorId === anchor && entry.destination.placement === 'after')!;
        expect(destination).toBeDefined();
        await act(async () => { runtime.choose(destination.targetId, destination.destination); await runtime.release(); });
        expect(screen.findByType(EntityFlatReorderList).props.binding.items.map((item: { title: string }) => item.title)).toEqual(['Second', 'First', 'Third']);
        for (const todo of screen.findByType(EntityFlatReorderList).props.binding.items) {
            const row = screen.findByProps({ id: todo.id, value: todo.title, done: false });
            for (let node = row.parent; node && node.type !== EntityFlatReorderList; node = node.parent) {
                const style = Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style) : node.props.style ?? {};
                expect(style).not.toHaveProperty('position', 'absolute');
                expect(style).not.toHaveProperty('transform');
            }
        }
        expect(storage.getState().todoState).toBe(accountState);
        expect(serverFetch).not.toHaveBeenCalled();
    });
});
