import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: 'ItemGroup',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

describe('ActionsSettingsGroup', () => {
    it('toggles disabledActionIds when an item is pressed', async () => {
        const { ActionsSettingsGroup } = await import('./ActionsSettingsGroup');
        const setSettings = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ActionsSettingsGroup
                    settings={{ v: 1, disabledActionIds: [] }}
                    setSettings={setSettings}
                />,
            );
        });

        const items = tree!.root.findAllByType('Item');
        const review = items.find((n: any) => n.props.subtitle === 'review.start');
        expect(review).toBeTruthy();

        await act(async () => {
            review!.props.onPress?.();
        });

        expect(setSettings).toHaveBeenCalledWith({ v: 1, disabledActionIds: ['review.start'] });

        const next = setSettings.mock.calls[0]?.[0];
        setSettings.mockReset();

        await act(async () => {
            tree!.update(
                <ActionsSettingsGroup
                    settings={next}
                    setSettings={setSettings}
                />,
            );
        });

        const items2 = tree!.root.findAllByType('Item');
        const review2 = items2.find((n: any) => n.props.subtitle === 'review.start');
        await act(async () => {
            review2!.props.onPress?.();
        });

        expect(setSettings).toHaveBeenCalledWith({ v: 1, disabledActionIds: [] });
    });
});

