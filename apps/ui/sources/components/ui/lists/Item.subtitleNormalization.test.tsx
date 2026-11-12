import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
    collectUnexpectedRawTextNodes,
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    renderScreen,
} from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';
import { ITEM_ICON_GLYPH_SIZE } from '@/components/ui/lists/itemDensityMetrics';

type PlatformSelectValues = Readonly<{
    default?: string;
    web?: string;
    ios?: string;
    android?: string;
}>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    unistyles: async () => {
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
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));

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
        expect(findTestInstanceByTypeWithProps(screen, 'Pressable' as any, { accessibilityRole: 'button' })).toBeUndefined();

        expect(findTestInstanceByTypeWithProps(screen, 'Icon' as any, { name: 'caret-right' })).toBeUndefined();
    });

    it('renders a chevron only when onPress is provided', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(<Item title="Title" onPress={() => {}} />);

        const pressable = findTestInstanceByTypeWithProps(screen, 'Pressable' as any, { accessibilityRole: 'button' });
        expect(pressable).toBeTruthy();

        expect(findTestInstanceByTypeWithProps(screen, 'Icon' as any, { name: 'caret-right' })).toBeTruthy();
    });

    it('wires onContextMenu on web for interactive rows', async () => {
        const { Item } = await import('./Item');

        const onContextMenu = vi.fn();
        const screen = await renderScreen(
            <Item title="Title" onPress={() => {}} onContextMenu={onContextMenu} showChevron={false} />,
        );

        const pressable = findTestInstanceByTypeWithProps(screen, 'Pressable' as any, { accessibilityRole: 'button' });
        expect(pressable).toBeTruthy();
        if (!pressable) throw new Error('Pressable not found');

        expect(typeof pressable.props.onContextMenu).toBe('function');
        pressable.props.onContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
        expect(onContextMenu).toHaveBeenCalledTimes(1);
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

    it('wraps Settings descriptions and keeps transient menu and grouped rows compact', async () => {
        const { Item, ItemSubtitleWrappingContext } = await import('./Item');

        const screen = await renderScreen(
            <ItemSubtitleWrappingContext.Provider value={true}>
                <>
                    <Item title="Title" subtitle="A longer description that should wrap" showChevron={false} />
                    <Item title="Limited title" subtitle="A Settings description with an old cap" subtitleLines={2} showChevron={false} />
                    <Item title="Menu title" subtitle="A transient menu description" rowRole="menu" showChevron={false} />
                </>
            </ItemSubtitleWrappingContext.Provider>,
        );
        const regularListScreen = await renderScreen(
            <>
                <Item title="Compact title" subtitle="A compact description" showChevron={false} />
                <Item title="Capped title" subtitle="An explicitly capped description" subtitleLines={2} showChevron={false} />
            </>,
        );

        const defaultSubtitle = findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'A longer description that should wrap',
        );
        const formerlyLimitedSubtitle = findTestInstanceByTypeContainingText(screen, 'Text', 'A Settings description with an old cap');
        const menuSubtitle = findTestInstanceByTypeContainingText(screen, 'Text', 'A transient menu description');
        const compactSubtitle = findTestInstanceByTypeContainingText(regularListScreen, 'Text', 'A compact description');
        const explicitSubtitle = findTestInstanceByTypeContainingText(regularListScreen, 'Text', 'An explicitly capped description');

        expect(defaultSubtitle?.props?.numberOfLines).toBeUndefined();
        expect(formerlyLimitedSubtitle?.props?.numberOfLines).toBeUndefined();
        expect(menuSubtitle?.props?.numberOfLines).toBe(1);
        expect(compactSubtitle?.props?.numberOfLines).toBe(1);
        expect(explicitSubtitle?.props?.numberOfLines).toBe(2);
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

        expect(findTestInstanceByTypeWithProps(screen, 'SubtitleAccessory' as any, { marker: 'chips' })).toBeTruthy();
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

    it('resizes icon-like leftElement nodes using the shared item icon density', async () => {
        const { Item } = await import('./Item');

        const screen = await renderScreen(
            <Item
                title="Title"
                leftElement={React.createElement('Icon', { name: 'house', size: 20, color: '#fff' })}
                density="comfortable"
                showChevron={false}
            />,
        );

        expect(findTestInstanceByTypeWithProps(screen, 'Icon' as any, {
            name: 'house',
            size: ITEM_ICON_GLYPH_SIZE.comfortable,
        })).toBeTruthy();
        const textWrappers = screen.findAllByType('Text' as any).filter((node) => {
            const children = node.props?.children;
            return Array.isArray(children)
                ? children.some((child) => React.isValidElement(child) && child.type === 'Icon')
                : React.isValidElement(children) && children.type === 'Icon';
        });
        expect(textWrappers).toEqual([]);
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

        const pressable = findTestInstanceByTypeWithProps(screen, 'Pressable' as any, { accessibilityRole: 'button' });
        expect(pressable).toBeTruthy();
        if (!pressable) throw new Error('Pressable not found');
        const styleFn = pressable.props.style;
        expect(typeof styleFn).toBe('function');

        const resolved = styleFn({ pressed: false });
        const styles = Array.isArray(resolved) ? resolved : [resolved];
        expect(styles.some((s: any) => s && typeof s === 'object' && s.cursor === 'not-allowed')).toBe(true);
    });
});
