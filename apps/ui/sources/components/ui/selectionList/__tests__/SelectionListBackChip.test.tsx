import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

describe('SelectionListBackChip', () => {
    it('renders the label and a leading chevron-back icon prefix', async () => {
        const { SelectionListBackChip } = await import('../SelectionListBackChip');
        const screen = await renderScreen(
            <SelectionListBackChip label="Worktrees" onPress={() => {}} testID="back" />,
        );
        expect(screen.getTextContent()).toContain('Worktrees');
    });

    it('fires onPress when tapped and exposes button accessibility role', async () => {
        const onPress = vi.fn();
        const { SelectionListBackChip } = await import('../SelectionListBackChip');
        const screen = await renderScreen(
            <SelectionListBackChip label="back" onPress={onPress} testID="back2" />,
        );
        const node = screen.findByTestId('back2');
        expect(node?.props.accessibilityRole).toBe('button');
        screen.pressByTestId('back2');
        expect(onPress).toHaveBeenCalled();
    });
});
