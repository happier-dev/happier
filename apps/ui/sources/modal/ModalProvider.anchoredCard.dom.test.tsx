/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from './components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// A desktop window: jsdom lays nothing out, so the window size the app reads is given here.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // The package-name RNW request has a Node shim; its absolute entry is the real DOM boundary.
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
}, text: async () => await vi.importActual('@/text') });
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

// Resolve the real component graph during collection, outside behavior-test deadlines.
const { ModalProvider } = await import('./ModalProvider');
const { Modal } = await import('./ModalManager');
const { useIsInsideModalBoundary } = await import('./context/ModalBoundaryContext');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { HappierPressable } = await import('@happier-dev/plugin-ui/presentation');
const { ChartTooltip } = await import('@/components/ui/charts/ChartTooltip');
const { SelectionListFilterChip } = await import('@/components/ui/selectionList/SelectionListFilterChips');

it('moves DOM focus with headerless listbox roving focus, skipping disabled choices', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<ModalProvider><SelectionListFilterChip filter={{
            id: 'roving', testID: 'roving-chip', label: 'Scope', selectedId: 'a', onChange: () => {},
            options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo', disabled: true }, { id: 'c', label: 'Charlie' }],
        }} /></ModalProvider>));
        const trigger = container.querySelector<HTMLButtonElement>('[data-testid="roving-chip"]')!;
        await act(async () => { trigger.focus(); trigger.click(); });
        const option = (id: string) => document.querySelector<HTMLElement>(`[data-testid="roving-chip:${id}"]`)!;
        await vi.waitFor(() => expect(document.activeElement).toBe(option('a')));
        await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
        expect(document.activeElement).toBe(option('c'));
        expect(option('c').tabIndex).toBe(0);
        expect(option('a').getAttribute('aria-selected')).toBe('true');
        await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
        expect(document.activeElement).toBe(option('a'));
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('keeps a repeated chart mark out of sequential keyboard focus and assistive technology', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<ChartTooltip testID="repeated-mark" keyboard={false} title="North" value="40" accentColor="blue"><span>North</span></ChartTooltip>));
        const trigger = container.querySelector<HTMLElement>('[data-testid="repeated-mark-trigger"]')!;
        expect(trigger.tabIndex).toBe(-1);
        expect(trigger.getAttribute('aria-hidden')).toBe('true');
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it.each(['focus', 'hover'] as const)('dismisses a tooltip on Escape without moving focus (%s)', async input => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<ModalProvider>
            <ChartTooltip testID="escape-tooltip" title="North" value="40" accentColor="blue"
                renderTrigger={interaction => <button data-testid="tooltip-opener"
                    onFocus={() => interaction.onFocusChange(true)} onBlur={() => interaction.onFocusChange(false)}
                    onMouseEnter={() => interaction.onHoverChange(true)} onMouseLeave={() => interaction.onHoverChange(false)}>
                    Inspect North
                </button>}><span>North</span></ChartTooltip>
            <button data-testid="other-control">Other control</button>
        </ModalProvider>));
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="tooltip-opener"]')!;
        const other = container.querySelector<HTMLButtonElement>('[data-testid="other-control"]')!;
        await act(async () => {
            if (input === 'focus') opener.focus();
            else {
                other.focus();
                opener.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            }
        });
        await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
        const focusedBeforeEscape = document.activeElement;
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
        expect(document.activeElement).toBe(focusedBeforeEscape);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('returns an asynchronously admitted prompt to its persistent opener', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let admit!: () => void;
    const admission = new Promise<void>(resolve => { admit = resolve; });
    try {
        await act(async () => root.render(<ModalProvider><HappierPressable testID="async-prompt-opener" accessibilityLabel="New view"
            onPress={async () => { await admission; void Modal.prompt('New view', 'Name the view'); }} /></ModalProvider>));
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="async-prompt-opener"]')!;
        await act(async () => { opener.focus(); opener.click(); });
        await act(async () => admit());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="web-prompt-input"]')).not.toBeNull());
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    } finally {
        admit();
        await act(async () => root.unmount());
        container.remove();
    }
});

