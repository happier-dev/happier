// @vitest-environment jsdom

import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { WorkflowAddBlockMenu } from './WorkflowAddBlockMenu';

// Hardware queries are the browser boundary. Install before the styles read
// their touch floor at module load so the real pointer classifier runs.
const originalMatchMedia = vi.hoisted(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string): MediaQueryList => ({
        matches: query === '(pointer: coarse)' || query === '(hover: none)',
        media: query, onchange: null, addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    }) });
    return previous;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
afterAll(() => {
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
});

afterEach(async () => {
    await standardCleanup();
});

async function renderInserter(revealed: boolean) {
    return renderScreen(<WorkflowAddBlockMenu variant="inserter" revealed={revealed} onAdd={() => {}} scopeLabel="Steps" testID="gap" />);
}

/** The slot that carries the inserter in the list: the nearest ancestor that gates its taps. */
function slotOf(screen: Awaited<ReturnType<typeof renderInserter>>) {
    let node = screen.findHostByTestId('gap')?.parent ?? null;
    while (node !== null && node.props.pointerEvents === undefined) node = node.parent;
    return node;
}

describe('the between-block inserter under a finger (DESIGN-6 M2)', () => {
    it('is drawn as the document gap, reached by hit area, and never takes a tap while hidden', async () => {
        const screen = await renderInserter(false);
        const pressable = StyleSheet.flatten(screen.findHostByTestId('gap')!.props.style({ pressed: false }));
        const slot = slotOf(screen)!;
        // The inserter keeps the document's gap under every pointer: no touch-sized frame, no negative margins.
        expect(Number(pressable.minHeight)).toBeLessThan(44);
        expect(StyleSheet.flatten(slot.props.style)?.marginVertical).toBeUndefined();
        expect(slot.props.pointerEvents).toBe('none');
    });

    it('takes taps once revealed by a selection in its list', async () => {
        const screen = await renderInserter(true);
        expect(slotOf(screen)?.props.pointerEvents).toBe('auto');
    });
});
