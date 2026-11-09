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

it('hands the item what the menu hung from, so a surface the item opens hangs from the same trigger', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    try {
        await act(async () => {
            root.render(<DropdownMenu open onOpenChange={() => {}} onSelect={onSelect}
                trigger={<button data-testid="menu-trigger">More</button>}
                items={[{ id: 'share', title: 'Share', testID: 'menu-share' }]} />);
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="menu-share"]')).not.toBeNull());
        await act(async () => {
            document.querySelector<HTMLElement>('[data-testid="menu-share"]')!.click();
        });
        await vi.waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
        const [id, selection] = onSelect.mock.calls[0]!;
        expect(id).toBe('share');
        expect(selection.anchor.kind).toBe('view');
        expect((selection.anchor.ref.current as HTMLElement).contains(document.querySelector('[data-testid="menu-trigger"]'))).toBe(true);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
