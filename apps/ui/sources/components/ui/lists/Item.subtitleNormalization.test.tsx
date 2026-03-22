import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    collectUnexpectedRawTextNodes,
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    renderScreen,
} from '@/dev/testkit';

type PlatformSelectValues = Readonly<{
    default?: string;
    web?: string;
    ios?: string;
    android?: string;
}>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            AppState: {
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Platform: {
                OS: 'web',
                select: (values: PlatformSelectValues) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
            },
        }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            dark: false,
            colors: {
                text: '#fff',
                textSecondary: '#aaa',
                surfacePressedOverlay: 'rgba(0,0,0,0.1)',
                surfaceSelected: 'rgba(255,255,255,0.1)',
                surfaceRipple: 'rgba(0,0,0,0.1)',
                surfaceHigh: '#222',
                surfaceHighest: '#333',
                divider: '#444',
                groupped: {
                    background: '#111',
                    chevron: '#888',
                },
            },
        },
    });
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroupSelectionContext: React.createContext(null),
}));

vi.mock('@/components/ui/lists/ItemGroupRowPosition', () => ({
    useItemGroupRowPosition: () => 'middle',
}));

vi.mock('@/components/ui/lists/itemGroupRowCorners', () => ({
    getItemGroupRowCornerRadii: () => ({}),
}));

describe('Item', () => {
    it('does not render a chevron or pressable wrapper when not interactive', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(<Item title="Title" />);

        // Non-interactive rows should not be pressable on web.
        expect(() => screen.findByType('Pressable' as any)).toThrow();

        const ionicons = screen.findAllByType('Ionicons' as any);
        expect(ionicons).toHaveLength(0);
    });

    it('renders a chevron only when onPress is provided', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(<Item title="Title" onPress={() => {}} />);

        const pressable = screen.findByType('Pressable' as any);
        expect(pressable).toBeTruthy();

        const ionicons = screen.findAllByType('Ionicons' as any);
        expect(ionicons).toHaveLength(1);
    });

    it('wraps primitive children when subtitle is a ReactNode', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                // Historically this shape can accidentally introduce raw text nodes into a <View>.
                subtitle={<>{'.'}</>}
                showChevron={false}
            />,
        );

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('renders detail even when rightElement is provided', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                subtitle="Subtitle"
                detail="Detail"
                rightElement={React.createElement('RightEl')}
                showChevron={false}
            />,
        );

        const detailNode = findTestInstanceByTypeWithProps(screen, 'Text', { children: 'Detail' });
        expect(detailNode).toBeTruthy();
    });

    it('renders subtitleAccessory below the native subtitle text', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                subtitle="Subtitle"
                subtitleAccessory={React.createElement('SubtitleAccessory', { marker: 'chips' })}
                showChevron={false}
            />,
        );

        const subtitleNode = findTestInstanceByTypeContainingText(screen, 'Text', 'Subtitle');
        expect(subtitleNode).toBeTruthy();

        expect(screen.findByProps({ marker: 'chips' })).toBeTruthy();
    });

    it('wraps primitive accessory children before rendering them inside view slots', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                icon={<>{'.'}</>}
                rightElement={<>{'.'}</>}
                showChevron={false}
            />,
        );

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });

    it('adds spacing between detail and rightElement', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                subtitle="Subtitle"
                detail="Detail"
                rightElement={React.createElement('RightEl')}
                showChevron={false}
            />,
        );

        const detailNode = findTestInstanceByTypeWithProps(screen, 'Text', { children: 'Detail' });
        expect(detailNode).toBeTruthy();

        const style = detailNode!.props?.style;
        const styles = Array.isArray(style) ? style : [style];
        const marginRight = styles.reduce((acc: number, s: any) => (s && typeof s === 'object' && typeof s.marginRight === 'number' ? s.marginRight : acc), 0);
        expect(marginRight).toBeGreaterThan(0);
    });

    it('uses a not-allowed cursor on web when disabled', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(<Item title="Title" onPress={() => {}} disabled showChevron={false} />);

        const pressable = screen.findByType('Pressable' as any);
        const styleFn = pressable.props.style;
        expect(typeof styleFn).toBe('function');

        const resolved = styleFn({ pressed: false });
        const styles = Array.isArray(resolved) ? resolved : [resolved];
        expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
    });
});
