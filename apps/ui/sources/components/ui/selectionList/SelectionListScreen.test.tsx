import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const selectionListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('./SelectionList', () => ({
    SelectionList: (props: Record<string, unknown>) => {
        selectionListProps.current = props;
        return React.createElement('SelectionList', props);
    },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 12, right: 0, bottom: 20, left: 0 }),
}));

import { SelectionListScreen, resolveSelectionListScreenHeight } from './SelectionListScreen';

describe('SelectionListScreen', () => {
    it('gives SelectionList one safe-area-aware fixed viewport and delegates close', async () => {
        expect(resolveSelectionListScreenHeight({ viewportHeight: 800, topInset: 12, bottomInset: 20 })).toBe(768);
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <SelectionListScreen
                rootStep={{ id: 'models', sections: [] }}
                selectedOptionId={null}
                onSelect={() => {}}
                onRequestClose={onRequestClose}
                viewportHeight={800}
                testID="models-screen"
            />,
        );
        expect(selectionListProps.current).toMatchObject({
            maxHeight: 768,
            heightBehavior: 'fixedToMaxHeight',
            showsVerticalScrollIndicator: true,
            onRequestClose,
            testID: 'models-screen.list',
        });
        expect(screen.findByTestId('models-screen')).toBeTruthy();
    });
});
