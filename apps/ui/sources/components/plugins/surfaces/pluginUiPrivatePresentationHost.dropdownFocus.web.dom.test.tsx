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
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

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
    const host = React.useMemo(() => createPluginUiPrivatePresentationHost(undefined), []);
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

// Long enough that the menu offers its search field.
const PLAIN_MENU_ITEMS = ['Pin', 'Open in new tab', 'Open to the right', 'Open below', 'Move', 'Mention in composer',
    'Copy link', 'Rename', 'Select'].map(label => ({ id: label === 'Pin' ? 'pin' : label === 'Select' ? 'select' : label, label }));

function PlainMenuHarness({ component: MenuComponent, onSelect, searchItems }: Readonly<{
    component: typeof Menu;
    onSelect: (id: string) => void;
    searchItems?: (query: string) => typeof PLAIN_MENU_ITEMS;
}>) {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const context = React.useMemo(() => createSurfaceContext(), []);
    const host = React.useMemo(() => createPluginUiPrivatePresentationHost(undefined), []);
    return <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <PluginUiPresentationHostProviderInternal host={host}>
            <MenuComponent open={open} onOpenChange={setOpen} trigger="More" triggerAccessibilityLabel="More actions"
                testID="plugin-plain" items={searchItems?.(query) ?? PLAIN_MENU_ITEMS}
                search={{ value: query, onValueChange: setQuery }} onSelect={onSelect} />
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
        // Core DropdownMenu uses actionable button rows, including submenu parents.
        await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Move to"]')).not.toBeNull());
        const parent = document.querySelector<HTMLElement>('[role="button"][aria-label="Move to"]')!;
        await act(async () => {
            parent.focus();
            parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Work"]')).not.toBeNull());
        expect(document.querySelector('[role="button"][aria-label="Work"] [data-testid="menu-item-face"]')).not.toBeNull();
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => {
            const leaf = document.querySelector<HTMLElement>('[role="button"][aria-label="Work"]')!;
            leaf.focus();
            leaf.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Work"]')).toBeNull());
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { dispatchPointerPress(parent); });
        await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Work"]')).not.toBeNull());
        await act(async () => { document.querySelector<HTMLElement>('[role="button"][aria-label="Work"]')!.click(); });
        await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('work', expect.anything()));
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it.each([Menu, Dropdown, ContextMenu])('draws a plain public menu with the core menu rows and search, not a package surface (%s)', async (component) => {
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<PlainMenuHarness component={component} onSelect={onSelect} />, 'plugin-plain');
        await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="dropdown-option-pin"]')).not.toBeNull());
        // One menu owner: the package's own rows (role=menu / menuitem) are never drawn under a host.
        expect(document.querySelector('[role="menuitem"]')).toBeNull();
        const search = document.querySelector<HTMLInputElement>('input[placeholder="Search"]');
        expect(search).not.toBeNull();
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(search, 'sel');
            search?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="dropdown-option-pin"]')).toBeNull());
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="dropdown-option-select"]')!.click(); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(onSelect).toHaveBeenCalledWith('select', expect.anything());
        });
    });

    it('lets the public menu owner supply search results absent from its loaded rows', async () => {
        const onSelect = vi.fn();
        const trigger = await renderDropdown(<PlainMenuHarness component={Menu} onSelect={onSelect}
            searchItems={query => query === 'Remote' ? [{ id: 'remote', label: 'Remote team' }] : PLAIN_MENU_ITEMS} />, 'plugin-plain');
        await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="dropdown-option-pin"]')).not.toBeNull());
        expect(document.querySelector('[data-testid="dropdown-option-remote"]')).toBeNull();
        const search = document.querySelector<HTMLInputElement>('input[placeholder="Search"]');
        expect(search).not.toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'Remote');
            search?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await vi.waitFor(() => expect(document.querySelector('[data-testid="dropdown-option-remote"]')).not.toBeNull());
        await act(async () => { document.querySelector<HTMLElement>('[data-testid="dropdown-option-remote"]')!.click(); });
        await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith('remote', expect.anything()));
    });

    it('pushes public submenu choices inside one phone menu and Back returns to the parent', async () => {
        const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        try {
            const onSelect = vi.fn();
            const trigger = await renderDropdown(<SubmenuHarness onSelect={onSelect} />, 'plugin-submenu');
            await act(async () => { dispatchPointerPress(trigger); await waitForPopoverCommit(); });
            await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Move to"]')).not.toBeNull());
            // Ordinary menus use the core phone panel; the public `sheet` option
            // instead applies choices in place and deliberately keeps them open.
            expect(document.querySelectorAll('[data-testid="popover-push.root"]')).toHaveLength(1);
            const openChild = async () => { await act(async () => {
                document.querySelector<HTMLElement>('[role="button"][aria-label="Move to"]')!.click();
            }); };
            await openChild();
            await vi.waitFor(() => expect(document.querySelector('[data-testid="popover-push.back"]')).not.toBeNull());
            expect(document.querySelectorAll('[data-testid="popover-push.root"]')).toHaveLength(1);
            expect(document.querySelectorAll('[data-testid="popover-push.view"]')).toHaveLength(1);
            expect(document.querySelector('[data-testid="popover-push.view"]')?.textContent).toContain('Choose folder');
            expect(document.querySelector('[data-testid="popover-push.view"]')?.textContent).toContain('Work');
            expect(onSelect).not.toHaveBeenCalled();
            await act(async () => { document.querySelector<HTMLElement>('[data-testid="popover-push.back"]')!.click(); });
            await vi.waitFor(() => expect(document.querySelector('[data-testid="popover-push.view"]')).toBeNull());
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            await openChild();
            await vi.waitFor(() => expect(document.querySelector('[role="button"][aria-label="Work"]')).not.toBeNull());
            expect(document.querySelector('[role="button"][aria-label="Work"] [data-testid="menu-item-face"]')).not.toBeNull();
            await act(async () => { document.querySelector<HTMLElement>('[role="button"][aria-label="Work"]')!.click(); });
            // Submenu selection is deferred through the core menu's frame scheduler;
            // flush its parent close before observing the controlled trigger state.
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(onSelect).toHaveBeenCalledWith('work', expect.anything());
                expect(trigger.getAttribute('aria-expanded')).toBe('false');
            });
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

        const pointerOpenedItem = document.querySelector<HTMLElement>('[data-testid="dropdown-option-inspect"]');
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
        expect(document.querySelector('[data-testid="dropdown-option-inspect"]')).not.toBeNull();
    });
});


