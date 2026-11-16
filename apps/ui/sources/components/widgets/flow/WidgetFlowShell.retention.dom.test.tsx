/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        // Window geometry is the system boundary; widget shells and placement stay real.
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        Dimensions: {
            get: () => ({ ...viewport, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove: () => {} }),
        },
    }),
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { WidgetFlowShell } = await import('./WidgetFlowShell');
const { WidgetAddPanel, WidgetAddSurface } = await import('../add/WidgetAddSurface');
const { WidgetSetupPopover } = await import('../add/WidgetSetupPopover');
const { View } = await import('react-native');

it('keeps the open widget flow draft and pending operation across desktop and phone shells, then retires on close', async () => {
    vi.useFakeTimers();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'widget-trigger' ? new DOMRect(100, 200, 160, 40) : new DOMRect(0, 0, 360, 300);
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Draft() {
        const [pending, setPending] = React.useState(false);
        return <div data-testid="widget-draft" data-pending={String(pending)}>
            <input data-testid="widget-title" defaultValue="" />
            <button onClick={() => setPending(true)}>Save</button>
        </div>;
    }
    function Harness(props: Readonly<{ open: boolean }>) {
        const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
        return <>
            <View ref={anchor} testID="widget-trigger" />
            {props.open ? <WidgetFlowShell anchorRef={anchor} title="Save widget" onRequestClose={() => {}} testID="widget-flow">
                <Draft />
            </WidgetFlowShell> : null}
        </>;
    }
    const input = () => document.querySelector<HTMLInputElement>('[data-testid="widget-title"]');
    const render = async (width: number, open = true) => {
        viewport.width = width;
        viewport.height = width === 390 ? 844 : 1000;
        await act(async () => { root.render(<Harness open={open} />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    };
    try {
        await render(1440);
        const original = input();
        expect(original).not.toBeNull();
        original!.value = 'My unsaved widget';
        await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="widget-draft"] button')!.click(); });
        for (const width of [390, 1440]) {
            await render(width);
            expect(input()).toBe(original);
            expect(input()!.value).toBe('My unsaved widget');
            expect(document.querySelector<HTMLElement>('[data-testid="widget-draft"]')!.dataset.pending).toBe('true');
        }
        await render(1440, false);
        expect(input()).toBeNull();
        await render(1440);
        expect(input()).not.toBe(original);
        expect(input()!.value).toBe('');
    } finally {
        await act(async () => root.unmount());
        container.remove();
        measure.mockRestore();
        vi.useRealTimers();
    }
});

it.each(['surface', 'panel'] as const)('keeps the selected widget draft through the Add %s responsive transition', async presentation => {
    vi.useFakeTimers();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 960, 624));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Preview() { return <input data-testid="add-preview-draft" defaultValue="" />; }
    const sections = [{ id: 'custom', title: 'Custom', entries: [{
        id: 'note', title: 'Note', icon: 'note' as const, onPick: () => {}, renderPreview: () => <Preview />,
    }] }];
    function Harness() {
        const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
        const props = { title: 'Add widgets', searchPlaceholder: 'Search', addLabel: 'Add', sections,
            initialEntryId: 'note', onRequestClose: () => {}, testID: 'widget-add' };
        return <>
            <View ref={anchor} />
            {presentation === 'surface' ? <WidgetAddSurface {...props} open anchorRef={anchor} />
                : <WidgetAddPanel {...props} composition={viewport.width === 390 ? 'push' : 'split'} phone={viewport.width === 390} />}
        </>;
    }
    const input = () => document.querySelector<HTMLInputElement>('[data-testid="add-preview-draft"]');
    const render = async (width: number) => {
        viewport.width = width;
        viewport.height = width === 390 ? 844 : 1000;
        await act(async () => { root.render(<Harness />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    };
    try {
        await render(1440);
        const original = input();
        expect(original).not.toBeNull();
        original!.value = 'Unsubmitted preview';
        for (const width of [390, 1440]) {
            await render(width);
            expect(input()).toBe(original);
            expect(input()!.value).toBe('Unsubmitted preview');
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
        measure.mockRestore();
        vi.useRealTimers();
    }
});


it.each(['edit', 'pane', 'surface'] as const)('keeps the %s setup preview mounted across phone composition', async presentation => {
    vi.useFakeTimers();
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 960, 624));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Preview() { return <input data-testid="setup-preview-draft" defaultValue="" />; }
    const setup: import('../add/widgetSetupModel').WidgetSetup = {
        title: 'Setup', submitLabel: 'Save', fields: [], initial: { bindings: {} },
        resolve: () => ({ status: 'ready', input: {} }),
        submit: async () => ({ ok: true }), renderPreview: () => <Preview />,
    };
    function Harness() {
        const anchor = React.useRef<React.ComponentRef<typeof View>>(null);
        return <><View ref={anchor} />{presentation === 'edit'
            ? <WidgetSetupPopover open anchorRef={anchor} setup={() => setup} onRequestClose={() => {}} testID="setup" />
            : presentation === 'surface' ? <WidgetAddSurface open anchorRef={anchor} title="Add" searchPlaceholder="Search" addLabel="Add" initialEntryId="note"
                sections={[{ id: 'custom', title: 'Custom', entries: [{ id: 'note', title: 'Note', icon: 'note', setup: () => setup }] }]}
                onRequestClose={() => {}} testID="setup" />
            : <WidgetAddPanel title="Add" searchPlaceholder="Search" addLabel="Add" initialEntryId="note"
                sections={[{ id: 'custom', title: 'Custom', entries: [{ id: 'note', title: 'Note', icon: 'note', setup: () => setup }] }]}
                composition={viewport.width === 390 ? 'push' : 'split'} phone={viewport.width === 390}
                onRequestClose={() => {}} testID="setup" />}</>;
    }
    const input = () => document.querySelector<HTMLInputElement>('[data-testid="setup-preview-draft"]');
    const render = async (width: number) => {
        viewport.width = width;
        viewport.height = width === 390 ? 844 : 1000;
        await act(async () => { root.render(<Harness />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    };
    try {
        await render(1440);
        const original = input();
        expect(original).not.toBeNull();
        original!.value = 'Preview state';
        for (const width of [390, 1440]) {
            await render(width);
            expect(input()).toBe(original);
            expect(input()!.value).toBe('Preview state');
        }
    } finally {
        await act(async () => root.unmount());
        container.remove(); measure.mockRestore(); vi.useRealTimers();
    }
});
