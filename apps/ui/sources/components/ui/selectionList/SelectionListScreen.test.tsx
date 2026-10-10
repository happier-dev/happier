import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 12, right: 0, bottom: 20, left: 0 }),
}));

import { SelectionListScreen, resolveSelectionListScreenHeight } from './SelectionListScreen';
import { SelectionList } from './SelectionList';

describe('SelectionListScreen', () => {
    it('keeps the full-route host clear inside a material plane and restores its exact solid ground', async () => {
        const content = <SelectionListScreen rootStep={{ id: 'models', sections: [] }} selectedOptionId={null} onSelect={() => {}} onRequestClose={() => {}} viewportHeight={800} testID="material-screen" />;
        const screen = await renderScreen(content);
        const solid = flattenTestStyle(screen.findByTestId('material-screen')!.props.style);
        await screen.update(<HappierMaterialRoleProvider role="content" resolveMaterialColor={input => input.translucentColor ?? input.color}>{content}</HappierMaterialRoleProvider>);
        expect(flattenTestStyle(screen.findByTestId('material-screen')!.props.style)).toMatchObject({ backgroundColor: 'transparent', paddingTop: solid.paddingTop, paddingBottom: solid.paddingBottom });
        await screen.update(content);
        expect(flattenTestStyle(screen.findByTestId('material-screen')!.props.style)).toEqual(solid);
    });
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
        expect(screen.findByType(SelectionList).props).toMatchObject({
            maxHeight: 768,
            heightBehavior: 'fixedToMaxHeight',
            showsVerticalScrollIndicator: true,
            onRequestClose,
            testID: 'models-screen.list',
        });
        expect(screen.findByTestId('models-screen')).toBeTruthy();
    });
});
