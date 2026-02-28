import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setFilesDiffPresentationStyle = vi.fn();
let styleSettingValue: any = 'unified';

vi.mock('react-native', async () => await import('@/dev/reactNativeStub'));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                divider: '#ddd',
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (fn: any) => fn({
            colors: {
                divider: '#ddd',
                surfaceHigh: '#fff',
                surfaceHighest: '#fff',
                textSecondary: '#666',
            },
        }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => {
        if (key === 'filesDiffPresentationStyle') return [styleSettingValue, setFilesDiffPresentationStyle];
        return [null, vi.fn()];
    },
}));

describe('DiffPresentationStyleToggleButton', () => {
    it('toggles unified -> split', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = 'unified';
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<DiffPresentationStyleToggleButton />);
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(1);

        await act(async () => {
            pressables[0]!.props.onPress();
        });

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });

    it('defaults to unified when the setting is missing', async () => {
        setFilesDiffPresentationStyle.mockClear();
        styleSettingValue = undefined;
        const { DiffPresentationStyleToggleButton } = await import('./DiffPresentationStyleToggleButton');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<DiffPresentationStyleToggleButton />);
        });

        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(1);

        await act(async () => {
            pressables[0]!.props.onPress();
        });

        expect(setFilesDiffPresentationStyle).toHaveBeenCalledWith('split');
    });
});
