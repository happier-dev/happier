import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemProps } from '@/components/ui/lists/Item';
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: unknown) => node,
}));

vi.mock('@/components/ui/lists/useResolvedItemDensity', () => ({
    useResolvedItemDensity: () => 'comfortable',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => ({ isFirst: true, isLast: false }),
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

function flattenStyle(style: unknown, state?: { pressed?: boolean }): Record<string, unknown> {
    const resolved = typeof style === 'function' ? (style as (s: unknown) => unknown)(state ?? {}) : style;
    return Object.assign({}, ...[resolved].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
}

async function renderRow(overrides: Partial<ItemProps> = {}) {
    const { Item } = await import('@/components/ui/lists/Item');
    return renderScreen(<Item testID="row" title="A row" onPress={() => {}} {...overrides} />);
}

describe('Item press feedback', () => {
    it('tints the row on hover and keeps the content at full strength', async () => {
        const screen = await renderRow();
        const row = () => screen.findHostByTestId('row');

        expect(flattenStyle(row()?.props.style, {}).backgroundColor).toBe('transparent');
        expect(flattenStyle(row()?.props.style, {}).opacity).toBe(1);

        await act(async () => {
            row()?.props.onHoverIn?.();
        });

        expect(flattenStyle(row()?.props.style, {}).backgroundColor).toBe(lightTheme.colors.surface.pressed);
        expect(flattenStyle(row()?.props.style, {}).opacity).toBe(1);
    });

    it('does not lower row opacity while pressed', async () => {
        const screen = await renderRow();

        expect(flattenStyle(screen.findHostByTestId('row')?.props.style, { pressed: true }).opacity).toBe(1);
    });

    it('leaves the disabled treatment alone', async () => {
        const screen = await renderRow({ disabled: true });

        expect(flattenStyle(screen.findHostByTestId('row')?.props.style, {}).opacity).toBe(0.5);
    });
});

describe('Item keyboard focus', () => {
    it('rings the row on keyboard focus, tracing its grouped corners', async () => {
        const screen = await renderRow();

        await dispatchDom('keydown', { key: 'Tab' });
        await act(async () => {
            screen.findHostByTestId('row')?.props.onFocus?.({});
        });

        const ring = flattenStyle(screen.findHostByTestId('row-focus-ring')?.props.style);
        expect(ring.borderColor).toBe(lightTheme.colors.focus.ring);
        expect(ring.borderTopLeftRadius).toBeGreaterThan(0);
        expect(ring.borderBottomLeftRadius).toBeUndefined();
    });

    it('shows no ring when the row is focused by a tap', async () => {
        const screen = await renderRow();

        await dispatchDom('pointerdown', {});
        await act(async () => {
            screen.findHostByTestId('row')?.props.onFocus?.({});
        });

        expect(screen.findAllHostsByTestId('row-focus-ring')).toHaveLength(0);
    });

    it('creates no ring instance until a keyboard is in play, so a long list pays nothing for it', async () => {
        const screen = await renderRow();

        // Composites, not hosts: a mounted-but-invisible ring still matches here, which is exactly
        // what distinguishes "rendered null" from "never constructed". The instance is what costs —
        // it runs a Reanimated animated style — and native never reaches keyboard modality at all.
        expect(screen.findAllByTestId('row-focus-ring')).toHaveLength(0);

        await dispatchDom('keydown', { key: 'Tab' });

        expect(screen.findAllByTestId('row-focus-ring')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('row-focus-ring')).toHaveLength(0);
    });
});
