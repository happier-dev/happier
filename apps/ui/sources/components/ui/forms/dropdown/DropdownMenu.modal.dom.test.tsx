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
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
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
import { ModalProvider } from '@/modal/ModalProvider';
import { Modal } from '@/modal/ModalManager';
import type { CustomModalInjectedProps } from '@/modal/types';
import { DropdownMenu } from './DropdownMenu';
import { Dimensions } from 'react-native';

it('settles controlled card selection while its dependent picker follows the selected value', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const errors: unknown[] = [];
    const root = createRoot(container, { onUncaughtError: (error) => { errors.push(error); } });
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 400, 300, 44));
    type Field = 'scope' | 'project';
    const item = (field: Field) => ({ id: field, title: field, testID: `controlled-${field}-option` });
    type Selection = { scope: string; project: string };
    function Picker(props: CustomModalInjectedProps & { value: Selection }) {
        return <output data-testid="controlled-picker-value">{props.value.project}</output>;
    }
    function DependentPicker({ value }: { value: Selection }) {
        const id = React.useRef<string | null>(null);
        // Like the connected-account chooser, an open picker follows the parent's
        // controlled value, including an equivalent object from a later render.
        React.useEffect(() => {
            if (!value.project) return;
            if (id.current) Modal.update(id.current, { value });
            else id.current = Modal.show({ component: Picker, props: { value }, chrome: { kind: 'card', title: 'Selected project' } });
        }, [value]);
        return null;
    }
    function Sheet({ setChrome }: CustomModalInjectedProps) {
        const [values, setValues] = React.useState({ scope: '', project: '' });
        const [openField, setOpenField] = React.useState<string | null>(null);
        const choose = (field: Field, id: string) => {
            setValues((current) => ({ ...current, [field]: id }));
        };
        React.useEffect(() => {
            setChrome?.({ kind: 'card', title: 'Link project', footer: <button disabled={!values.project}>Inspect</button> });
        });
        return <>{(['scope', 'project'] as const).map((field) => (
            (field === 'scope' || values.scope) ?
                <DropdownMenu key={field} open={openField === field} selectedId={values[field]}
                    onOpenChange={(open) => setOpenField(open ? field : null)}
                    onSelect={(id) => choose(field, id)}
                    items={[item(field)]}
                    itemTrigger={{ title: field, itemProps: { testID: `controlled-${field}-trigger` } }} /> : null
        ))}<output data-testid="controlled-values">{JSON.stringify(values)}</output>
            <DependentPicker value={{ ...values }} />
        </>;
    }
    try {
        await act(async () => { root.render(<ModalProvider><button data-testid="open-controlled-sheet" onClick={() => Modal.show({ component: Sheet, chrome: {
                kind: 'card', title: 'Link project', scrollHost: 'bounded', bodyScroll: 'auto',
                dimensions: { width: 640, maxHeightRatio: 0.9, size: 'md' },
            } })}>Link project</button></ModalProvider>); });
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="open-controlled-sheet"]')!.click(); });
        for (const field of ['scope', 'project']) {
            await act(async () => { document.querySelector<HTMLElement>(`[data-testid="controlled-${field}-trigger"]`)!.click(); });
            await vi.waitFor(() => expect(document.querySelector(`[data-testid="controlled-${field}-option"]`)).not.toBeNull());
            const option = document.querySelector<HTMLElement>(`[data-testid="controlled-${field}-option"]`)!;
            await act(async () => { option.focus(); option.click(); });
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(errors).toEqual([]);
                expect(document.querySelector('[data-testid="controlled-values"]')?.textContent).toContain(`"${field}":"${field}"`);
            });
            expect(document.querySelector(`[data-testid="controlled-${field}-option"]`)).toBeNull();
        }
        expect(document.querySelector('[data-testid="controlled-picker-value"]')?.textContent).toBe('project');
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('keeps a phone submenu open when its opening touch retargets the compatibility click onto the sheet', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 760, 350, 44));
    function Harness() {
        const [open, setOpen] = React.useState(false);
        const [selected, setSelected] = React.useState('');
        return <><DropdownMenu open={open} onOpenChange={setOpen} onSelect={setSelected}
            popoverPhonePresentation="sheet" popoverAccessibilityLabel="Folder"
            items={[{ id: 'move', title: 'Move', testID: 'touch-move-parent', submenu: {
                title: 'Move folder to', items: [{ id: 'destination', title: 'Destination', testID: 'touch-move-destination' }],
            } }]}
            trigger={({ toggle }) => <button data-testid="touch-move-trigger" onClick={toggle}>Options</button>} />
            <output data-testid="touch-move-selection">{selected}</output></>;
    }
    try {
        await act(async () => { root.render(<Harness />); });
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="touch-move-trigger"]')!.click(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="touch-move-parent"]')).not.toBeNull());
        const parentSheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Folder"]')!;
        await act(async () => {
            document.querySelector<HTMLElement>('[data-testid="touch-move-parent"]')!
                .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        });
        expect(document.querySelector('[data-testid="touch-move-destination"]')).not.toBeNull();
        // Native Chromium touch trace: compatibility mousedown opens the new sheet, then the
        // release/click targets its viewport shell instead of the now-covered parent row.
        await act(async () => {
            parentSheet.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            parentSheet.click();
        });
        expect(document.querySelector('[data-testid="touch-move-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('[data-testid="touch-move-destination"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="touch-move-selection"]')?.textContent).toBe('');
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="touch-move-destination"]')!.click(); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(document.querySelector('[data-testid="touch-move-selection"]')?.textContent).toBe('destination');
            expect(document.querySelector('[data-testid="touch-move-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
        });
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        dimensions.mockRestore();
        container.remove();
    }
});