describe('inline Action binding person commits', () => {
    it.each(['icon', 'form', 'menu', 'property', 'toggle', 'relation', 'tone', 'relation-remove'] as const)('executes the host-created %s control once, never on prop changes', async kind => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { createPluginSurfaceActionControls } = await import('./pluginSurfaceActionControls');
        const { IconButton, Form, PropertyList, Toggle, RelationList } = await import('@happier-dev/plugin-ui/components');
        let effects = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ projectAction: async () => {
            effects++; return { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
        } }));
        const lifetime = new AbortController();
        const controls = createPluginSurfaceActionControls({ pluginId: 'acme.test', surfaceId: 'inline-test',
            hostAction: { execute: executor.execute, context: { runtimeAccountId: 'account-a' } },
            signal: lifetime.signal, isCurrent: () => true, captureCurrentBinding: () => () => true });
        const context = createSurfaceContext();
        const hostApi = createHostApiStub(context);
        const host = createPluginUiPrivatePresentationHost(undefined, { actionControls: controls });
        const input = { workspace: { serverId: 'server-1', machineId: 'machine_1', workspaceId: 'workspace-a', rootPath: '/work' },
            executable: 'act', argv: [], cwd: '/work' };
        let prepared = 0;
        const committed: unknown[] = [];
        const executions: unknown[] = [];
        const binding = { action: 'projects.compute.exec' as const,
            prepare(value: unknown) { prepared++; committed.push(value); return { input }; },
            onSettled(execution: unknown) { executions.push(execution); return execution; } };
        const previousRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = () => rect(100, 100, 180, 40);
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const render = (value: string) => <PluginUiProvider hostApi={hostApi} context={context}>
            <PluginUiPresentationHostProviderInternal host={host}>
                {kind === 'icon' ? <IconButton accessibilityLabel="Complete task" icon={null} testID="inline-icon" action={binding} />
                : kind === 'form' ? <Form hints={{ fields: [{ path: 'title', title: 'Title', widget: 'text' }], submitLabel: 'Create task' }}
                    value={{ title: value }} onChange={() => {}} action={binding} testID="inline-form" />
                : kind === 'toggle' ? <Toggle label="Workflow active" value={value === 'in_progress'} action={binding} testID="inline-toggle" />
                : kind === 'relation-remove' ? <RelationList entries={[{ id: 'done', title: 'Fix totals', removeAction: binding }]} testID="inline-relation" />
                : kind === 'relation' ? <RelationList entries={[]} add={{ label: 'Add a blocker', choices: [{ id: 'done', label: 'Done' }], action: binding }} testID="inline-relation" />
                : kind === 'tone' ? <PropertyList testID="inline-tone" items={[{ id: 'labels', label: 'Labels', value: 'Bug', editor: {
                    kind: 'list', value: ['Bug'], onCommit: () => undefined, tones: { valueOf: () => null,
                        choices: [{ id: 'done', label: 'Done', tone: 'danger' }], action: binding } } }]} />
                : kind === 'menu' ? <Menu trigger="Status" triggerAccessibilityLabel="Status" open onOpenChange={() => {}}
                    items={[{ id: 'done', label: 'Done', action: binding }]} onSelect={() => {}} testID="inline-menu" />
                : <PropertyList testID="inline-property" items={[{ id: 'status', label: 'Status', value,
                    editor: { kind: 'choice', value, choices: [{ id: 'open', label: 'Open' }, { id: 'in_progress', label: 'In progress' }, { id: 'done', label: 'Done' }], action: binding } }]} />}
            </PluginUiPresentationHostProviderInternal>
        </PluginUiProvider>;
        try {
            await act(async () => { root.render(render('open')); });
            await act(async () => { root.render(render('in_progress')); });
            expect({ effects, prepared }).toEqual({ effects: 0, prepared: 0 });
            const click = async (read: () => HTMLElement | undefined | null) => {
                const target = read(); expect(target).toBeTruthy();
                await act(async () => { dispatchPointerPress(target!); await waitForPopoverCommit(); });
            };
            if (kind === 'icon') await click(() => container.querySelector('[data-testid="inline-icon"]'));
            else if (kind === 'form') await click(() => Array.from(container.querySelectorAll<HTMLElement>('[role="button"],button'))
                .find(button => button.textContent === 'Create task'));
            else if (kind === 'relation-remove') await click(() => container.querySelector('[data-testid="inline-relation.done.remove"]'));
            else if (kind === 'toggle') await click(() => container.querySelector('[role="switch"]'));
            else {
                if (kind === 'relation') await click(() => container.querySelector('[data-testid="inline-relation.add"]'));
                if (kind === 'tone') {
                    await click(() => container.querySelector('[data-testid="inline-tone.labels.value"]'));
                    await click(() => document.querySelector('[aria-label="Colour of Bug, No colour"]'));
                }
                if (kind === 'property') await click(() => container.querySelector('[data-testid="inline-property.status.value"]'));
                await vi.waitFor(() => expect(document.querySelector('[data-testid="dropdown-option-done"]')).not.toBeNull());
                await click(() => document.querySelector('[data-testid="dropdown-option-done"]'));
            }
            expect({ effects, prepared }).toEqual({ effects: 1, prepared: 1 });
            expect(executions).toMatchObject([{ ok: true }]);
            expect(committed).toEqual([kind === 'icon' ? undefined : kind === 'form' ? { title: 'in_progress' }
                : kind === 'toggle' ? false : kind === 'tone' ? { name: 'Bug', colorToken: 'done' } : 'done']);
        } finally { await act(async () => { root.unmount(); }); controls.dispose(); lifetime.abort(); container.remove(); HTMLElement.prototype.getBoundingClientRect = previousRect; }
    });
});

