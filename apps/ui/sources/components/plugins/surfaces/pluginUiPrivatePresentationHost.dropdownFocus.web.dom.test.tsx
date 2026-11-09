/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu, Dropdown, Menu } from '@happier-dev/plugin-ui';
import { Dimensions } from 'react-native';
import * as AuthorComponents from '@happier-dev/plugin-ui/components';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
import {
    CollectionAddMenuExample,
    type CollectionAddMenuExampleProps,
} from '../../../../../../packages/plugin-ui/fixtures/external-authoring/src/collectionAddMenuSurface';

import {
    PluginUiPresentationHostProviderInternal,
} from '../../../../../../packages/plugin-ui/src/presentationHost/context';
import {
    createHostApiStub,
    createSurfaceContext,
} from '../../../../../../packages/plugin-ui/src/surfaceFixture.testSupport';

import { createPluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The defect is in the composed browser path. Use the actual RNW pressable so
// this test observes its keyboard/ref behavior instead of a hand-written DOM
// approximation.
vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: <T,>(values: Readonly<{ web?: T; default?: T; native?: T; ios?: T; android?: T }>) => (
                values.web ?? values.default ?? values.native ?? values.ios ?? values.android
            ),
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: () => null }));
vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({ CodeBlockView: () => null }));

vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return await createRadixCjsRealModule();
});

vi.mock('@/utils/web/reactDomCjs', async () => {
    const ReactDOM = await import('react-dom');
    return { requireReactDOM: () => ReactDOM };
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: React.PropsWithChildren<Record<string, unknown>>) => (
        React.createElement('div', props, props.children)
    ),
}));

function rect(x: number, y: number, width: number, height: number): DOMRect {
    return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({}),
    };
}

it('reports a web focus transfer only when the browser actually accepted it', () => {
    const host = createPluginUiPrivatePresentationHost(undefined, {
        isFocusEligible: () => true,
    });
    const refused = document.createElement('button');
    const accepted = document.createElement('button');
    document.body.append(refused, accepted);
    // jsdom has no layout engine, so display:none does not reliably reproduce
    // a browser refusing focus. Keep the real DOM target and model only that
    // exact browser outcome: focus() returns but activeElement does not move.
    refused.focus = vi.fn();

    try {
        expect(host.focusTarget?.(refused)).toBe(false);
        expect(document.activeElement).not.toBe(refused);

        expect(host.focusTarget?.(accepted)).toBe(true);
        expect(document.activeElement).toBe(accepted);
    } finally {
        refused.remove();
        accepted.remove();
    }
});

function DropdownHarness() {
    const [open, setOpen] = React.useState(false);
    const context = React.useMemo(() => createSurfaceContext(), []);
    const hostApi = React.useMemo(() => createHostApiStub(context), [context]);
    const presentationHost = React.useMemo(
        () => createPluginUiPrivatePresentationHost({ displayName: 'Focus test plugin' }),
        [],
    );

    return (
        <PluginUiProvider hostApi={hostApi} context={context}>
            <PluginUiPresentationHostProviderInternal host={presentationHost}>
                <Dropdown
                    testID="plugin-dropdown-more"
                    open={open}
                    onOpenChange={setOpen}
                    trigger="More"
                    triggerAccessibilityLabel="More actions"
                    items={[{ id: 'inspect', label: 'Inspect' }]}
                    onSelect={() => undefined}
                />
            </PluginUiPresentationHostProviderInternal>
        </PluginUiProvider>
    );
}

