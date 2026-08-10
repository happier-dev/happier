import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PressableSurfaceProps } from '@/components/ui/interaction/PressableSurface';
import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = React;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('Pressable', props, children),
    });
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

function installFakeDom(): void {
    domListeners = new Map();
    (globalThis as { document?: unknown }).document = {
        addEventListener: (type: string, listener: CapturedListener) => {
            domListeners.set(type, [...(domListeners.get(type) ?? []), listener]);
        },
        removeEventListener: () => {},
    };
}

async function dispatchDom(type: string, event: unknown): Promise<void> {
    await act(async () => {
        for (const listener of domListeners.get(type) ?? []) listener(event);
    });
}

function flattenStyle(style: unknown, state?: { pressed?: boolean; hovered?: boolean }): Record<string, unknown> {
    const resolved = typeof style === 'function' ? (style as (s: unknown) => unknown)(state ?? {}) : style;
    return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
}

beforeEach(() => {
    vi.resetModules();
    installFakeDom();
});

afterEach(() => {
    if (originalDocument === undefined) {
        delete (globalThis as { document?: unknown }).document;
    } else {
        (globalThis as { document?: unknown }).document = originalDocument;
    }
});

const SURFACE_TEST_ID = 'surface';
const RING_TEST_ID = `${SURFACE_TEST_ID}-focus-ring`;

async function renderSurface(overrides: Partial<PressableSurfaceProps> = {}) {
    const { PressableSurface } = await import('@/components/ui/interaction/PressableSurface');
    return renderScreen(
        <PressableSurface
            testID={SURFACE_TEST_ID}
            accessibilityLabel="Do the thing"
            onPress={() => {}}
            focusRingRadius={8}
            {...overrides}
        >
            <React.Fragment />
        </PressableSurface>,
    );
}

describe('PressableSurface press feedback', () => {
    it('tints the surface on press instead of dimming what is written on it', async () => {
        const screen = await renderSurface();
        const surface = screen.findHostByTestId(SURFACE_TEST_ID);

        const resting = flattenStyle(surface?.props.style, {});
        const pressed = flattenStyle(surface?.props.style, { pressed: true });

        expect(resting.backgroundColor).toBeUndefined();
        expect(pressed.backgroundColor).toBe(lightTheme.colors.surface.selected);
        expect(resting.opacity).toBeUndefined();
        expect(pressed.opacity).toBeUndefined();
    });

    it('tints on hover without touching content opacity', async () => {
        const screen = await renderSurface();
        const hovered = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, { hovered: true });

        expect(hovered.backgroundColor).toBe(lightTheme.colors.surface.pressed);
        expect(hovered.opacity).toBeUndefined();
    });

    it('gives a disabled surface no feedback fill', async () => {
        const screen = await renderSurface({ disabled: true });
        const pressed = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, { pressed: true, hovered: true });

        expect(pressed.backgroundColor).toBeUndefined();
    });

    it('lets the caller override the feedback fill, because the caller styles last', async () => {
        const screen = await renderSurface({ styleOverride: { backgroundColor: '#123456' } });
        const pressed = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, { pressed: true });

        expect(pressed.backgroundColor).toBe('#123456');
    });

    it('applies the box style under the feedback fill', async () => {
        const screen = await renderSurface({ style: { borderRadius: 8, backgroundColor: '#ffffff' } });
        const resting = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, {});
        const pressed = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, { pressed: true });

        expect(resting.backgroundColor).toBe('#ffffff');
        expect(pressed.backgroundColor).toBe(lightTheme.colors.surface.selected);
        expect(pressed.borderRadius).toBe(8);
    });
});

describe('PressableSurface focus ring', () => {
    it('shows no ring when a touch or click moves focus', async () => {
        const screen = await renderSurface();

        await dispatchDom('pointerdown', {});
        await act(async () => {
            screen.findHostByTestId(SURFACE_TEST_ID)?.props.onFocus?.({});
        });

        expect(screen.findAllHostsByTestId(RING_TEST_ID)).toHaveLength(0);
    });

    it('shows the ring when the keyboard moved focus, and hides it on blur', async () => {
        const screen = await renderSurface();

        await dispatchDom('keydown', { key: 'Tab' });
        await act(async () => {
            screen.findHostByTestId(SURFACE_TEST_ID)?.props.onFocus?.({});
        });

        const ring = screen.findHostByTestId(RING_TEST_ID);
        expect(flattenStyle(ring?.props.style).borderColor).toBe(lightTheme.colors.focus.ring);
        expect(flattenStyle(ring?.props.style).opacity).toBe(1);

        await act(async () => {
            screen.findHostByTestId(SURFACE_TEST_ID)?.props.onBlur?.({});
        });

        expect(flattenStyle(screen.findHostByTestId(RING_TEST_ID)?.props.style).opacity).toBe(0);
    });

    it('drops the ring when the user goes back to the pointer while focus stays put', async () => {
        const screen = await renderSurface();

        await dispatchDom('keydown', { key: 'Tab' });
        await act(async () => {
            screen.findHostByTestId(SURFACE_TEST_ID)?.props.onFocus?.({});
        });
        expect(flattenStyle(screen.findHostByTestId(RING_TEST_ID)?.props.style).opacity).toBe(1);

        await dispatchDom('pointerdown', {});

        expect(flattenStyle(screen.findHostByTestId(RING_TEST_ID)?.props.style).opacity).toBe(0);
    });

    it('suppresses the browser outline so keyboard focus shows exactly one ring', async () => {
        const screen = await renderSurface();
        const resting = flattenStyle(screen.findHostByTestId(SURFACE_TEST_ID)?.props.style, {});

        expect(resting.outlineStyle).toBe('none');
    });

    it('creates no ring instance until a keyboard is in play', async () => {
        const screen = await renderSurface();

        // Composites, not hosts: a mounted-but-invisible ring still matches here, so this
        // distinguishes "rendered null" from "never constructed". The instance is what costs — it
        // runs a Reanimated animated style — and native never reaches keyboard modality at all.
        expect(screen.findAllByTestId(RING_TEST_ID)).toHaveLength(0);

        await dispatchDom('keydown', { key: 'Tab' });

        expect(screen.findAllByTestId(RING_TEST_ID)).toHaveLength(1);
        expect(screen.findAllHostsByTestId(RING_TEST_ID)).toHaveLength(0);
    });

    it('never rings a disabled surface', async () => {
        const screen = await renderSurface({ disabled: true });

        await dispatchDom('keydown', { key: 'Tab' });
        await act(async () => {
            screen.findHostByTestId(SURFACE_TEST_ID)?.props.onFocus?.({});
        });

        expect(screen.findAllHostsByTestId(RING_TEST_ID)).toHaveLength(0);
    });
});

describe('PressableSurface accessibility contract', () => {
    it('forwards the accessible name, role and disabled state', async () => {
        const screen = await renderSurface({ disabled: true });
        const surface = screen.findHostByTestId(SURFACE_TEST_ID);

        expect(surface?.props.accessibilityRole).toBe('button');
        expect(surface?.props.accessibilityLabel).toBe('Do the thing');
        expect(surface?.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
        expect(surface?.props.onPress).toBeUndefined();
    });
});
