import React from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, flattenTestStyle, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let uiItemDensitySetting: 'comfortable' | 'cozy' | 'compact' = 'comfortable';

function findTextNode(screen: Pick<ReactTestRenderer | ReactTestInstance, 'findAllByType'>, text: string) {
    return findTestInstanceByTypeWithProps(screen, 'Text' as any, { children: text });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                            Platform: {
                                                OS: 'web',
                                            },
                                            View: 'View',
                                            Text: 'Text',
                                            ActivityIndicator: 'ActivityIndicator',
                                            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
                                        }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: any) => node,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'uiItemDensity') return uiItemDensitySetting;
        if (key === 'uiFontScale') return 1;
        return null;
    },
}));

describe('Item mode prop', () => {
    beforeEach(() => {
        vi.resetModules();
        uiItemDensitySetting = 'comfortable';
    });

    it('renders a Pressable when mode is undefined and onPress is set', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Test" onPress={() => {}} />);
        const pressables = screen.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);
    });

    it('renders a View (not Pressable) when mode="info" even with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info Item" mode="info" onPress={() => {}} />);
        const pressables = screen.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(0);
    });

    it('never shows chevron when mode="info" regardless of showChevron prop', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" mode="info" showChevron={true} onPress={() => {}} />);
        expect(screen.findAllByProps({ name: 'chevron-forward' })).toHaveLength(0);
    });

    it('does NOT reduce opacity when mode="info" (unlike disabled)', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Info" mode="info" />);
        const root = screen.findByType('View' as any);
        const flattened = flattenTestStyle(root.props.style);
        expect(flattened.opacity).not.toBe(0.5);
    });

    it('reduces opacity when disabled (not mode="info")', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Disabled" disabled={true} />);
        const root = screen.findByType('View' as any);
        const flattened = flattenTestStyle(root.props.style);
        expect(flattened.opacity).toBe(0.5);
    });

    it('renders a Pressable when mode="interactive" with onPress', async () => {
        const { Item } = await import('../Item');
        const screen = await renderScreen(<Item title="Interactive" mode="interactive" onPress={() => {}} />);
        const pressables = screen.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);
    });

    it('uses the middle global item density when density prop is omitted', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Compact by setting" subtitle="Subtitle" />);

        const titleNode = findTextNode(screen, 'Compact by setting');
        expect(titleNode?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 14, lineHeight: 20 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('preserves an explicit density prop over the global item density', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Explicit density" subtitle="Subtitle" density="comfortable" />);

        const titleNode = findTextNode(screen, 'Explicit density');
        expect(titleNode?.props?.style).not.toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 13, lineHeight: 18 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('applies the resolved density to right-side detail text', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Detail row" detail="Compact detail" />);

        const detailNode = findTextNode(screen, 'Compact detail');
        expect(detailNode?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ fontSize: 13, lineHeight: 18 })]));
        uiItemDensitySetting = 'comfortable';
    });

    it('forces icon prop size to the resolved density size', async () => {
        uiItemDensitySetting = 'cozy';
        const { Item } = await import('../Item');

        const screen = await renderScreen(
            <Item
                title="Density icon"
                icon={React.createElement('Ionicons', { name: 'albums-outline', size: 29, color: '#09f' })}
            />,
        );

        const leftIcon = screen.findAllByProps({ name: 'albums-outline' })[0];
        expect(leftIcon?.props?.size).toBe(24);
        uiItemDensitySetting = 'comfortable';
    });

    it('forces chevron size to the resolved density size', async () => {
        uiItemDensitySetting = 'compact';
        const { Item } = await import('../Item');

        const screen = await renderScreen(<Item title="Chevron row" onPress={() => {}} />);

        const chevronIcon = screen.findAllByProps({ name: 'chevron-forward' })[0];
        expect(chevronIcon?.props?.size).toBe(15);
        uiItemDensitySetting = 'comfortable';
    });
});