it.each(['keyboard', 'pointer', 'create'] as const)('returns focus to the trigger after %s selection', async (input) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    function Harness() {
        const [open, setOpen] = React.useState(false);
        const [selected, setSelected] = React.useState('');
        return <><DropdownMenu open={open} search={input !== 'pointer'} onOpenChange={setOpen} onSelect={setSelected} onCreateItem={setSelected}
            items={[{ id: 'choice', title: 'Choice', testID: 'return-focus-option' }]}
            trigger={({ toggle }) => <button data-testid="return-focus-trigger" onClick={toggle}>Choose</button>} />
            <output data-testid="return-focus-selection">{selected}</output></>;
    }
    try {
        await act(async () => { root.render(<Harness />); });
        const trigger = document.querySelector<HTMLElement>('[data-testid="return-focus-trigger"]')!;
        trigger.focus();
        await act(async () => { trigger.click(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="return-focus-option"]')).not.toBeNull());
        const optionSelector = input === 'create' ? '[data-testid="dropdown-option-__create__"]' : '[data-testid="return-focus-option"]';
        if (input === 'create') {
            await act(async () => {
                const search = document.querySelector<HTMLInputElement>('input')!;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'new-choice');
                search.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'new-choice', inputType: 'insertText' }));
            });
            await vi.waitFor(() => expect(document.querySelector(optionSelector)).not.toBeNull());
        }
        const option = document.querySelector<HTMLElement>(optionSelector)!;
        await act(async () => {
            if (input !== 'pointer') {
                const search = document.querySelector<HTMLInputElement>('input')!;
                search.focus();
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            } else {
                option.focus();
                option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
                option.click();
            }
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(document.querySelector('[data-testid="return-focus-selection"]')?.textContent).toBe(input === 'create' ? 'new-choice' : 'choice');
        });
        expect(document.querySelector(optionSelector)).toBeNull();
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it.each(['pane', 'modal'] as const)('keeps focus at the %s opened by the selected item', async (destination) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    function Pane() {
        const titleRef = React.useRef<HTMLHeadingElement>(null);
        React.useLayoutEffect(() => { titleRef.current?.focus(); }, []);
        return <h2 ref={titleRef} tabIndex={-1} data-testid="selection-destination">Details</h2>;
    }
    function Harness() {
        const [open, setOpen] = React.useState(false);
        const [selected, setSelected] = React.useState(false);
        return <><DropdownMenu open={open} onOpenChange={setOpen} onSelect={() => setSelected(true)}
            items={[{ id: 'open', title: 'Open', testID: 'destination-option' }]}
            trigger={({ toggle }) => <button data-testid="destination-trigger" onClick={toggle}>Choose</button>} />
            {selected && (destination === 'pane' ? <Pane /> :
                <BaseModal visible onClose={() => setSelected(false)}>
                    <input autoFocus data-testid="selection-destination" />
                </BaseModal>)}</>;
    }
    try {
        await act(async () => { root.render(<Harness />); });
        const trigger = document.querySelector<HTMLElement>('[data-testid="destination-trigger"]')!;
        trigger.focus();
        await act(async () => { trigger.click(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="destination-option"]')).not.toBeNull());
        await act(async () => {
            const option = document.querySelector<HTMLElement>('[data-testid="destination-option"]')!;
            option.focus();
            option.click();
        });
        await vi.waitFor(async () => {
            await act(async () => {});
            const target = document.querySelector('[data-testid="selection-destination"]');
            expect(target).not.toBeNull();
            expect(document.activeElement).toBe(target);
        });
        expect(document.querySelector('[data-testid="destination-option"]')).toBeNull();
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('opens the Item trigger with Enter and Space and closes with Escape without selecting', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    function Harness() {
        const [open, setOpen] = React.useState(false);
        return <DropdownMenu open={open} search onOpenChange={setOpen} onSelect={onSelect}
            items={[{ id: 'default', title: 'Default manifest', testID: 'keyboard-manifest-option' }]}
            itemTrigger={{ title: 'Manifest', itemProps: { testID: 'keyboard-manifest-trigger' } }} />;
    }
    try {
        await act(async () => { root.render(<Harness />); });
        const trigger = document.querySelector<HTMLElement>('[data-testid="keyboard-manifest-trigger"]')!;
        expect(trigger).not.toBeNull();
        for (const key of ['Enter', ' ']) {
            trigger.focus();
            await act(async () => {
                trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                trigger.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
            });
            await vi.waitFor(() => expect(document.querySelector('[data-testid="keyboard-manifest-option"]')).not.toBeNull());
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            const search = document.querySelector<HTMLInputElement>('input')!;
            expect(search).not.toBeNull();
            await act(async () => {
                search.focus();
                search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            });
            expect(document.querySelector('[data-testid="keyboard-manifest-option"]')).toBeNull();
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(document.activeElement).toBe(trigger);
            expect(onSelect).not.toHaveBeenCalled();
        }
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('keeps focus on a discovery operation while its models arrive in an open searchable menu', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    function Harness() {
        const [discovered, setDiscovered] = React.useState(false);
        return <DropdownMenu open search closeOnSelect={false} onOpenChange={() => {}} selectedId="alpha"
            onSelect={() => setDiscovered(true)}
            items={[
                ...(discovered ? [{ id: 'arriving', title: 'Arriving model', testID: 'arriving-model-option' }] : []),
                { id: 'alpha', title: 'Alpha' },
                { id: 'discover', title: 'Find models', testID: 'persistent-discovery-option',
                    rightElement: discovered ? <span>Loading</span> : undefined },
            ]}
            trigger={() => <button>Choose</button>} />;
    }
    try {
        await act(async () => root.render(<Harness />));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="persistent-discovery-option"]')).not.toBeNull());
        const operation = document.querySelector<HTMLElement>('[data-testid="persistent-discovery-option"]')!;
        await act(async () => {
            operation.focus();
            operation.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        });
        await act(async () => {
            operation.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
            operation.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            operation.click();
        });
        expect(document.querySelector('[data-testid="arriving-model-option"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="persistent-discovery-option"]')).toBe(operation);
        expect(document.activeElement).toBe(operation);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it.each([false, true])('keeps keyboard focus on the selected row or search field (search=%s)', async (search) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 200, height: 40, top: 100, left: 100, right: 300, bottom: 140, toJSON: () => ({}),
    });
    try {
        await act(async () => { root.render(<DropdownMenu open search={search} onOpenChange={() => {}} onSelect={() => {}}
            items={[{ id: 'alpha', title: 'Alpha', testID: 'focus-alpha' },
                { id: 'disabled', title: 'Unavailable', disabled: true },
                { id: 'beta', title: 'Beta', testID: 'focus-beta' }]}
            trigger={() => <button>Choose</button>} />); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="focus-alpha"]')).not.toBeNull());
        const source = search ? document.querySelector<HTMLInputElement>('input')! : document.querySelector<HTMLElement>('[data-testid="focus-alpha"]')!;
        await act(async () => { source.focus(); });
        await act(async () => { source.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
        expect(document.activeElement).toBe(search ? source : document.querySelector('[data-testid="focus-beta"]'));
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

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