function SubmenuHarness({ component: MenuComponent = Menu, onSelect }: Readonly<{
    component?: typeof Menu;
    onSelect: (id: string) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const context = React.useMemo(() => createSurfaceContext(), []);
    const host = React.useMemo(() => createPluginUiPrivatePresentationHost(), []);
    // A variable also reaches the pre-change type without suppressing a diagnostic:
    // RED observes the missing behavior through the real public component and host.
    const items = [{ id: 'move', label: 'Move to', submenu: {
        title: 'Choose folder', items: [{ id: 'work', label: 'Work', person: 'Ada Lovelace' }, { id: 'personal', label: 'Personal', disabled: true }],
    } }];
    return <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
            <MenuComponent open={open} onOpenChange={setOpen} trigger="More" triggerAccessibilityLabel="More actions"
                testID="plugin-submenu" items={items} onSelect={onSelect} />
        </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
}

// The author fixture uses only public components; this harness supplies the real
// binding that an installed same-realm surface receives.
function AddMenuHarness(props: CollectionAddMenuExampleProps & Readonly<{ withoutPresenter?: boolean }>) {
    const context = React.useMemo(() => createSurfaceContext(), []);
    const hostApi = React.useMemo(() => createHostApiStub(context), [context]);
    const host = React.useMemo(() => {
        const bound = createPluginUiPrivatePresentationHost({ displayName: 'Author plugin' });
        return props.withoutPresenter ? { ...bound, collectionAddMenu: undefined } : bound;
    }, [props.withoutPresenter]);
    return <PluginUiProvider hostApi={hostApi} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
            <CollectionAddMenuExample onSelect={props.onSelect} customTrigger={props.customTrigger} disabled={props.disabled} />
        </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>;
}

function dispatchPointerPress(target: HTMLElement): void {
    const event = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
    target.dispatchEvent(new MouseEvent('mousedown', { ...event, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...event, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...event, buttons: 0 }));
}

function dispatchKeyboardEnterPress(target: HTMLElement): void {
    target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
    }));
    target.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
    }));
    // RNW delegates native-button activation to the browser. Raw jsdom key
    // events do not execute that default action, so represent its detail-0
    // click explicitly to exercise the same full Enter cycle as a browser.
    target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail: 0,
    }));
}

async function waitForPopoverCommit(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
}

