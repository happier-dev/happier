/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Use real RNW pressables and real modal/menu/selection owners; only native
// styling, keyboard, and CJS platform adapters cross the test boundary.
vi.mock('react-native', async () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsRealModule();
});
vi.mock('@/utils/web/reactDomCjs', async () => {
    const dom = await import('react-dom');
    return { requireReactDOM: () => dom };
});
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('div', props),
}));

import { DropdownMenu } from './DropdownMenu';

it('opens a submenu from the keyboard and returns to its parent, moving sideways through a swatch row', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const press = async (key: string) => {
        const target = (document.activeElement as HTMLElement | null) ?? document.body;
        await act(async () => {
            target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
    };
    try {
        await act(async () => {
            root.render(<DropdownMenu open onOpenChange={() => {}} onSelect={onSelect} trigger={null} items={[
                { id: 'color', title: 'Set color', testID: 'kb-color', submenu: { items: [
                    { id: 'color:blue', title: 'Blue', testID: 'kb-blue', checked: false, swatch: { color: '#0000FF', group: 'presets' } },
                    { id: 'color:red', title: 'Red', testID: 'kb-red', checked: false, swatch: { color: '#FF0000', group: 'presets' } },
                ] } },
                { id: 'rename', title: 'Rename', testID: 'kb-rename' },
            ]} />);
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="kb-color"]')).not.toBeNull());
        await act(async () => {
            const row = document.querySelector<HTMLElement>('[data-testid="kb-color:scroll-frame"]')!;
            (row.querySelector<HTMLElement>('[tabindex]') ?? row).focus();
        });

        await press('ArrowRight');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="kb-blue"]')).not.toBeNull());
        await act(async () => {
            const blue = document.querySelector<HTMLElement>('[data-testid="kb-blue"]')!;
            blue.focus();
        });
        await press('ArrowRight');
        await vi.waitFor(() => expect(document.activeElement?.closest('[data-testid="kb-red:scroll-frame"]')).not.toBeNull());
        await press('ArrowLeft');
        await press('ArrowLeft');
        await vi.waitFor(() => expect(document.querySelector('[data-testid="kb-blue"]')).toBeNull());
        expect(document.querySelector('[data-testid="kb-rename"]')).not.toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
