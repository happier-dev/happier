import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

// Hoisted so the shared presentation layer and this file bind the same react-native (see Item.webTestId.test.tsx).
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The user's list density is a stored local setting (storage boundary); the density owner itself runs.
vi.mock('@/sync/store/hooks', async () => {
    const { createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return {
        useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy', uiFontScale: 1 } }),
        // No signed-in Account at this boundary: list rows that read the active scope see none.
        useActiveServerAccountScope: () => null,
        // A row's mounted Action approvals name a known Account actor; none is known here.
        useUser: () => null,
    };
});

// Supply the persisted preference at the storage boundary; exercise the real page-width owner.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createUseLocalSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: createUseLocalSettingMock({ values: { uiContentWidthMode: 'compact' } }),
    });
});

vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const storage = createStorageStoreMock({});
    return { storage, getStorage: () => storage };
});

afterEach(() => {
    standardCleanup();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/** The row hairlines drawn under the rows, in render order. */
function rowDividers(screen: Screen, rowTestIds: readonly string[]): Array<string | null> {
    return rowTestIds.map((testID) => {
        const row = screen.findAllByTestId(testID).find((node) => typeof node.type === 'string');
        if (!row) throw new Error(`Missing row ${testID}`);
        const separator = row.findAll((node) => typeof node.type === 'string' && node.props.role === 'separator')[0];
        return separator ? String(flattenTestStyle(separator.props.style).backgroundColor) : null;
    });
}

/**
 * The vertical space a section draws above its content: the top padding and margin of every host box between the
 * section's root and the content (its own spacer views included), as the page lays it out.
 */
function spaceAbovePx(screen: Screen, sectionTestID: string, contentTestID: string): number {
    const section = screen.findAllByTestId(sectionTestID).find((node) => typeof node.type === 'string');
    const content = screen.findAllByTestId(contentTestID).find((node) => typeof node.type === 'string');
    if (!section || !content) throw new Error(`Missing ${sectionTestID} or ${contentTestID}`);
    const top = (node: ReactTestInstance) => { const style = flattenTestStyle(node.props.style);
        const read = (value: unknown) => (typeof value === 'number' ? value : 0);
        return read(style.paddingTop ?? style.paddingVertical ?? style.padding) + read(style.marginTop ?? style.marginVertical ?? style.margin); };
    let total = 0;
    const walk = (node: ReactTestInstance): boolean => {
        if (node === content) return true;
        if (typeof node.type === 'string') total += top(node);
        for (const child of node.children) {
            if (typeof child === 'string') continue;
            if (walk(child)) return true;
        }
        return false;
    };
    walk(section);
    return total;
}

/** How far a node's leading edge sits from the scope's edge: the sum of the leading margins of it and its host ancestors. */
function leadingOffsetPx(screen: Screen, testID: string): number {
    let node: ReactTestInstance | null = screen.findAllByTestId(testID).find((candidate) => typeof candidate.type === 'string') ?? null;
    if (!node) throw new Error(`Missing ${testID}`);
    let offset = 0;
    for (; node; node = node.parent) {
        if (typeof node.type !== 'string') continue;
        const style = flattenTestStyle(node.props.style);
        const leading = style.marginLeft ?? style.marginStart ?? style.marginHorizontal ?? style.margin;
        if (typeof leading === 'number') offset += leading;
    }
    return offset;
}

function sheetSeparators(sheet: ReactTestInstance): ReactTestInstance[] {
    // Group separation is observable by its published colour, independently of material wrappers.
    return sheet.findAll((node) => typeof node.type === 'string' && node.props.role === 'separator'
        && flattenTestStyle(node.props.style).backgroundColor === sheet.props.colors.groupDivider);
}

async function importModules() {
    const [{ ItemGroup }, { Item }, { ListPresentationProvider }, presentation, rowPosition] = await Promise.all([
        import('./ItemGroup'),
        import('./Item'),
        import('./listPresentation'),
        import('@happier-dev/plugin-ui/presentation'),
        import('./ItemGroupRowPosition'),
    ]);
    return { ItemGroup, Item, ListPresentationProvider, presentation, rowPosition };
}

// Resolve the real component graph during collection, as WorkSection.test does. Cold source transforms
// are runner preparation, not a beforeAll operation subject to the hook execution budget.
const modules = await importModules();

async function loadModules() {
    return modules;
}

// Rows here carry a second line: a sheet rules only two-line rows (owner 2026-11-17 23:52Z), so these seam tests use them.
describe('ItemGroup page sections render through the shared page sheet', () => {
    it('draws a Settings section as the W3 card, with subtle row seams, and reads its explanation before the real rows', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Appearance" description="How the app looks.">
                    <Item testID="row-a" title="Theme" subtitle="Second line" />
                    <Item testID="row-b" title="Density" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const sheet = screen.findAllByType(presentation.HappierPageSheet as never)[0]!;
        // One card treatment (P7-R1): the card fill, the card's own lip and grounding; seams in the divider ink.
        expect(sheet.props.colors).toMatchObject({
            sheet: theme.colors.edge.cardFill,
            sheetBorder: theme.colors.border.default,
            rowDivider: theme.colors.border.subtle,
        });
        const paints = sheet.findAll((node) => typeof node.type === 'string').map((node) => flattenTestStyle(node.props.style));
        expect(paints.some((style) => style.backgroundColor === theme.colors.edge.cardFill)).toBe(true);
        expect(paints.some((style) => style.borderBottomColor === theme.colors.edge.surface
            && style.boxShadow === theme.colors.shadowCard.boxShadow)).toBe(true);
        expect(rowDividers(screen, ['row-a', 'row-b'])).toEqual([theme.colors.border.subtle, null]);
        const text = screen.getTextContent();
        expect(text.indexOf('Appearance')).toBeLessThan(text.indexOf('How the app looks.'));
        expect(text.indexOf('How the app looks.')).toBeLessThan(text.indexOf('Theme'));
        expect(text.indexOf('Theme')).toBeLessThan(text.indexOf('Density'));
    });

    // QA-RERUN-1113 F7: a section whose only row is conditional and absent keeps its title and description,
    // but draws no empty sheet (an empty card reads as a stray rule).
    it('draws no sheet for a page section with no rows', async () => {
        const { ItemGroup, ListPresentationProvider, presentation } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="What you're trusting" description="Where it comes from.">
                    {null}
                    {false}
                </ItemGroup>
            </ListPresentationProvider>,
        );
        expect(screen.findAllByType(presentation.HappierPageSheet as never)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('Where it comes from.');
    });

    it('lays a page section on one HappierPageSheet, so its rows take the sheet policy', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Appearance">
                    <Item testID="row-a" title="Theme" />
                    <Item testID="row-b" title="Density" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const sheets = screen.findAllByType(presentation.HappierPageSheet as never);
        expect(sheets).toHaveLength(1);
        expect(sheets[0]!.findAllByProps({ testID: 'row-a' }).length).toBeGreaterThan(0);
        expect(sheets[0]!.findAllByProps({ testID: 'row-b' }).length).toBeGreaterThan(0);
    });

    it('keeps menus, pickers and sheets (grouped presentation) off the page sheet', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="grouped">
                <ItemGroup title="Appearance">
                    <Item testID="row-a" title="Theme" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        expect(screen.findAllByType(presentation.HappierPageSheet as never)).toHaveLength(0);
    });

    it('divides rows on the sheet: every row but the last, an explicit opt-out kept', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Appearance">
                    <Item testID="row-a" title="Theme" subtitle="Second line" />
                    <Item testID="row-b" title="Density" subtitle="Second line" showDivider={false} />
                    <Item testID="row-c" title="Font" subtitle="Second line" />
                    <Item testID="row-d" title="Language" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b', 'row-c', 'row-d']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false, true, false]);
    });

    // Owner ruling 2026-11-17 23:52Z (DESIGN.md 2026-11-15 "One list-row rule"), sheets included (DBW ORCH O10): a sheet
    // row is ruled only when it has two or more lines; a one-line row parts from the next by its height alone.
    it('rules only the two-line rows of a sheet, never a one-line row', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Profile & account">
                    <Item testID="row-a" title="Account" subtitle="Manage your account details" />
                    <Item testID="row-b" title="Theme" />
                    <Item testID="row-c" title="Usage" subtitle="Tokens and costs" />
                    <Item testID="row-d" title="Machines" subtitle="36 offline" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b', 'row-c', 'row-d']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false, true, false]);
    });

    it('draws no hairline under the last row when a row component does not forward the divider prop', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        // A domain row that wraps Item without accepting `showDivider` (settings rows built elsewhere).
        const WrappedRow = (props: Readonly<{ testID: string; title: string }>) => <Item testID={props.testID} title={props.title} subtitle="Second line" />;
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Connection">
                    <WrappedRow testID="row-a" title="Name" />
                    <WrappedRow testID="row-b" title="Show in model picker" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false]);
    });

    it('draws no hairline under the last row of a bare group, so a panel footer below it keeps the only line', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        // A flow panel's choices (Network access): rows without the group's card, its footer rule beneath.
        const screen = await renderScreen(
            <ListPresentationProvider value="page" pageInsets="contained">
                <ItemGroup surface="none" density="compact" header="none">
                    <Item testID="row-a" title="Can contact" subtitle="Second line" />
                    {null}
                    <Item testID="row-b" title="Sites" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false]);
    });

    it('bleeds only the rows of a bare section in a contained scope: tiles and notes stay inside the column', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const { View } = await import('react-native');
        const { SectionContentRow } = await import('./SectionContentRow');
        // Personalize's Look step: visual tiles and a note in a bare section, in a column that clips at its edge.
        const screen = await renderScreen(
            <ListPresentationProvider value="page" pageInsets="contained">
                <ItemGroup title="Glass" surface="none">
                    <View testID="tiles" />
                    <Item testID="row" title="Download desktop app" />
                    <SectionContentRow testID="content-row"><View /></SectionContentRow>
                    <View testID="note" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const rowInsetPx = presentation.HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;
        expect({
            row: leadingOffsetPx(screen, 'row'),
            contentRow: leadingOffsetPx(screen, 'content-row'),
            tiles: leadingOffsetPx(screen, 'tiles'),
            note: leadingOffsetPx(screen, 'note'),
        }).toEqual({ row: -rowInsetPx, contentRow: -rowInsetPx, tiles: 0, note: 0 });
    });

    it('stands a bare page section\'s rows on its content edge, where its tiles and its heading stand', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const { View } = await import('react-native');
        const { SectionContentRow } = await import('./SectionContentRow');
        const { BareSectionLineEdge } = await import('./listPresentation');
        // Themes: a section of tiles, then a quiet Store row in a sheetless section; the row's glyph and chevron
        // take the edges the tiles take, its fill reaching into the margin like a flat sheet's rows.
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Dark themes" surface="none">
                    <View testID="tiles" />
                    <Item testID="row" title="More themes in the Store" />
                    <SectionContentRow testID="content-row"><View /></SectionContentRow>
                    <BareSectionLineEdge><View testID="line" /></BareSectionLineEdge>
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const metrics = presentation.HAPPIER_PAGE_METRICS;
        const tiles = leadingOffsetPx(screen, 'tiles');
        // Each row box reaches out by its inset less the heading's optical inset, so its padded content starts on the heading.
        const rowBleed = metrics.headingOpticalInsetPx - metrics.rowPaddingHorizontalPx;
        expect({
            row: leadingOffsetPx(screen, 'row') - tiles,
            contentRow: leadingOffsetPx(screen, 'content-row') - tiles,
            line: leadingOffsetPx(screen, 'line') - tiles,
        }).toEqual({ row: rowBleed, contentRow: rowBleed, line: rowBleed });
    });

    it('starts an untitled page section one section gap below a banner, and leaves a header="none" section\'s space to its container', async () => {
        const { ItemGroup, ListPresentationProvider } = await loadModules();
        const { View } = await import('react-native');
        // Environment Overview: the attention banner (an untitled page block), then the Serving card, then the facts
        // under it whose own gap the page sets (`header="none"`).
        const page = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup testID="banner" surface="none"><View testID="banner-body" /></ItemGroup>
                <ItemGroup testID="serving"><View testID="serving-body" /></ItemGroup>
                <ItemGroup testID="facts" header="none" surface="none"><View testID="facts-body" /></ItemGroup>
            </ListPresentationProvider>,
        );
        expect(spaceAbovePx(page, 'serving', 'serving-body')).toBe(spaceAbovePx(page, 'banner', 'banner-body'));
        expect(spaceAbovePx(page, 'serving', 'serving-body')).toBeGreaterThan(0);
        expect(spaceAbovePx(page, 'facts', 'facts-body')).toBe(0);
    });

    it('hands each row its position in the section, so a highlighted first or last row follows the sheet corners', async () => {
        const { ItemGroup, ListPresentationProvider, rowPosition } = await loadModules();
        const seen: Array<unknown> = [];
        function Probe(props: Readonly<{ name: string; showDivider?: boolean }>) {
            seen.push({ name: props.name, position: rowPosition.useItemGroupRowPosition() });
            return null;
        }
        await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Appearance">
                    <Probe name="a" />
                    <>
                        <Probe name="b" />
                        <Probe name="c" />
                    </>
                </ItemGroup>
            </ListPresentationProvider>,
        );
        expect(seen.slice(-3)).toEqual([
            { name: 'a', position: { isFirst: true, isLast: false } },
            { name: 'b', position: { isFirst: false, isLast: false } },
            { name: 'c', position: { isFirst: false, isLast: true } },
        ]);
    });

    it('joins virtualized chunks into one sheet: a chunk that continues keeps the hairline under its last row', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Members" virtualizedSegment={{ first: true, last: false }}>
                    <Item testID="row-a" title="Ada" subtitle="Second line" />
                    <Item testID="row-b" title="Grace" subtitle="Second line" />
                </ItemGroup>
                <ItemGroup virtualizedSegment={{ first: false, last: true }}>
                    <Item testID="row-c" title="Linus" subtitle="Second line" />
                    <Item testID="row-d" title="Margaret" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b', 'row-c', 'row-d']);
        expect(dividers.map((color) => color !== null)).toEqual([true, true, true, false]);
    });

    it('gives core pages HappierPageSheetGroup: a light separator between groups, no hairline after a group', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const { HappierPageSheet, HappierPageSheetGroup } = presentation;
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Triggers">
                    <HappierPageSheetGroup key="turn">
                        <Item testID="row-a" title="Review" subtitle="Second line" />
                        <Item testID="row-b" title="Summarize" subtitle="Second line" />
                    </HappierPageSheetGroup>
                    <HappierPageSheetGroup key="start">
                        <Item testID="row-c" title="Brief" subtitle="Second line" />
                    </HappierPageSheetGroup>
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const sheet = screen.findAllByType(HappierPageSheet as never)[0]!;
        expect(sheetSeparators(sheet)).toHaveLength(1);
        const dividers = rowDividers(screen, ['row-a', 'row-b', 'row-c']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false, false]);
    });
});

