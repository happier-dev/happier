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

describe('SelectableRow (control semantics)', () => {
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

    it('preserves focus on an ActionListSection disclosure as its controlled content opens and closes', async () => {
        const { ActionListSection } = await import('./ActionListSection');
        function Disclosure() {
            const [expanded, setExpanded] = React.useState(false);
            return <ActionListSection actions={[{
                id: 'more',
                testID: 'disclosure',
                label: 'Signed-out accounts',
                expanded,
                controls: 'signed-out',
                onPress: () => setExpanded(value => !value),
            }]} />;
        }

        await act(async () => root.render(<Disclosure />));
        const button = container.querySelector<HTMLElement>('[data-testid="disclosure"]')!;
        await act(async () => button.focus());
        expect(button.getAttribute('role')).toBe('button');
        expect.soft(button.getAttribute('aria-expanded')).toBe('false');
        expect.soft(button.getAttribute('aria-controls')).toBe('signed-out');
        await act(async () => button.click());
        expect.soft(button.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(button);
        await act(async () => button.click());
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(button);
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
