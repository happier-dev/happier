import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_COLLECTION_LIST_TEXT } from '@happier-dev/plugin-ui/presentation';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ITEM_ICON_BOX_SIZE, ITEM_ICON_MARGIN_RIGHT, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';
import { useUnistyles } from 'react-native-unistyles';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

// Source graph loading belongs to suite setup, outside the interaction deadline.
const { CollectionList, CollectionNavigationRow } = await import('./CollectionList');
const { Item } = await import('@/components/ui/lists/Item');
const { Text } = await import('@/components/ui/text/Text');
const { Pressable } = await import('react-native');

/**
 * Core navigation rows are compact `Item`s; a plugin's `NavigationList.Row` is drawn by plugin-ui's
 * row owner from the list anatomy's metrics. The two must land glyphs and titles on the same x and
 * the same type step, or a plugin column visibly drifts from the Settings and Plugins columns.
 */
describe('navigation row parity between core and the plugin list anatomy', () => {
    it('uses the nested content coat for page rails and leaves shell-plane rails clear', async () => {
        let pageColor = '';
        function Rails() {
            pageColor = useUnistyles().theme.colors.surface.base;
            return React.createElement(React.Fragment, null,
                React.createElement(CollectionList, { testID: 'page-rail', title: 'Credentials' }),
                React.createElement(CollectionList, { testID: 'plane-rail', title: 'Projects', surface: 'plane' }));
        }
        const screen = await renderScreen(React.createElement(Rails));
        const ground = (testID: string) => screen.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!;
        expect(readSurfaceStyleProperty(ground('page-rail').props.style, 'backgroundColor'))
            .toBe(glassSurfaceBackgroundColor(pageColor, 'content', true));
        expect(readSurfaceStyleProperty(ground('plane-rail').props.style, 'backgroundColor')).toBe('transparent');
    });

    // Owner 2026-11-15 (A4): the Machines column painted the page ground behind itself while every other column lay
    // on the plane. The shell's column decides it once for whichever list stands in it.
    it('lays a list standing in the shell column on the plane unless it names its own surface', async () => {
        const { CollectionShellColumnSurfaceContext } = await import('./CollectionList');
        let pageColor = '';
        function Column() {
            pageColor = useUnistyles().theme.colors.surface.base;
            return React.createElement(CollectionShellColumnSurfaceContext.Provider, { value: 'plane' },
                React.createElement(CollectionList, { testID: 'column-list', title: 'Machines' }),
                React.createElement(CollectionList, { testID: 'named-page', title: 'Credentials', surface: 'page' }));
        }
        const screen = await renderScreen(React.createElement(Column));
        const ground = (testID: string) => screen.findAll(node => typeof node.type === 'string' && node.props.testID === testID)[0]!;
        expect(readSurfaceStyleProperty(ground('column-list').props.style, 'backgroundColor')).toBe('transparent');
        expect(readSurfaceStyleProperty(ground('named-page').props.style, 'backgroundColor'))
            .toBe(glassSurfaceBackgroundColor(pageColor, 'content', true));
    });

    // SHELL-ACCEPT-1117: the Machines column's selected Overview (a core Item) kept the regular weight while every
    // navigation row's selected title is semibold. One selected-row treatment in a column.
    it('weights a selected Item in a column like a selected navigation row', async () => {
        const { StyleSheet } = await import('react-native');
        const titleWeight = (screen: Awaited<ReturnType<typeof renderScreen>>, title: string) => {
            const node = screen.root.findAll((candidate) => candidate.type === Text && candidate.props.children === title)[0]!;
            const flat = StyleSheet.flatten(node.props.style) ?? {};
            // The weight is carried by the face and its weight together (`Typography.default`).
            return `${String(flat.fontFamily)}/${String(flat.fontWeight)}`;
        };
        const screen = await renderScreen(React.createElement(CollectionList, { testID: 'column', title: 'Machines' },
            React.createElement(Item, { testID: 'item-selected', title: 'Overview', selected: true, onPress: () => {} }),
            React.createElement(Item, { testID: 'item-resting', title: 'Defaults', selected: false, onPress: () => {} }),
            React.createElement(CollectionNavigationRow, { testID: 'nav-selected', title: 'Agents', selected: true, onPress: () => {} })));
        expect(titleWeight(screen, 'Overview')).toBe(titleWeight(screen, 'Agents'));
        expect(titleWeight(screen, 'Overview')).not.toBe(titleWeight(screen, 'Defaults'));
    });

    // UI refinements ruling 2026-11-16 (A5): every column's search waits behind the magnifier beside "+", Settings'
    // included. The shell column decides it once; no column names its own default.
    it('keeps the search of a list standing in the shell column behind its magnifier until pressed', async () => {
        const { CollectionShellColumnSurfaceContext } = await import('./CollectionList');
        const search = { value: '', onChangeText: () => {}, placeholder: 'Search settings', testID: 'column-search' };
        const screen = await renderScreen(React.createElement(CollectionShellColumnSurfaceContext.Provider, { value: 'plane' },
            React.createElement(CollectionList, { testID: 'column-list', title: 'Settings', search })));
        expect(screen.findByTestId('column-search')).toBeNull();
        await screen.pressByTestIdAsync('column-search:toggle');
        expect(screen.findByTestId('column-search')).not.toBeNull();
    });

    // Owner 2026-11-11 (desktop #13 / OWNER-1334-ROWS 05): the Settings sidebar's selected row painted an opaque
    // brownish chip on glass while hover was translucent. A selected navigation row resolves through the plane's material.
    it('fills a selected navigation row through the containing material, never the raw opaque chip', async () => {
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const glass = 'rgba(235, 230, 225, 0.1)';
        const screen = await renderScreen(React.createElement(HappierMaterialRoleProvider, { role: 'sidebar', resolveMaterialColor: () => glass },
            React.createElement(CollectionNavigationRow, { title: 'Agents', selected: true, onPress: () => {}, testID: 'nav-selected' })));
        const pressable = screen.root.findAll(node => node.type === Pressable)[0]!;
        const style = typeof pressable.props.style === 'function' ? pressable.props.style({ pressed: false, hovered: false }) : pressable.props.style;
        const fills = [style].flat(Infinity).filter(Boolean).map((entry: Record<string, unknown>) => entry.backgroundColor).filter(value => value !== undefined);
        expect(fills.at(-1)).toBe(glass);
    });

    it('keeps described navigation compact and lets explicitly declared catalog records grow', async () => {
        const title = 'A long translated capability name that identifies the account';
        const described = await renderScreen(React.createElement(CollectionNavigationRow, {
            title, subtitle: 'Issues and pull requests.', count: 41, selected: false, onPress: () => {}, testID: 'described',
        }));
        const titleHosts = described.findAll(node => typeof node.type === 'string' && node.props.children === title
            && node.props['aria-hidden'] !== true && node.props.accessibilityElementsHidden !== true);
        expect(titleHosts.length).toBeGreaterThan(0);
        expect(described.findAllByType(Item)[0]!.props.rowRole).toBe('item');
        expect(titleHosts.every(node => node.props.numberOfLines === 1)).toBe(true);
        const catalog = await renderScreen(React.createElement(Item, {
            title, subtitle: 'Issues and pull requests.', rowRole: 'catalogRow', onPress: () => {}, testID: 'catalog',
        }));
        expect(catalog.findAllByType(Item)[0]!.props.rowRole).toBe('catalogRow');
        expect(catalog.findAll(node => typeof node.type === 'string' && node.props.children === title)
            .every(node => node.props.numberOfLines !== 1)).toBe(true);
    });

    it('draws a catalog record in a column on the column row: one-line name, its meta on the description line', async () => {
        const title = 'Acme internal gateway — EU staging';
        const screen = await renderScreen(React.createElement(CollectionList, { testID: 'rail', title: 'Providers' },
            React.createElement(Item, {
                title, subtitle: 'Off · API key', titleMeta: '2 saved models', rowRole: 'catalogRow', density: 'compact',
                onPress: () => {}, testID: 'row',
            })));
        const titleHosts = screen.findAll(node => typeof node.type === 'string' && node.props.children === title
            && node.props['aria-hidden'] !== true && node.props.accessibilityElementsHidden !== true);
        expect(titleHosts.length).toBeGreaterThan(0);
        expect(titleHosts.every(node => node.props.numberOfLines === 1)).toBe(true);
        // The meta follows the description on its line; nothing is measured out of flow to place it.
        expect(screen.findAll(node => typeof node.type === 'string' && node.props.children === '\u00A0· 2 saved models'))
            .not.toHaveLength(0);
    });

    it('keeps a described tree row count and independent menu inside the compact row', async () => {
        const open = vi.fn();
        const menu = vi.fn();
        const screen = await renderScreen(React.createElement(CollectionNavigationRow, {
            testID: 'tree-row', title: 'Project checkout', subtitle: '~/src/project', count: 12,
            accessibilityLabel: 'Project checkout, 12 checkouts',
            treeItem: { webRole: 'treeitem' }, selected: false, onPress: open,
            rightElement: React.createElement(Pressable, { testID: 'tree-menu', onPress: menu },
                React.createElement(Text, null, 'Menu')),
        }));
        const item = screen.findAllByType(Item)[0]!;
        expect(item.props.rowRole).toBe('item');
        const primary = screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'tree-row')[0]!;
        expect(primary.props.accessibilityLabel).toContain('~/src/project');
        // Independent activation stays outside the primary press, in the same owning row container.
        expect(primary.findAll(node => node.props.testID === 'tree-menu')).toHaveLength(0);
        const row = screen.findAll(node => typeof node.type === 'string' && node !== primary
            && node.findAll(child => child === primary).length > 0
            && node.findAll(child => child.props.testID === 'tree-menu').length > 0)[0];
        expect(row).toBeDefined();
        expect(row!.findAll(node => typeof node.type === 'string' && node.props.children === '12')).not.toHaveLength(0);
        expect(row!.findAll(node => typeof node.type === 'string' && node.props.testID === 'tree-menu')).toHaveLength(1);
        await screen.pressByTestIdAsync('tree-menu');
        expect(menu).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('tree-row');
        expect(open).toHaveBeenCalledOnce();
    });

    it('splits a tree parent: the row opens, its trailing chevron alone discloses, and its mark keeps the leading edge', async () => {
        const open = vi.fn();
        const toggle = vi.fn();
        const mark = React.createElement(Text, { testID: 'parent-mark' }, 'P');
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(CollectionNavigationRow, {
                testID: 'parent', title: 'Project', count: 12, icon: mark, selected: false, onPress: open,
                disclosure: { expanded: false, onToggle: toggle },
            }),
            React.createElement(CollectionNavigationRow, {
                testID: 'leaf', title: 'Checkout', icon: React.createElement(Text, { testID: 'leaf-mark' }, 'L'),
                selected: false, onPress: () => {}, disclosure: null,
            })));
        const primary = screen.findAll(node => typeof node.type === 'string' && node.props.testID === 'parent')[0]!;
        // The chevron is its own target outside the row's press; a leaf draws none and reserves nothing.
        expect(primary.findAll(node => node.props?.testID === 'parent:disclosure')).toHaveLength(0);
        expect(screen.findAll(node => node.props?.testID === 'parent:disclosure').length).toBeGreaterThan(0);
        expect(screen.findAll(node => node.props?.testID === 'leaf:disclosure')).toHaveLength(0);
        // At rest and under hover the parent's leading box holds its own mark, never a chevron.
        const item = screen.findAllByType(Item)[0]!;
        expect(item.props.leftElementWhenHovered).toBeUndefined();
        await screen.pressByTestIdAsync('parent:disclosure');
        expect(toggle).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('parent');
        expect(open).toHaveBeenCalledOnce();
        expect(toggle).toHaveBeenCalledOnce();
    });

    it('shares the compact row glyph column, gap and title step', () => {
        expect(HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox).toBe(ITEM_ICON_BOX_SIZE.compact);
        expect(HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap).toBe(ITEM_ICON_MARGIN_RIGHT.compact);
        expect(HAPPIER_COLLECTION_LIST_TEXT.rowTitle.fontSize).toBe(ITEM_TITLE_TEXT_METRICS.compact.fontSize);
        expect(HAPPIER_COLLECTION_LIST_TEXT.rowTitle.lineHeight).toBe(ITEM_TITLE_TEXT_METRICS.compact.lineHeight);
    });
});