/** Where each row's hairline runs, as logical insets from the sheet's start and end edges. */
function rowSeams(screen: Screen, rowTestIds: readonly string[]): Array<{ start: unknown; end: unknown } | null> {
    return rowTestIds.map((testID) => {
        const row = screen.findAllByTestId(testID).find((node) => typeof node.type === 'string');
        if (!row) throw new Error(`Missing row ${testID}`);
        const separator = row.findAll((node) => typeof node.type === 'string' && node.props.role === 'separator')[0];
        if (!separator) return null;
        const style = flattenTestStyle(separator.props.style);
        return { start: style.marginStart, end: style.marginEnd };
    });
}

describe('Page row seams start at the text and run to the sheet trailing edge (P7-R2)', () => {
    it('insets every seam of a section that reserves the leading column at its titles, mixed icon and plain rows alike', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
        const glyph = React.createElement('View');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Team">
                    <Item testID="row-a" title="Members" subtitle="Second line" icon={glyph} />
                    <Item testID="row-b" title="Groups" subtitle="Second line" />
                    <Item testID="row-c" title="Invitations" subtitle="Second line" icon={glyph} />
                </ItemGroup>
                <ItemGroup title="Team settings">
                    <Item testID="row-d" title="Team name" subtitle="Second line" />
                    <Item testID="row-e" title="Let members invite people" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const inset = PAGE_LIST_METRICS.rowPaddingHorizontalPx;
        const text = inset + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx;
        expect(rowSeams(screen, ['row-a', 'row-b', 'row-c'])).toEqual([{ start: text, end: 0 }, { start: text, end: 0 }, null]);
        expect(rowSeams(screen, ['row-d', 'row-e'])).toEqual([{ start: inset, end: 0 }, null]);
    });

    it('lays an index section flat on the page: no card fill, lip or grounding, the same text-inset seams', async () => {
        const { ItemGroup, Item, ListPresentationProvider } = await loadModules();
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Machines" surface="none">
                    <Item testID="row-a" title="Studio" subtitle="Second line" />
                    <Item testID="row-b" title="Build box" subtitle="Second line" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const paints = screen.findAllByType('View' as never).map((node) => flattenTestStyle(node.props.style));
        expect(paints.some((style) => style.backgroundColor === theme.colors.edge.cardFill)).toBe(false);
        expect(paints.some((style) => style.borderBottomColor === theme.colors.edge.surface)).toBe(false);
        expect(paints.some((style) => style.boxShadow === theme.colors.shadowCard.boxShadow)).toBe(false);
        const inset = PAGE_LIST_METRICS.rowPaddingHorizontalPx;
        expect(rowSeams(screen, ['row-a'])).toEqual([{ start: inset, end: 0 }]);
        expect(rowDividers(screen, ['row-a'])).toEqual([theme.colors.border.subtle]);
    });
});

