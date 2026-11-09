import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { CapabilityRow } = await import('./CapabilityRow');
const { Pressable } = await import('react-native');

afterEach(standardCleanup);

it('keeps its action and note out of the row button when the row itself is pressable', async () => {
    const screen = await renderScreen(
        <CapabilityRow title="docx" onPress={() => {}} testID="row"
            action={<Pressable testID="action" accessibilityRole="button" />}
            note={<Pressable testID="note" accessibilityRole="button" />} />,
    );
    const row = screen.findHostByTestId('row');
    expect(row?.type).toBe('Pressable');
    const inside = ['action', 'note'].filter((id) => {
        let node = screen.findHostByTestId(id)?.parent;
        while (node) {
            if (node === row) return true;
            node = node.parent;
        }
        return false;
    });
    expect(screen.findHostByTestId('action')).toBeTruthy();
    expect(screen.findHostByTestId('note')).toBeTruthy();
    expect(inside).toEqual([]);
});