describe('plugin Dropdown through the private presentation host (real RNW)', () => {
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;
    let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect | null = null;
    let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | null = null;
    let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | null = null;

    afterEach(async () => {
        if (root) {
            await act(async () => { root?.unmount(); });
        }
        root = null;
        container?.remove();
        container = null;
        if (originalGetBoundingClientRect) HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
        if (originalCancelAnimationFrame) globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
        originalGetBoundingClientRect = null;
        originalRequestAnimationFrame = null;
        originalCancelAnimationFrame = null;
    });

    async function renderContent(content: React.ReactNode): Promise<HTMLDivElement> {
        const mountedContainer = document.createElement('div');
        container = mountedContainer;
        document.body.appendChild(mountedContainer);
        root = createRoot(mountedContainer);
        originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        HTMLElement.prototype.getBoundingClientRect = () => rect(100, 100, 180, 40);
        globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle);

        await act(async () => {
            root?.render(content);
        });
        return mountedContainer;
    }

    async function renderDropdown(content: React.ReactNode = <DropdownHarness />, triggerTestID = 'plugin-dropdown-more'): Promise<HTMLButtonElement> {
        const mountedContainer = await renderContent(content);
        const trigger = mountedContainer.querySelector<HTMLButtonElement>(`[data-testid="${triggerTestID}"]`);
        if (!trigger) throw new Error('missing plugin Dropdown trigger');
        return trigger;
    }

    it.each([Menu, Dropdown, ContextMenu])('opens public submenus with Right and returns with Left before selecting a leaf (%s)', async (component) => {
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<SubmenuHarness component={component} onSelect={onSelect} />, 'plugin-submenu');
        await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
        const parent = document.querySelector<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]');
        expect(parent).not.toBeNull();
        await act(async () => {
            parent!.focus();
            parent!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[role="menuitem"][aria-label="Work"]')).not.toBeNull());
        expect(document.querySelector('[role="menuitem"][aria-label="Work"] [data-testid="menu-item-face"]')).not.toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => {
            const leaf = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Work"]')!;
            leaf.focus();
            leaf.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[role="menuitem"][aria-label="Work"]')).toBeNull());
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { dispatchPointerPress(parent!); });
        await vi.waitFor(() => expect(document.querySelector('[role="menuitem"][aria-label="Work"]')).not.toBeNull());
        await act(async () => { document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Work"]')!.click(); });
        await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('work', expect.anything()));
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('pushes public submenu choices inside one phone sheet and Back returns to the parent', async () => {
        const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        try {
            const onSelect = vi.fn();
            const trigger = await renderDropdown(<SubmenuHarness onSelect={onSelect} />, 'plugin-submenu');
            await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
            const sheet = document.querySelector('[role="dialog"][aria-label="More actions"]');
            expect(sheet).not.toBeNull();
            const openChild = async () => { await act(async () => {
                document.querySelector<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')!.click();
            }); };
            await openChild();
            await vi.waitFor(() => expect(document.querySelector('[data-testid="popover-sheet.back"]')).not.toBeNull());
            expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
            expect(sheet?.textContent).toContain('Choose folder');
            expect(sheet?.textContent).toContain('Work');
            expect(onSelect).not.toHaveBeenCalled();
            await act(async () => { document.querySelector<HTMLElement>('[data-testid="popover-sheet.back"]')!.click(); });
            await vi.waitFor(() => expect(document.querySelector('[data-testid="popover-sheet.back"]')).toBeNull());
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            await openChild();
            await act(async () => { document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Work"]')!.click(); });
            await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('work', expect.anything()));
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
        } finally { dimensions.mockRestore(); }
    });

    it('lets an external author use the grouped searchable Add menu and notice through the real host', async () => {
        expect(AuthorComponents).toHaveProperty('CollectionAddMenu', expect.any(Function));
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<AddMenuHarness onSelect={onSelect} />, 'author-add-trigger');
        expect(trigger.getAttribute('aria-label')).toBe('Add a source');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('[data-testid="author-add-menu:notice"]')).toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => {
            // jsdom raw mouse events do not execute the browser's pointer-focus default.
            trigger.focus();
            dispatchPointerPress(trigger);
            await waitForPopoverCommit();
        });
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('[data-testid="author-add-menu:notice"]')?.textContent)
            .toBe('Some sources need setup before they can be added.');
        expect(document.body.textContent).toContain('Cloud');
        expect(document.body.textContent).toContain('On this computer');
        const search = document.querySelector<HTMLInputElement>('input[placeholder="Find sources"]');
        expect(search).not.toBeNull();
        const disabled = document.querySelector<HTMLElement>('[data-testid="author-source-8"]');
        expect(disabled).not.toBeNull();
        await act(async () => { if (disabled) dispatchPointerPress(disabled); });
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(search, 'Local inference');
            search?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(document.querySelector('[data-testid="author-source-0"]')).toBeNull();
        const choice = document.querySelector<HTMLElement>('[data-testid="author-source-9"]');
        expect(choice).not.toBeNull();
        await act(async () => { if (choice) dispatchPointerPress(choice); await waitForPopoverCommit(); });
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('source-9', expect.objectContaining({
            anchor: expect.objectContaining({ kind: 'view' }),
        }));
        expect(document.querySelector('[data-testid="author-add-menu:notice"]')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps an author invitation and a short list on the same dropdown, including Escape focus return', async () => {
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<AddMenuHarness onSelect={onSelect} customTrigger />, 'author-custom-add-trigger');
        await act(async () => {
            trigger.focus();
            dispatchPointerPress(trigger);
            await waitForPopoverCommit();
        });
        expect(document.querySelector('[data-testid="author-source-0"]')).not.toBeNull();
        expect(document.querySelector('input[placeholder="Find sources"]')).toBeNull();
        const row = document.querySelector<HTMLElement>('[data-testid="author-source-0"]');
        await act(async () => { row?.focus(); });
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await waitForPopoverCommit();
        });
        expect(document.querySelector('[data-testid="author-add-menu:notice"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('reports unavailable presentation rather than drawing a substitute menu without the host binding', async () => {
        await renderContent(<AddMenuHarness onSelect={() => undefined} withoutPresenter />);
        expect(container?.querySelector('[data-testid="author-add-menu-unavailable"]')?.textContent)
            .toBe('Adding items is unavailable on this host.');
        expect(document.querySelector('[data-testid="author-add-trigger"]')).toBeNull();
    });

    it('keeps the default Add trigger labelled and disabled without opening or selecting', async () => {
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<AddMenuHarness onSelect={onSelect} disabled />, 'author-add-trigger');
        expect(trigger.getAttribute('aria-label')).toBe('Add a source');
        expect(trigger.disabled).toBe(true);
        await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
        expect(document.querySelector('[data-testid="author-add-menu:notice"]')).toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('opens with Enter and returns exact trigger focus after pointer-open Escape', async () => {
        const trigger = await renderDropdown();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');

        await act(async () => {
            dispatchPointerPress(trigger);
            await waitForPopoverCommit();
        });

        const pointerOpenedItem = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
        expect(pointerOpenedItem).not.toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        // Initial focus is owned and separately covered by the incumbent
        // Popover. Establish the real menu row as the Escape event target so
        // this regression stays about the trigger-return contract.
        await act(async () => {
            pointerOpenedItem?.focus();
        });
        expect(document.activeElement).toBe(pointerOpenedItem);

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            await Promise.resolve();
        });

        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);

        await act(async () => {
            trigger.focus();
            dispatchKeyboardEnterPress(trigger);
            await waitForPopoverCommit();
        });

        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
    });
});
