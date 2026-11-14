// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Pressable, Text } from 'react-native';
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

describe('Item independent outside controls on web', () => {
    it.each([false, true])('keeps More reachable when primary disabled=%s', async (disabled) => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        mounted = { root, container };
        const select = vi.fn();
        const more = vi.fn();
        await act(async () => root.render(<Item title="Browser profile" onPress={select} disabled={disabled}
            rightElementOutsidePressable showChevron={false}
            rightElement={<Pressable accessibilityRole="button" accessibilityLabel="More" onPress={more}>
                <Text>More</Text>
            </Pressable>}
        />));
        const accessory = container.querySelector<HTMLElement>('[aria-label="More"]')!;
        expect(accessory).not.toBeNull();
        // JSDOM does not hit-test: check the effective pointer admission before
        // dispatching the real RN Web click, rather than bypassing an inert ancestor.
        expect(window.getComputedStyle(accessory).pointerEvents).not.toBe('none');
        expect(accessory.closest('[aria-hidden="true"]')).toBeNull();
        await act(async () => accessory.click());
        expect(more).toHaveBeenCalledTimes(1);
        expect(select).not.toHaveBeenCalled();
        const primary = container.querySelector<HTMLButtonElement>('[aria-label="Browser profile"]')!;
        await act(async () => primary.click());
        expect(select).toHaveBeenCalledTimes(disabled ? 0 : 1);
    });
});
