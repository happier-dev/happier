// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Pressable } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Construct the real module graph during collection, not inside the row interaction budget.
const { SelectableRow } = await import('./SelectableRow');

describe('SelectableRow (disabled children)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('keeps the row disabled while allowing its nested action', async () => {
        const onRowPress = vi.fn();
        const onInnerPress = vi.fn();

        await act(async () => root.render(
            <SelectableRow
                testID="selectable-row"
                title="Row"
                disabled={true}
                allowChildInteractionWhenDisabled={true}
                onPress={onRowPress}
                right={<Pressable testID="selectable-row-inner" onPress={onInnerPress} />}
            />,
        ));

        const row = container.querySelector<HTMLElement>('[data-testid="selectable-row"]');
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        const inner = container.querySelector<HTMLElement>('[data-testid="selectable-row-inner"]');
        expect(inner).not.toBeNull();
        await act(async () => inner?.click());
        expect(onInnerPress).toHaveBeenCalledOnce();
        expect(onRowPress).not.toHaveBeenCalled();
    });

    it('disables the activation target by default', async () => {
        const onRowPress = vi.fn();
        await act(async () => root.render(
            <SelectableRow testID="disabled-row" title="Row" disabled onPress={onRowPress} />,
        ));
        const row = container.querySelector<HTMLElement>('[data-testid="disabled-row"]');
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        await act(async () => row?.click());
        expect(onRowPress).not.toHaveBeenCalled();
    });
});
