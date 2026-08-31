import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IconActionProps } from '@/components/ui/buttons/IconAction';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = React;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

type CapturedListener = (event: unknown) => void;
const originalDocument = (globalThis as { document?: unknown }).document;
let domListeners: Map<string, CapturedListener[]>;

beforeEach(() => {
    vi.resetModules();
    domListeners = new Map();
    (globalThis as { document?: unknown }).document = {
        addEventListener: (type: string, listener: CapturedListener) => {
            domListeners.set(type, [...(domListeners.get(type) ?? []), listener]);
        },
        removeEventListener: () => {},
    };
});

afterEach(() => {
    if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
    } else {
        (globalThis as { document?: unknown }).document = originalDocument;
    }
});

async function dispatchDom(type: string, event: unknown): Promise<void> {
    await act(async () => {
        for (const listener of domListeners.get(type) ?? []) listener(event);
    });
}

function flattenStyle(style: unknown, state?: { pressed?: boolean; hovered?: boolean }): Record<string, unknown> {
    const resolved = typeof style === 'function' ? (style as (s: unknown) => unknown)(state ?? {}) : style;
    return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
}

async function renderAction(overrides: Partial<IconActionProps> = {}) {
    const { IconAction } = await import('@/components/ui/buttons/IconAction');
    return renderScreen(
        <IconAction testID="icon-action" accessibilityLabel="Overflow" onPress={() => {}} {...overrides}>
            <React.Fragment />
        </IconAction>,
    );
}

describe('IconAction press feedback', () => {
    it('keeps today\'s fills — press and hover tint, rest is bare', async () => {
        const screen = await renderAction();
        const style = screen.findHostByTestId('icon-action')?.props.style;

        expect(flattenStyle(style, {}).backgroundColor).toBeUndefined();
        expect(flattenStyle(style, { hovered: true }).backgroundColor).toBe(lightTheme.colors.surface.pressed);
        expect(flattenStyle(style, { pressed: true }).backgroundColor).toBe(lightTheme.colors.surface.selected);
    });

    it('renders a toggled-on control as if hovered', async () => {
        const screen = await renderAction({ active: true });

        expect(flattenStyle(screen.findHostByTestId('icon-action')?.props.style, {}).backgroundColor)
            .toBe(lightTheme.colors.surface.pressed);
    });

    it('never lowers glyph opacity to signal a press', async () => {
        const screen = await renderAction();
        const style = screen.findHostByTestId('icon-action')?.props.style;

        expect(flattenStyle(style, { pressed: true }).opacity).toBeUndefined();
        expect(flattenStyle(style, { hovered: true }).opacity).toBeUndefined();
    });

    it('keeps the disabled treatment it already had', async () => {
        const screen = await renderAction({ disabled: true });
        const style = screen.findHostByTestId('icon-action')?.props.style;

        expect(flattenStyle(style, { pressed: true, hovered: true }).opacity).toBe(0.4);
        expect(flattenStyle(style, { pressed: true, hovered: true }).backgroundColor).toBeUndefined();
    });

    it('still extends its touch target when a row asks for the 44pt floor', async () => {
        const screen = await renderAction({ size: 'sm', hitSlop: 8 });

        expect(screen.findHostByTestId('icon-action')?.props.hitSlop).toBe(8);
    });

    it('forwards switch semantics for icon-only toggles', async () => {
        const screen = await renderAction({
            accessibilityRole: 'switch',
            accessibilityState: { checked: true },
        });

        expect(screen.findHostByTestId('icon-action')?.props.accessibilityRole).toBe('switch');
        expect(screen.findHostByTestId('icon-action')?.props.accessibilityState).toEqual({
            checked: true,
            disabled: false,
        });
    });

    it('shows the focus ring for keyboard traversal only', async () => {
        const screen = await renderAction();

        await dispatchDom('pointerdown', {});
        await act(async () => {
            screen.findHostByTestId('icon-action')?.props.onFocus?.({});
        });
        expect(screen.findAllHostsByTestId('icon-action-focus-ring')).toHaveLength(0);

        await dispatchDom('keydown', { key: 'Tab' });

        const ring = screen.findHostByTestId('icon-action-focus-ring');
        expect(flattenStyle(ring?.props.style).borderColor).toBe(lightTheme.colors.focus.ring);
    });

    it('rings the larger box on its own corner radius', async () => {
        const screen = await renderAction({ size: 'lg' });
        await dispatchDom('keydown', { key: 'Tab' });
        await act(async () => {
            screen.findHostByTestId('icon-action')?.props.onFocus?.({});
        });

        const ring = flattenStyle(screen.findHostByTestId('icon-action-focus-ring')?.props.style);
        expect(ring.borderTopLeftRadius).toBeGreaterThan(12);
    });
});
