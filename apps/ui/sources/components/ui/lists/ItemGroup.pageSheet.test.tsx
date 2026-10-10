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
    return { useLocalSetting: createUseLocalSettingMock({ values: { uiItemDensity: 'cozy', uiFontScale: 1 } }) };
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

describe('ItemGroup page sections render through the shared page sheet', () => {
    it('preserves Settings sheet colours and reads its explanation before the real rows', async () => {
        const { ItemGroup, Item, ListPresentationProvider, presentation } = await loadModules();
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <ItemGroup title="Appearance" description="How the app looks.">
                    <Item testID="row-a" title="Theme" />
                    <Item testID="row-b" title="Density" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const sheet = screen.findAllByType(presentation.HappierPageSheet as never)[0]!;
        // The refactor preserves the existing host sheet and hairline roles; no literal style values.
        expect(sheet.props.colors).toMatchObject({
            sheet: theme.colors.surface.sectionTint,
            sheetBorder: theme.colors.border.default,
            rowDivider: theme.colors.border.default,
        });
        expect(rowDividers(screen, ['row-a', 'row-b'])).toEqual([theme.colors.border.default, null]);
        const text = screen.getTextContent();
        expect(text.indexOf('Appearance')).toBeLessThan(text.indexOf('How the app looks.'));
        expect(text.indexOf('How the app looks.')).toBeLessThan(text.indexOf('Theme'));
        expect(text.indexOf('Theme')).toBeLessThan(text.indexOf('Density'));
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
                    <Item testID="row-a" title="Theme" />
                    <Item testID="row-b" title="Density" showDivider={false} />
                    <Item testID="row-c" title="Font" />
                    <Item testID="row-d" title="Language" />
                </ItemGroup>
            </ListPresentationProvider>,
        );
        const dividers = rowDividers(screen, ['row-a', 'row-b', 'row-c', 'row-d']);
        expect(dividers.map((color) => color !== null)).toEqual([true, false, true, false]);
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
                    <Item testID="row-a" title="Ada" />
                    <Item testID="row-b" title="Grace" />
                </ItemGroup>
                <ItemGroup virtualizedSegment={{ first: false, last: true }}>
                    <Item testID="row-c" title="Linus" />
                    <Item testID="row-d" title="Margaret" />
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
                        <Item testID="row-a" title="Review" />
                        <Item testID="row-b" title="Summarize" />
                    </HappierPageSheetGroup>
                    <HappierPageSheetGroup key="start">
                        <Item testID="row-c" title="Brief" />
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

describe('Item on a page sheet follows the whole sheet policy', () => {
    it("draws its hairline in the sheet's row divider colour, not its own", async () => {
        const { Item, presentation } = await loadModules();
        const { HappierPageSheet } = presentation;
        const colors = { sheet: 'SHEET', sheetBorder: 'SHEET_BORDER', rowDivider: 'SHEET_ROW_DIVIDER', groupDivider: 'SHEET_GROUP_DIVIDER' };
        // A flat sheet in a pane (the Work tab): grouped presentation, the sheet owns the rows' anatomy.
        const screen = await renderScreen(
            <HappierPageSheet surface="none" colors={colors} rowInsetPx={20}>
                <Item testID="row-a" title="Role" />
                <Item testID="row-b" title="Goal" />
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
