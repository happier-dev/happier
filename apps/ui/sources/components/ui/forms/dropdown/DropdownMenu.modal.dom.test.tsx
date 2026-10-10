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

it('dismisses only the nested dropdown on Escape, then the enclosing sheet on the next Escape', async () => {
    function Harness() {
        const [visible, setVisible] = React.useState(true);
        const [open, setOpen] = React.useState(false);
        return <><output data-testid="sheet-state">{visible ? 'open' : 'closed'}</output>
        <BaseModal visible={visible} placement="bottom" onClose={() => setVisible(false)}>
            <div data-testid="outer-sheet">
                <DropdownMenu open={open} onOpenChange={setOpen} selectedId={null} onSelect={() => {}}
                    items={[{ id: 'small', title: 'Small', testID: 'nested-size-option' }]}
                    trigger={({ toggle }) => <button data-testid="size-trigger" onClick={toggle}>Size</button>} />
            </div>
        </BaseModal></>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    try {
        await act(async () => { root.render(<Harness />); });
        const trigger = document.querySelector<HTMLElement>('[data-testid="size-trigger"]')!;
        trigger.focus();
        await act(async () => { trigger.click(); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
        const option = document.querySelector<HTMLElement>('[data-testid="nested-size-option"]')!;
        expect(option).not.toBeNull();
        option.focus();
        await act(async () => { option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(document.querySelector('[data-testid="nested-size-option"]')).toBeNull();
        expect(document.querySelector('[data-testid="outer-sheet"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="sheet-state"]')?.textContent).toBe('open');
        expect(document.activeElement).toBe(trigger);
        await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(document.querySelector('[data-testid="sheet-state"]')?.textContent).toBe('closed');
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it.each(['arrival', 'typing'] as const)('handles %s before cold asynchronous DropdownMenu results arrive', async (intent) => {
    const search = document.createElement('input');
    const container = document.createElement('div');
    document.body.append(search, container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    const render = (ready: boolean) => <DropdownMenu open onOpenChange={() => {}} selectedId={null} onSelect={() => {}}
        items={ready ? [{ id: 'disabled', title: 'Unavailable session', disabled: true },
            { id: 'session-a', title: 'Session A', testID: 'cold-session-option' }] : []}
        trigger={() => <button>Choose</button>} />;
    try {
        search.focus();
        await act(async () => { root.render(render(false)); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
        expect(document.activeElement).toBe(search);
        if (intent === 'typing') {
            await act(async () => {
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
                search.value = 'Session summaryx';
                search.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'x' }));
            });
        }
        await act(async () => { root.render(render(true)); });
        expect(document.activeElement).toBe(intent === 'typing' ? search : document.querySelector('[data-testid="cold-session-option"]'));
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove(); search.remove();
    }
});

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
        // Opening crosses the real frame/timer boundary after the trigger press.
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(document.querySelector('[data-testid="session-option"]')).not.toBeNull();
        });
        const option = document.querySelector<HTMLElement>('[data-testid="session-option"]');
        expect(option).not.toBeNull();
        expect(option!.closest('[data-happy-modal-portal-host]')).not.toBeNull();
        await act(async () => {
            option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            option!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            option!.click();
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(document.querySelector('[data-testid="selection"]')?.textContent).toBe('session-a');
            expect(document.querySelector('[data-testid="session-option"]')).toBeNull();
        });
        expect(close).not.toHaveBeenCalled();
    } finally {
        await act(async () => { root.unmount(); });
        measure.mockRestore();
        container.remove();
    }
});
