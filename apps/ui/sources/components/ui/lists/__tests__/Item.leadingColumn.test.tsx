import React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.unmock('@/components/ui/icons/Icon');

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-svg', async () => import('@/dev/testkit/mocks/reactNativeSvg'));

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

// The canonical store-hooks stub: rows that read the active Account scope see the fixture's (none here).
vi.mock('@/sync/store/hooks', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy', uiFontScale: 1 } }) });
});

// ItemGroup renders the real GlassSurface, whose Account preferences use this storage boundary.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});
// Collect the real component graph once; cases only vary rendered props.
await import('../Item');
await import('../ItemGroup');
await import('@/components/settings/connectedServices/ConnectedServiceMark');
await import('@/agents/registry/AgentIcon');

afterEach(() => {
    standardCleanup();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The leading column a row draws: the box before its title, or null when the title starts the row. */
function leadingColumn(screen: Screen, title: string): Record<string, unknown> | null {
    const titleNode = screen.findAll((node) => node.type === ('Text' as never) && node.props.children === title)[0];
    if (!titleNode) throw new Error(`Missing row ${title}`);
    // Title → centre column → row content container; the leading column is the centre column's previous sibling.
    let centre: ReactTestInstance | null = titleNode.parent;
    while (centre && !(centre.parent && (centre.parent.children as ReactTestInstance[]).some((c) => typeof c !== 'string' && c !== centre && c.type === ('View' as never)))) {
        centre = centre.parent;
    }
    const container = centre?.parent;
    if (!centre || !container) return null;
    const siblings = (container.children as ReactTestInstance[]).filter((c) => typeof c !== 'string');
    const index = siblings.indexOf(centre);
    const previous = index > 0 ? siblings[index - 1] : null;
    return previous ? flattenTestStyle(previous.props.style) : null;
}

async function renderSection(presentation: 'page' | 'grouped', rows: ReadonlyArray<Readonly<{ title: string; withIcon: boolean }>>) {
    const { Item } = await import('../Item');
    const { ItemGroup } = await import('../ItemGroup');
    const { ListPresentationProvider } = await import('../listPresentation');
    const { View } = await import('react-native');
    return renderScreen(
        <ListPresentationProvider value={presentation}>
            <ItemGroup title="Section">
                {rows.map((row) => (
                    <Item
                        key={row.title}
                        title={row.title}
                        icon={row.withIcon ? <View testID={`${row.title}.icon`} /> : undefined}
                        onPress={() => {}}
                    />
                ))}
            </ItemGroup>
        </ListPresentationProvider>,
    );
}

describe('Item leading column (page sections)', () => {
    it('keeps a service mark mode while sizing named and unnamed numeric glyphs to the row density', async () => {
        const { Item } = await import('../Item');
        const { ItemGroup } = await import('../ItemGroup');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { ITEM_ICON_GLYPH_SIZE } = await import('../itemDensityMetrics');
        const { ConnectedServiceMark } = await import('@/components/settings/connectedServices/ConnectedServiceMark');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const { AgentIcon } = await import('@/agents/registry/AgentIcon');
        const screen = await renderScreen(
            <ListPresentationProvider value="grouped">
                <ItemGroup title="Section" density="cozy">
                    <Item testID="service.row" title="Service" icon={<ConnectedServiceMark legacyServiceId="openai" size="inline" />} />
                    <Item title="Glyph" icon={<Icon name="key" testID="named.glyph" />} />
                    <Item title="Agent" icon={<AgentIcon agentId="claude" size={29} testID="agent.glyph" />} />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const markDrawing = screen.findAllByTestId('service.row')[0]!.findAll(
            (node) => typeof node.type === 'string' && node.props.width === 16 && node.props.height === 16,
        );
        expect(markDrawing.length).toBeGreaterThan(0);
        const glyphSize = ITEM_ICON_GLYPH_SIZE.cozy;
        for (const testID of ['named.glyph', 'agent.glyph']) {
            const drawings = screen.findAllByTestId(testID).flatMap((node) => node.findAll(
                (candidate) => typeof candidate.type === 'string',
            ));
            expect(drawings.some((node) => {
                const style = flattenTestStyle(node.props.style ?? {});
                // Native SVG leaves expose dimensions; the vendor glyph boundary exposes its size.
                return (node.props.width ?? style.width ?? node.props.size) === glyphSize
                    && (node.props.height ?? style.height ?? node.props.size) === glyphSize;
            }), testID).toBe(true);
        }
    });

    it('reserves the same leading column on every row of a section in which any row has an icon', async () => {
        const { PAGE_LIST_METRICS } = await import('../pageListMetrics');
        const screen = await renderSection('page', [
            { title: 'Email and password', withIcon: true },
            { title: 'Recovery key', withIcon: false },
            { title: 'Linked Homes', withIcon: true },
        ]);
        const iconRow = leadingColumn(screen, 'Email and password');
        const bareRow = leadingColumn(screen, 'Recovery key');
        expect(iconRow).not.toBeNull();
        expect(bareRow).not.toBeNull();
        for (const column of [iconRow!, bareRow!]) {
            expect(column.width).toBe(PAGE_LIST_METRICS.rowLeadingColumnPx);
            expect(column.marginRight).toBe(PAGE_LIST_METRICS.rowLeadingGapPx);
        }
    });

    it('reserves nothing in a section without icons', async () => {
        const screen = await renderSection('page', [
            { title: 'Show thinking', withIcon: false },
            { title: 'Compact tools', withIcon: false },
        ]);
        expect(leadingColumn(screen, 'Show thinking')).toBeNull();
    });

    it('keeps an add row\'s plus in its own column without moving the titles of the rows it adds to', async () => {
        const { Item } = await import('../Item');
        const { ItemAddRow } = await import('../ItemAddRow');
        const { ItemGroup } = await import('../ItemGroup');
        const { ListPresentationProvider } = await import('../listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Setup">
                    <Item title="Step 1" onPress={() => {}} />
                    <ItemAddRow title="Add a step" onPress={() => {}} />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        expect(leadingColumn(screen, 'Step 1')).toBeNull();
        expect(leadingColumn(screen, 'Add a step')).not.toBeNull();
    });

    it('leaves grouped lists (menus, pickers) with only their own icons', async () => {
        const screen = await renderSection('grouped', [
            { title: 'Rename', withIcon: true },
            { title: 'Archive', withIcon: false },
        ]);
        expect(leadingColumn(screen, 'Rename')).not.toBeNull();
        expect(leadingColumn(screen, 'Archive')).toBeNull();
    });

    it('draws a navigation row glyph in one size and the secondary colour, and leaves a status glyph its tint', async () => {
        const { Item } = await import('../Item');
        const { ItemGroup } = await import('../ItemGroup');
        const { ListPresentationProvider } = await import('../listPresentation');
        const { PAGE_LIST_METRICS } = await import('../pageListMetrics');
        const { lightTheme } = await import('@/theme');
        const Glyph = (props: Record<string, unknown>) => React.createElement('Glyph', props);
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Section">
                    <Item title="Linked Homes" icon={<Glyph testID="nav.icon" size={29} color="#ff00aa" />} onPress={() => {}} />
                    <Item title="Offline" mode="info" icon={<Glyph testID="status.icon" size={29} color="#ffaa00" />} />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const nav = screen.findAll((node) => node.props.testID === 'nav.icon')[0]!;
        const status = screen.findAll((node) => node.props.testID === 'status.icon')[0]!;
        expect(nav.props.size).toBe(PAGE_LIST_METRICS.rowIconGlyphPx);
        expect(nav.props.color).toBe(lightTheme.colors.text.secondary);
        expect(status.props.size).toBe(PAGE_LIST_METRICS.rowIconGlyphPx);
        expect(status.props.color).toBe('#ffaa00');
    });
});
