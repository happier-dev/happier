/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dropdown } from '@happier-dev/plugin-ui';
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock() });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: () => null }));
vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({ CodeBlockView: () => null }));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: () => null }));

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: (props: React.PropsWithChildren) => React.createElement(React.Fragment, null, props.children),
    }),
}));

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

    async function renderDropdown(): Promise<HTMLButtonElement> {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
        originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        HTMLElement.prototype.getBoundingClientRect = () => rect(100, 100, 180, 40);
        globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0);
        globalThis.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle);

        await act(async () => {
            root?.render(<DropdownHarness />);
        });

        const trigger = container.querySelector<HTMLButtonElement>('[data-testid="plugin-dropdown-more"]');
        if (!trigger) throw new Error('missing plugin Dropdown trigger');
        return trigger;
    }

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