it('keeps inline binding unavailable without a mounted host Action owner', async () => {
    const { IconButton, Form, PropertyList } = await import('@happier-dev/plugin-ui/components');
    const context = createSurfaceContext();
    let preparations = 0;
    const binding = { action: 'projects.compute.exec' as const, prepare(_value: unknown) { preparations++; return null; }, onSettled() {} };
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
        await act(async () => root.render(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
            <IconButton accessibilityLabel="Complete" testID="unsupported-icon" icon={null} action={binding} />
            <Form hints={{ fields: [], submitLabel: 'Create' }} value={{}} onChange={() => {}} action={binding} />
            <PropertyList items={[{ id: 'status', label: 'Status', value: 'Open', editor: {
                kind: 'choice', value: 'open', choices: [{ id: 'open', label: 'Open' }], action: binding } }]} />
        </PluginUiProvider>));
        expect(container.querySelector('[data-testid="unsupported-icon"]')?.getAttribute('aria-disabled')).toBe('true');
        expect(container.textContent).toContain('Inline actions are unavailable');
        expect(preparations).toBe(0);
    } finally { await act(async () => root.unmount()); container.remove(); }
});


it.each(['icon-unmount', 'menu-unmount', 'menu-close'] as const)(
    'settles async inline preparation against the author control lifetime: %s', async kind => {
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
        const { createPluginSurfaceActionControls } = await import('./pluginSurfaceActionControls');
        const { IconButton } = await import('@happier-dev/plugin-ui/components');
        let effects = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ projectAction: async () => {
            effects++; return { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
        } }));
        const lifetime = new AbortController();
        const controls = createPluginSurfaceActionControls({ pluginId: 'acme.test', surfaceId: 'inline-cancellation',
            hostAction: { execute: executor.execute, context: { runtimeAccountId: 'account-a' } },
            signal: lifetime.signal, isCurrent: () => true, captureCurrentBinding: () => () => true });
        const context = createSurfaceContext();
        const hostApi = createHostApiStub(context);
        const host = createPluginUiPrivatePresentationHost(undefined, { actionControls: controls });
        const ready = createDeferred<void>();
        let preparationSignal: AbortSignal | undefined;
        const executions: unknown[] = [];
        const binding = { action: 'projects.compute.exec' as const,
            async prepare(_value: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
                preparationSignal = options?.signal;
                await ready.promise;
                return { input: { workspace: { serverId: 'server-1', machineId: 'machine_1', workspaceId: 'workspace-a', rootPath: '/work' },
                    executable: 'act', argv: [], cwd: '/work' } };
            },
            onSettled(execution: unknown) { executions.push(execution); return execution; } };
        function AuthorControl() {
            const [open, setOpen] = React.useState(true);
            return kind === 'icon-unmount'
                ? <IconButton accessibilityLabel="Complete task" icon={null} testID="async-inline-icon" action={binding} />
                : <Menu trigger="Status" triggerAccessibilityLabel="Status" open={open} onOpenChange={setOpen}
                    items={[{ id: 'done', label: 'Done', action: binding }]} onSelect={() => {}} testID="async-inline-menu" />;
        }
        const previousRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = () => rect(100, 100, 180, 40);
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => { root.render(<PluginUiProvider hostApi={hostApi} context={context}>
                <PluginUiPresentationHostProviderInternal host={host}><AuthorControl /></PluginUiPresentationHostProviderInternal>
            </PluginUiProvider>); });
            const selector = kind === 'icon-unmount' ? '[data-testid="async-inline-icon"]' : '[data-testid="dropdown-option-done"]';
            await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
            await act(async () => { dispatchPointerPress(document.querySelector<HTMLElement>(selector)!); await waitForPopoverCommit(); });
            expect(preparationSignal).toBeDefined();
            expect(preparationSignal?.aborted).toBe(false);
            expect(effects).toBe(0);
            if (kind === 'menu-close') {
                expect(container.querySelector('[data-testid="async-inline-menu"]')?.getAttribute('aria-expanded')).toBe('false');
                expect(document.querySelector('[data-testid="dropdown-option-done"]')).toBeNull();
            } else {
                await act(async () => { root.render(null); });
                expect(preparationSignal?.aborted).toBe(true);
            }
            await act(async () => { ready.resolve(undefined); await ready.promise; });
            await vi.waitFor(() => expect(executions).toHaveLength(1));
            expect(effects).toBe(kind === 'menu-close' ? 1 : 0);
            expect(executions[0]).toMatchObject({ ok: kind === 'menu-close' });
        } finally {
            await act(async () => { root.unmount(); lifetime.abort(); controls.dispose(); ready.resolve(undefined); await ready.promise; });
            container.remove(); HTMLElement.prototype.getBoundingClientRect = previousRect;
        }
    },
);
