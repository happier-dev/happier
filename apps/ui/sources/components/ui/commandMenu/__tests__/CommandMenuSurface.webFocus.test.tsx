/**
 * @vitest-environment jsdom
 *
 * A command menu is a non-focusable overlay: the host text field keeps keyboard
 * focus and drives the menu. On web the browser's default action for a pointer
 * press moves focus to whatever was pressed; because hosts close the menu when
 * their field blurs (`AgentInput` gates its whole suggestion query on
 * `isInputFocused`, `AgentInput.tsx:1802`), that focus shift unmounts the pressed
 * row between `mousedown` and `mouseup`, the browser then delivers no `click`, and
 * the press is silently swallowed — the reported "clicking a menu item does
 * nothing, you have to press Tab" bug.
 *
 * jsdom does not implement the browser's focus-on-mousedown default action, so
 * these tests model it explicitly (`if (!event.defaultPrevented) …`) and assert
 * the outcome that matters: the host field still holds focus afterwards.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandMenuAnchor } from '../commandMenuTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The `View` stub forwards to its DOM node exactly what react-native-web forwards,
 * and nothing else.
 *
 * react-native-web's `View` does NOT hand arbitrary props to the node: it picks
 * them from a whitelist (`forwardPropsList`, `exports/View/index.js`) composed from
 * the groups below, read from react-native-web itself so this cannot drift from the
 * installed version. `onMouseDown` is on that list; `onMouseDownCapture` is **not**
 * — even though `onKeyDownCapture` and `onTouchStartCapture` are, which is what
 * makes the omission so easy to walk into. A sibling primitive already did:
 * `SelectableMenuResults` wires its web mouse-down activation on
 * `onMouseDownCapture`, so the handler never reaches the DOM and the behaviour is
 * inert — and its own suite misses that because it mocks the row primitives down to
 * raw `<button>` elements, i.e. a green test for a fix that cannot run.
 *
 * A stub that spread every prop straight onto the `div` would certify this surface
 * the same way. Modelling the whitelist is the difference between asserting that
 * the surface *has* a pointer-down handler and asserting that the browser can ever
 * *call* it.
 */
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const forwardedProps = await import('react-native-web/dist/modules/forwardedProps');
    const viewForwardedProps: Record<string, true> = Object.assign(
        {},
        forwardedProps.defaultProps,
        forwardedProps.accessibilityProps,
        forwardedProps.clickProps,
        forwardedProps.focusProps,
        forwardedProps.keyboardProps,
        forwardedProps.mouseProps,
        forwardedProps.touchProps,
        forwardedProps.styleProps,
        { href: true, lang: true, onScroll: true, onWheel: true, pointerEvents: true },
    );

    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => {
            const { children, testID, collapsable, style, ...rest } = props;
            const forwarded: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(rest)) {
                if (viewForwardedProps[key]) forwarded[key] = value;
            }
            return React.createElement(
                'div',
                { ...forwarded, ref, 'data-testid': testID },
                children,
            );
        }),
    });
});

// Positioning/portalling belongs to the Popover suite; this test only needs the
// surface's own DOM node to exist so a real pointer press can reach it.
vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {},
    Popover: (props: any) => {
        if (!props.open) return null;
        return typeof props.children === 'function'
            ? props.children({ maxHeight: 240, maxWidth: 400, placement: 'top' })
            : props.children;
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement('div', null, props.children),
}));

const RECT_ANCHOR: CommandMenuAnchor = {
    kind: 'rect',
    rect: { left: 100, top: 200, height: 18 },
    coordinateSpace: 'window',
};

let container: HTMLDivElement;
let hostField: HTMLInputElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    hostField = document.createElement('input');
    document.body.appendChild(hostField);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    hostField.remove();
});

/**
 * Dispatches a pointer press and then performs the step the browser would take
 * next: unless the press was cancelled, focus leaves the host field.
 */
function pressAndApplyBrowserFocusDefault(target: Element): { cancelled: boolean } {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(event);
    if (!event.defaultPrevented) {
        hostField.blur();
    }
    return { cancelled: event.defaultPrevented };
}

async function renderSurface(children: React.ReactNode) {
    const { CommandMenuSurface } = await import('../CommandMenuSurface');
    await act(async () => {
        root.render(
            <CommandMenuSurface
                open
                anchor={RECT_ANCHOR}
                onRequestClose={() => {}}
                testID="command-menu-surface"
            >
                {children}
            </CommandMenuSurface>,
        );
    });
}

describe('CommandMenuSurface (web focus preservation)', () => {
    it('leaves keyboard focus on the host field when a row is pressed', async () => {
        await renderSurface(<div data-testid="command-menu-row">Row</div>);

        hostField.focus();
        expect(document.activeElement).toBe(hostField);

        const row = container.querySelector('[data-testid="command-menu-row"]');
        expect(row).not.toBeNull();
        const { cancelled } = pressAndApplyBrowserFocusDefault(row!);

        expect(cancelled).toBe(true);
        expect(document.activeElement).toBe(hostField);
    });

    it('leaves keyboard focus on the host field when the menu chrome is pressed', async () => {
        await renderSurface(<div data-testid="command-menu-row">Row</div>);

        hostField.focus();
        const surface = container.querySelector('[data-testid="command-menu-surface"]');
        expect(surface).not.toBeNull();

        pressAndApplyBrowserFocusDefault(surface!);

        expect(document.activeElement).toBe(hostField);
    });
});