it('returns a prompt opened from a transient menu item to the persistent menu trigger', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Harness() {
        const [open, setOpen] = React.useState(false);
        return <ModalProvider><DropdownMenu open={open} onOpenChange={setOpen}
            items={[{ id: 'new', title: 'New view', testID: 'new-view-menu-item' }]} selectedId={null}
            onSelect={() => { void Modal.prompt('New view', 'Name the view'); }}
            trigger={({ toggle }) => <button data-testid="prompt-opener" onClick={toggle}>Views</button>} />
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="prompt-opener"]')!;
        await act(async () => { opener.focus(); opener.click(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="new-view-menu-item"]')).not.toBeNull());
        const item = document.querySelector<HTMLElement>('[data-testid="new-view-menu-item"]')!;
        await act(async () => { item.focus(); item.click(); });
        await vi.waitFor(() => expect(document.querySelector('input')).not.toBeNull());
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

// Connect QA r1109a: a wide/phone transition lost the selected mode and credential draft;
// publishing a late anchor similarly returned the person to Add account's initial state.
it.each(['resize', 'late-anchor'] as const)('keeps modal-local form state when its presentation changes (%s)', async (transition) => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const anchorRef = React.createRef<HTMLButtonElement>();
    let mounts = 0;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 900, y: 40, width: 80, height: 32, top: 40, left: 900, right: 980, bottom: 72, toJSON: () => ({}),
    });
    function Form({ setChrome }: import('./types').CustomModalInjectedProps) {
        const inside = useIsInsideModalBoundary();
        const [mode, setMode] = React.useState('key');
        const [draft, setDraft] = React.useState('');
        React.useEffect(() => { mounts += 1; }, []);
        return <div data-testid="draft-boundary" data-inside={String(inside)}>
            <button data-testid="draft-mode" onClick={() => setMode('json')}>{mode}</button>
            <input data-testid="draft-value" value={draft} onInput={event => setDraft(event.currentTarget.value)} />
            <button data-testid="late-anchor" onClick={() => setChrome?.({
                kind: 'card', anchor: { kind: 'view', ref: anchorRef },
            })}>Publish header anchor</button>
        </div>;
    }
    const resize = async (width: number) => {
        await act(async () => {
            Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
            window.dispatchEvent(new Event('resize'));
        });
    };
    try {
        await act(async () => root.render(<ModalProvider>
            <button ref={anchorRef} data-testid="form-opener" onClick={() => Modal.show({
                component: Form,
                chrome: { kind: 'card', title: 'Connect', phonePresentation: 'sheet',
                    ...(transition === 'resize' ? { anchor: { kind: 'view', ref: anchorRef } as const } : {}) },
            })}>Add account</button>
        </ModalProvider>));
        await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="form-opener"]')!.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="draft-value"]')).not.toBeNull());
        const field = document.querySelector<HTMLInputElement>('[data-testid="draft-value"]')!;
        expect(document.querySelector('[data-testid="draft-boundary"]')!.getAttribute('data-inside')).toBe(String(transition === 'late-anchor'));
        await act(async () => {
            document.querySelector<HTMLButtonElement>('[data-testid="draft-mode"]')!.click();
            field.value = 'dummy unsaved draft';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(field.value).toBe('dummy unsaved draft');
        if (transition === 'resize') await resize(390);
        else await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="late-anchor"]')!.click());
        expect(document.querySelector('[data-testid="draft-value"]')).toBe(field);
        expect(document.querySelector('[data-testid="draft-mode"]')!.textContent).toBe('json');
        expect(field.value).toBe('dummy unsaved draft');
        expect(document.querySelector('[data-testid="draft-boundary"]')!.getAttribute('data-inside')).toBe(String(transition === 'resize'));
        await resize(1440);
        expect(document.querySelector('[data-testid="draft-value"]')).toBe(field);
        expect(mounts).toBe(1);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="draft-value"]')).toBeNull());
        await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="form-opener"]')!.click());
        expect(document.querySelector<HTMLInputElement>('[data-testid="draft-value"]')!.value).toBe('');
        expect(document.querySelector('[data-testid="draft-mode"]')!.textContent).toBe('key');
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('keeps a page-owned body in the newest shell while the outgoing shell is still leaving (E09)', async () => {
    const { useRetainedPlacement } = await import('./components/RetainedModalFrame');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let mounts = 0;
    function Draft() {
        const [draft, setDraft] = React.useState('');
        React.useEffect(() => { mounts += 1; }, []);
        return <input data-testid="page-draft" value={draft} onInput={event => setDraft(event.currentTarget.value)} />;
    }
    function Dialog(props: Readonly<{ body: React.ReactElement }> & import('./types').CustomModalInjectedProps) {
        return props.body;
    }
    const renderDraft = () => <Draft />;
    // The page's shape: its pane column and its phone dialog each present the one body it renders.
    function Page(props: Readonly<{ docked: boolean; paneMounted: boolean }>) {
        const retained = useRetainedPlacement<null>(renderDraft);
        const slot = React.useMemo(() => retained.mount(null), [retained.mount]);
        const dialog = React.useRef<string | null>(null);
        React.useEffect(() => {
            if (props.docked) {
                if (dialog.current !== null) Modal.hide(dialog.current);
                dialog.current = null;
                return;
            }
            dialog.current ??= Modal.show({ component: Dialog, props: { body: slot }, chrome: { kind: 'card', title: 'Settings' } });
        }, [props.docked, slot]);
        return <>{props.paneMounted ? <div data-testid="page-pane">{slot}</div> : null}{retained.body}</>;
    }
    const render = async (docked: boolean, paneMounted: boolean) => {
        await act(async () => root.render(<ModalProvider><Page docked={docked} paneMounted={paneMounted} /></ModalProvider>));
    };
    try {
        await render(true, true);
        const field = document.querySelector<HTMLInputElement>('[data-testid="page-draft"]')!;
        await act(async () => {
            field.value = 'unsubmitted';
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        // The dialog opens while the docked pane is still leaving: the dialog presents the body.
        await render(false, true);
        await vi.waitFor(() => expect(document.querySelector('[data-testid="page-pane"]')!.contains(field)).toBe(false));
        expect(document.body.contains(field)).toBe(true);
        // The pane finishes leaving without taking the body out of the dialog.
        await render(false, false);
        expect(document.querySelector('[data-testid="page-draft"]')).toBe(field);
        expect(field.value).toBe('unsubmitted');
        // Docked again: the pane presents it, and the body was mounted once throughout.
        await render(true, true);
        await vi.waitFor(() => expect(document.querySelector('[data-testid="page-pane"]')!.contains(field)).toBe(true));
        expect(field.value).toBe('unsubmitted');
        expect(mounts).toBe(1);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

// J18 (QA-LAYOUT-1114 F1): a focused field in the retained body keeps focus while the body moves pane → dialog → pane.
it('keeps focus on the retained body\'s focused field as it moves between shells', async () => {
    const { useRetainedPlacement } = await import('./components/RetainedModalFrame');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Dialog(props: Readonly<{ body: React.ReactElement }> & import('./types').CustomModalInjectedProps) {
        return props.body;
    }
    const renderDraft = () => <textarea data-testid="review-result" defaultValue="A reviewed result" />;
    function Page(props: Readonly<{ docked: boolean }>) {
        const retained = useRetainedPlacement<null>(renderDraft);
        const slot = React.useMemo(() => retained.mount(null), [retained.mount]);
        const dialog = React.useRef<string | null>(null);
        React.useEffect(() => {
            if (props.docked) {
                if (dialog.current !== null) Modal.hide(dialog.current);
                dialog.current = null;
                return;
            }
            dialog.current ??= Modal.show({ component: Dialog, props: { body: slot }, chrome: { kind: 'card', title: 'Review' } });
        }, [props.docked, slot]);
        return <>{props.docked ? <div data-testid="page-pane">{slot}</div> : null}{retained.body}</>;
    }
    const render = async (docked: boolean) => {
        await act(async () => root.render(<ModalProvider><Page docked={docked} /></ModalProvider>));
    };
    try {
        await render(true);
        const field = document.querySelector<HTMLTextAreaElement>('[data-testid="review-result"]')!;
        field.focus();
        field.setSelectionRange(2, 10);
        expect(document.activeElement).toBe(field);
        await render(false);
        await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.contains(field)).toBe(true));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.activeElement).toBe(field);
        await render(true);
        await vi.waitFor(() => expect(document.querySelector('[data-testid="page-pane"]')?.contains(field)).toBe(true));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.activeElement).toBe(field);
        expect([field.selectionStart, field.selectionEnd]).toEqual([2, 10]);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it.each([390, 1440].flatMap(width => (['picker', 'confirm'] as const).map(kind => ({ width, kind }))))('keeps a $width px sheet presented while its nested $kind owns input', async ({ width, kind }) => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const dismissed = vi.fn();
    const lifetime = new AbortController();
    let confirmation: Promise<boolean> | undefined;
    function Picker() { return <button data-testid="account-choice">Previous account</button>; }
    function AccountSheet() {
        React.useEffect(() => () => lifetime.abort(), []);
        return <button data-testid="purpose-trigger" onClick={() => {
            if (kind === 'picker') Modal.show({ component: Picker, chrome: { kind: 'card', title: 'GitLab account' } });
            else confirmation = Modal.confirm('Share a machine', 'QA B · Can manage', { signal: lifetime.signal });
        }}>Choose account</button>;
    }
    try {
        await act(async () => root.render(<ModalProvider><div /></ModalProvider>));
        await act(async () => { Modal.show({ component: AccountSheet, onRequestClose: dismissed,
            chrome: { kind: 'card', title: 'Connect GitLab account', anchor: {
                kind: 'rect', rect: { left: 100, top: 100, width: 150, height: 30 },
            } } }); });
        await act(async () => document.querySelector<HTMLElement>('[data-testid="purpose-trigger"]')!.click());
        expect(document.querySelector(kind === 'picker' ? '[data-testid="account-choice"]' : '[data-testid="web-modal-confirm"]')).not.toBeNull();
        expect(dismissed).not.toHaveBeenCalled();
        expect(document.querySelector('[data-testid="purpose-trigger"]')).not.toBeNull();
        expect(lifetime.signal.aborted).toBe(false);
        if (kind === 'confirm') {
            await act(async () => document.querySelector<HTMLElement>('[data-testid="web-modal-confirm"]')!.click());
            expect(await confirmation).toBe(true);
            expect(lifetime.signal.aborted).toBe(false);
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('hangs a card opened with its trigger anchor from that trigger, without a scrim, and closes it on Escape', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 900, y: 40, width: 80, height: 32, top: 40, left: 900, right: 980, bottom: 72, toJSON: () => ({}),
    });
    function ShareBody() {
        return <button data-testid="share-body">Copy link</button>;
    }
    function Harness() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <ModalProvider>
            <button ref={anchorRef} data-testid="share-trigger" onClick={() => Modal.show({
                component: ShareBody,
                chrome: { kind: 'card', title: 'Share Weekly report', phonePresentation: 'sheet', scrollHost: 'bounded',
                    anchor: { kind: 'view', ref: anchorRef } },
            })}>Share</button>
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        await act(async () => document.querySelector('[data-testid="share-trigger"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull());
        const body = document.querySelector<HTMLElement>('[data-testid="share-body"]')!;
        // The card sits in the anchored popover layer, not in a centred modal with its scrim.
        expect(body.closest('[id^="popover-"]')).not.toBeNull();
        expect(document.querySelector('[data-happy-modal-layer]')).toBeNull();
        // Pressing inside the card keeps it open.
        await act(async () => body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
        expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull();
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).toBeNull());
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it.each([390, 1440])('returns an anchored sheet to its persistent trigger after its opening menu unmounts (%i px)', async (width) => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    window.dispatchEvent(new Event('resize'));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function ShareBody() {
        return <button data-testid="share-body">Copy link</button>;
    }
    function Harness() {
        const anchorRef = React.useRef<HTMLDivElement>(null);
        const [menuOpen, setMenuOpen] = React.useState(false);
        return <ModalProvider>
            <div ref={anchorRef}><button data-testid="share-trigger" onClick={() => setMenuOpen(true)}>More</button></div>
            {menuOpen && <button data-testid="share-menu-item" onClick={() => {
                Modal.show({
                    component: ShareBody,
                    chrome: { kind: 'card', title: 'Share Weekly report', phonePresentation: 'sheet',
                        anchor: { kind: 'view', ref: anchorRef } },
                });
                setMenuOpen(false);
            }}>Share</button>}
        </ModalProvider>;
    }
    try {
        await act(async () => root.render(<Harness />));
        const trigger = document.querySelector<HTMLButtonElement>('[data-testid="share-trigger"]')!;
        await act(async () => trigger.click());
        const menuItem = document.querySelector<HTMLButtonElement>('[data-testid="share-menu-item"]')!;
        menuItem.focus();
        await act(async () => menuItem.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).not.toBeNull());
        expect(menuItem.isConnected).toBe(false);
        expect(document.querySelector('[data-testid="share-body"]')!.closest('[id^="popover-"]') !== null).toBe(width === 1440);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share-body"]')).toBeNull());
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('stacks a card hung from a control inside a dialog above that dialog (Connect → Custom endpoint → Add key)', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 600, y: 300, width: 80, height: 32, top: 300, left: 600, right: 680, bottom: 332, toJSON: () => ({}),
    });
    // The highest stacking value on the way from an element to the body: what decides which layer paints on top.
    const layerOf = (element: Element) => {
        let z = 0;
        for (let node: Element | null = element; node; node = node.parentElement) {
            const value = Number((node as HTMLElement).style?.zIndex);
            if (Number.isFinite(value) && value > z) z = value;
        }
        return z;
    };
    function KeySheet() {
        return <button data-testid="key-sheet">Paste a key</button>;
    }
    function ConnectDialog() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <button ref={anchorRef} data-testid="add-key" onClick={() => Modal.show({
            component: KeySheet,
            chrome: { kind: 'card', title: 'Connect', phonePresentation: 'sheet', scrollHost: 'bounded', anchor: { kind: 'view', ref: anchorRef } },
        })}>Add key</button>;
    }
    try {
        // As in the app, the dialogs render under a screen's popover host.
        const { PopoverScope } = await import('@/components/ui/popover/PopoverScope');
        await act(async () => root.render(<PopoverScope><ModalProvider><span /></ModalProvider></PopoverScope>));
        await act(async () => { Modal.show({ component: ConnectDialog, chrome: { kind: 'card', title: 'Connect a provider' } }); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="add-key"]')).not.toBeNull());
        await act(async () => document.querySelector('[data-testid="add-key"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="key-sheet"]')).not.toBeNull());
        const host = layerOf(document.querySelector('[data-testid="add-key"]')!);
        expect(host).toBeGreaterThan(0);
        expect(layerOf(document.querySelector('[data-testid="key-sheet"]')!)).toBeGreaterThan(host);
        // The anchored card draws no scrim of its own, so the dialog under it keeps its scrim over the page.
        expect(document.querySelectorAll('[data-testid="modal-scrim"]')).toHaveLength(1);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});

it('closes a card hung from a control inside a dialog when that dialog closes, and settles its request', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 600, y: 300, width: 80, height: 32, top: 300, left: 600, right: 680, bottom: 332, toJSON: () => ({}),
    });
    const cardDismissed = vi.fn();
    let hostId: string | null = null;
    function KeySheet() {
        return <button data-testid="key-sheet-2">Paste a key</button>;
    }
    function ConnectDialog() {
        const anchorRef = React.useRef<HTMLButtonElement>(null);
        return <button ref={anchorRef} data-testid="add-key-2" onClick={() => Modal.show({
            component: KeySheet, onRequestClose: cardDismissed,
            chrome: { kind: 'card', title: 'Connect', phonePresentation: 'sheet', scrollHost: 'bounded', anchor: { kind: 'view', ref: anchorRef } },
        })}>Add key</button>;
    }
    try {
        const { PopoverScope } = await import('@/components/ui/popover/PopoverScope');
        await act(async () => root.render(<PopoverScope><ModalProvider><span /></ModalProvider></PopoverScope>));
        await act(async () => { hostId = Modal.show({ component: ConnectDialog, chrome: { kind: 'card', title: 'Connect a provider' } }); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="add-key-2"]')).not.toBeNull());
        await act(async () => document.querySelector('[data-testid="add-key-2"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        await vi.waitFor(() => expect(document.querySelector('[data-testid="key-sheet-2"]')).not.toBeNull());
        // Cancel on the Connect dialog: the card it hung leaves with it, and its opener hears the dismissal.
        await act(async () => { Modal.hide(hostId!); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="key-sheet-2"]')).toBeNull());
        expect(cardDismissed).toHaveBeenCalledTimes(1);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
