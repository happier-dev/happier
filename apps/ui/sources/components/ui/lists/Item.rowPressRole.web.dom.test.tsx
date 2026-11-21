// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Item } from './Item';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@hugeicons/react-native', () => ({ HugeiconsIcon: () => null }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mounted: { root: Root; container: HTMLDivElement } | undefined;
afterEach(async () => {
    if (!mounted) return;
    await act(async () => mounted?.root.unmount());
    mounted.container.remove();
    mounted = undefined;
});

describe('Item row press target on web', () => {
    async function mount(node: React.ReactElement) {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        mounted = { root, container };
        await act(async () => root.render(node));
        return container;
    }

    it('is a named button when its accessory inside the press only draws (meters, a count)', async () => {
        const open = vi.fn();
        const container = await mount(<Item testID="row" title="we-are@happier.dev" subtitle="Subscription" onPress={open}
            rightElement={<Text>86%</Text>} rightElementPassive />);
        const row = container.querySelector<HTMLElement>('[data-testid="row"]')!;
        expect(row.getAttribute('role')).toBe('button');
        // Name and kind stay separate words, never "we-are@happier.devSubscription".
        expect(row.getAttribute('aria-label')).toBe('we-are@happier.dev. Subscription');
        await act(async () => row.click());
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('keeps a caller-supplied name', async () => {
        const container = await mount(<Item testID="row" title="ChatGPT" onPress={() => {}} accessibilityLabel="ChatGPT, 3 accounts"
            rightElement={<Text>3</Text>} rightElementPassive />);
        expect(container.querySelector('[data-testid="row"]')!.getAttribute('aria-label')).toBe('ChatGPT, 3 accounts');
        expect(container.querySelector('[data-testid="row"]')!.getAttribute('role')).toBe('button');
    });

    it.each([
        { state: 'enabled', props: {}, activations: 1 },
        { state: 'disabled', props: { disabled: true }, activations: 0 },
        { state: 'loading', props: { loading: true }, activations: 0 },
    ])('activates a focused $state option once per key only when actionable', async ({ props, activations }) => {
        const onPress = vi.fn();
        const container = await mount(
            <Item
                title="Shared model"
                testID="model-option"
                onPress={onPress}
                accessibilityRole="button"
                webRole="option"
                accessibilityLabel="Gateway, Work, Shared model"
                selected
                {...props}
            />,
        );
        const row = container.querySelector<HTMLElement>('[data-testid="model-option"]');
        if (!row) throw new Error('Expected model option Pressable');
        expect(row.getAttribute('role')).toBe('option');
        expect(row.getAttribute('aria-label')).toBe('Gateway, Work, Shared model');
        expect(row.getAttribute('aria-selected')).toBe('true');
        expect(row.tabIndex).toBe(activations ? 0 : -1);
        await act(async () => row.focus());
        expect(document.activeElement).toBe(row);

        for (const key of ['Enter', ' ']) {
            onPress.mockClear();
            await act(async () => {
                row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                row.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
            });
            expect(onPress, key === ' ' ? 'Space' : key).toHaveBeenCalledTimes(activations);
        }
    });
});
