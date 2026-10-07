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

import { BaseModal } from '@/modal/components/BaseModal';
import { DropdownMenu } from './DropdownMenu';

it('selects a portaled dropdown option inside BaseModal without dismissing the modal', async () => {
    const close = vi.fn();
    function Harness() {
        const [open, setOpen] = React.useState(false);
        const [selected, setSelected] = React.useState<string | null>(null);
        return <BaseModal visible onClose={close}>
            <DropdownMenu open={open} onOpenChange={setOpen} selectedId={selected} onSelect={setSelected}
                items={[{ id: 'session-a', title: 'Session A', testID: 'session-option' }]}
                trigger={({ toggle }) => <button data-testid="choose" onClick={toggle}>Choose</button>} />
            <output data-testid="selection">{selected}</output>
        </BaseModal>;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    try {
        await act(async () => { root.render(<Harness />); });
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="choose"]')!.click(); });
        const option = document.querySelector<HTMLElement>('[data-testid="session-option"]');
        expect(option).not.toBeNull();
        expect(option!.closest('[data-happy-modal-portal-host]')).not.toBeNull();
        await act(async () => {
            option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            option!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            option!.click();
        });
        expect(document.querySelector('[data-testid="selection"]')?.textContent).toBe('session-a');
        expect(document.querySelector('[data-testid="session-option"]')).toBeNull();
        expect(close).not.toHaveBeenCalled();
    } finally {
        await act(async () => { root.unmount(); });
        measure.mockRestore();
        container.remove();
    }
});