describe('Item on a page sheet follows the whole sheet policy', () => {
    it("draws its hairline in the sheet's row divider colour, not its own", async () => {
        const { Item, presentation } = await loadModules();
        const { HappierPageSheet } = presentation;
        const colors = { sheet: 'SHEET', sheetBorder: 'SHEET_BORDER', rowDivider: 'SHEET_ROW_DIVIDER', groupDivider: 'SHEET_GROUP_DIVIDER' };
        // A flat sheet in a pane (the Work tab): grouped presentation, the sheet owns the rows' anatomy.
        const screen = await renderScreen(
            <HappierPageSheet surface="none" colors={colors} rowInsetPx={20}>
                <Item testID="row-a" title="Role" subtitle="Second line" />
                <Item testID="row-b" title="Goal" subtitle="Second line" />
            </HappierPageSheet>,
        );
        expect(rowDividers(screen, ['row-a', 'row-b'])).toEqual(['SHEET_ROW_DIVIDER', null]);
    });

    it('leaves the sheet behind in a floating surface or picker opened from a sheet row', async () => {
        const { Item, ListPresentationProvider, presentation } = await loadModules();
        const { HappierPageSheet, useHappierPageSection } = presentation;
        const colors = { sheet: 'SHEET', sheetBorder: 'SHEET_BORDER', rowDivider: 'SHEET_ROW_DIVIDER', groupDivider: 'SHEET_GROUP_DIVIDER' };
        const seen: Array<unknown> = [];
        function Probe() {
            seen.push(useHappierPageSection());
            return null;
        }
        const screen = await renderScreen(
            <HappierPageSheet colors={colors}>
                <ListPresentationProvider value="grouped">
                    <Probe />
                    <Item testID="menu-a" title="Copy" />
                    <Item testID="menu-b" title="Rename" />
                </ListPresentationProvider>
            </HappierPageSheet>,
        );
        expect(seen.at(-1)).toBeNull();
        expect(rowDividers(screen, ['menu-a'])[0]).not.toBe('SHEET_ROW_DIVIDER');
    });
});
