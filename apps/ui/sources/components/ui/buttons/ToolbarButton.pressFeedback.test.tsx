import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolbarButtonProps } from '@/components/ui/buttons/ToolbarButton';
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, children),
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

async function renderButton(overrides: Partial<ToolbarButtonProps> = {}) {
    const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
    return renderScreen(
        <ToolbarButton testID="toolbar-button" label="Refresh" onPress={() => {}} {...overrides} />,
    );
}

describe('ToolbarButton press feedback', () => {
    it('keeps its resting fill and tints on hover and press', async () => {
        const screen = await renderButton();
        const style = screen.findHostByTestId('toolbar-button')?.props.style;

        expect(flattenStyle(style, {}).backgroundColor).toBe(lightTheme.colors.surface.base);
        expect(flattenStyle(style, { hovered: true }).backgroundColor).toBe(lightTheme.colors.surface.pressed);
        expect(flattenStyle(style, { pressed: true }).backgroundColor).toBe(lightTheme.colors.surface.selected);
    });

    it('keeps the primary fill, which a caller-supplied style must still win', async () => {
        const screen = await renderButton({ tone: 'primary' });

        expect(flattenStyle(screen.findHostByTestId('toolbar-button')?.props.style, {}).backgroundColor)
            .toBe(lightTheme.colors.button.primary.background);
    });

    it('never dims its label to signal a press', async () => {
        const screen = await renderButton();
        const style = screen.findHostByTestId('toolbar-button')?.props.style;

        expect(flattenStyle(style, { pressed: true }).opacity).toBeUndefined();
        expect(flattenStyle(style, { hovered: true }).opacity).toBeUndefined();
    });

    it('keeps the disabled treatment it already had', async () => {
        const screen = await renderButton({ disabled: true });
        const style = screen.findHostByTestId('toolbar-button')?.props.style;

        expect(flattenStyle(style, { pressed: true, hovered: true }).opacity).toBe(0.45);
        expect(flattenStyle(style, { pressed: true, hovered: true }).backgroundColor)
            .toBe(lightTheme.colors.surface.base);
    });

    it('shows the focus ring for keyboard traversal only', async () => {
        const screen = await renderButton();

        await dispatchDom('pointerdown', {});
        await act(async () => {
            screen.findHostByTestId('toolbar-button')?.props.onFocus?.({});
        });
        expect(screen.findAllHostsByTestId('toolbar-button-focus-ring')).toHaveLength(0);

        await dispatchDom('keydown', { key: 'Tab' });

        expect(flattenStyle(screen.findHostByTestId('toolbar-button-focus-ring')?.props.style).borderColor)
            .toBe(lightTheme.colors.focus.ring);
    });
});
