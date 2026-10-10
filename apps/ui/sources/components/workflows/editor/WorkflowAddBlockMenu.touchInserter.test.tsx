import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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
// The pointer environment is a platform boundary: this suite is a phone browser (no hover).
vi.mock('@/utils/platform/webMobileHeuristics', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isCoarsePrimaryPointerEnvironment: () => true,
}));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

afterEach(async () => {
    await standardCleanup();
});

async function renderInserter(revealed: boolean) {
    const { WorkflowAddBlockMenu } = await import('./WorkflowAddBlockMenu');
    return renderScreen(<WorkflowAddBlockMenu variant="inserter" revealed={revealed} onAdd={() => {}} scopeLabel="Steps" testID="gap" />);
}

/** The slot that carries the inserter in the list: the nearest ancestor with the list's own margins. */
function slotOf(screen: Awaited<ReturnType<typeof renderInserter>>) {
    let node = screen.findHostByTestId('gap')?.parent ?? null;
    while (node !== null && StyleSheet.flatten(node.props.style)?.marginVertical === undefined) node = node.parent;
    return node;
}

describe('the between-block inserter under a finger (DESIGN-6 M2)', () => {
    it('keeps the gap at the document rhythm and never takes a tap while hidden', async () => {
        const screen = await renderInserter(false);
        const pressable = StyleSheet.flatten(screen.findHostByTestId('gap')!.props.style({ pressed: false }));
        const slot = slotOf(screen)!;
        const margin = Number(StyleSheet.flatten(slot.props.style)?.marginVertical);
        // The touch target stays a full target, but only the rhythm gap shows between blocks.
        expect(Number(pressable.minHeight)).toBeGreaterThanOrEqual(44);
        expect(Number(pressable.minHeight) + 2 * margin).toBeLessThan(Number(pressable.minHeight));
        expect(Number(pressable.minHeight) + 2 * margin).toBeGreaterThan(0);
        expect(slot.props.pointerEvents).toBe('none');
    });

    it('takes taps once revealed by a selection in its list', async () => {
        const screen = await renderInserter(true);
        expect(slotOf(screen)?.props.pointerEvents).toBe('auto');
    });
});
