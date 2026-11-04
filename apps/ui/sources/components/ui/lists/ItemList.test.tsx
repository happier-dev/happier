import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ItemListProps, ItemListStaticProps } from './ItemList';
import type { ItemGroupProps } from './ItemGroup';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';
import { readSurfaceStyleProperty } from '@/components/ui/surfaces/surfaceStyle';

type Assert<Condition extends true> = Condition;
type _PageGroupsHaveNoFooterOptions = Assert<
    Extract<keyof ItemGroupProps, 'footer' | 'footerStyle' | 'footerTextStyle'> extends never ? true : false
>;
type _ListsHaveNoSupersededInsetOption = Assert<
    Extract<keyof ItemListProps | keyof ItemListStaticProps, 'insetGrouped'> extends never ? true : false
>;
type _StaticPickerCannotBecomeAPage = Assert<
    'page' extends NonNullable<ItemListStaticProps['presentation']> ? false : true
>;

vi.mock('@/components/ui/keyboardAvoidance/KeyboardAwareScrollView', () => ({
    KeyboardAwareScrollView: React.forwardRef<unknown, React.PropsWithChildren<{
        keyboardShouldPersistTaps?: unknown;
    }>>(
        function MockKeyboardAwareScrollView(props, _ref) {
            return React.createElement('KeyboardAwareScrollView', props, props.children);
        },
    ),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('ItemList', () => {
    it('frames page children as one named column, while grouped scroll content stays unframed', async () => {
        const { ItemList } = await import('./ItemList');
        const { PAGE_COLUMN_MAX_WIDTH_PX } = await import('../layout/contentWidthMode');
        const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        const { useLayoutMaxWidth } = await import('../layout/layout');
        function WidthProbe() {
            return React.createElement('WidthProbe', { maxWidth: useLayoutMaxWidth() });
        }
        const page = await renderScreen(<ItemList pageColumn="wide"><WidthProbe /></ItemList>);
        const grouped = await renderScreen(<ItemList presentation="grouped"><React.Fragment>Picker body</React.Fragment></ItemList>);
        const pageColumn = page.findByTestId('page-frame');
        expect(pageColumn).not.toBeNull();
        expect(page.findByType('WidthProbe').props.maxWidth).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);
        // The header measures the full pane to place Back in its gutter; its own inner column caps it.
        expect(readSurfaceStyleProperty(pageColumn!.props.style, 'maxWidth')).toBeUndefined();
        expect(readSurfaceStyleProperty(pageColumn!.props.style, 'paddingHorizontal')).toBeUndefined();
        expect(readSurfaceStyleProperty(pageColumn!.props.style, 'paddingTop')).toBeUndefined();
        const frameBottom = readSurfaceStyleProperty(pageColumn!.props.style, 'paddingBottom');
        const scrollBottom = readSurfaceStyleProperty(page.findByType('ScrollView').props.contentContainerStyle, 'paddingBottom');
        expect(Number(frameBottom ?? 0) + Number(scrollBottom ?? 0)).toBe(HAPPIER_PAGE_METRICS.pagePaddingBottomPx);
        expect(grouped.findAllByTestId('page-frame')).toHaveLength(0);
    });
    it('keeps a side of its own beside a collection list, and only there', async () => {
        const { ItemList } = await import('./ItemList');
        const { HAPPIER_PAGE_METRICS } = await import('@happier-dev/plugin-ui/presentation');
        const { renderInCollectionLayout } = await import('@/dev/testkit/render/renderInCollectionLayout');
        const side = async (mode: 'split' | 'stacked' | null) => {
            const screen = await renderInCollectionLayout(<ItemList pageColumn="wide"><React.Fragment /></ItemList>, mode);
            return readSurfaceStyleProperty(screen.findByTestId('page-frame')!.props.style, 'paddingHorizontal');
        };
        // A wide page in a settings detail is wider than its pane: beside the rail it must not hug the divider.
        expect(await side('split')).toBe(HAPPIER_PAGE_METRICS.detailSideInsetPx);
        // A pushed detail (a phone) and a page alone keep their sheets on the sheet inset.
        expect(await side('stacked')).toBeUndefined();
        expect(await side(null)).toBeUndefined();
    });
    it('keeps page, grouped and static list grounds clear inside their containing material', async () => {
        const { ItemList, ItemListStatic } = await import('./ItemList');
        const authoredStyle = Object.defineProperty({}, 'backgroundColor', { value: '#112233', enumerable: false });
        const screen = await renderScreen(<HappierMaterialRoleProvider role="floating" resolveMaterialColor={(input) => input.translucentColor ?? input.color}>
            <ItemList style={authoredStyle}><React.Fragment /></ItemList>
            <ItemList presentation="grouped"><React.Fragment /></ItemList>
            <ItemListStatic style={authoredStyle}><React.Fragment /></ItemListStatic>
        </HappierMaterialRoleProvider>);
        for (const scroll of screen.findAllByType('ScrollView')) {
            expect(readSurfaceStyleProperty(scroll.props.style, 'backgroundColor')).toBe('transparent');
        }
        const staticList = screen.findByType(ItemListStatic);
        expect(readSurfaceStyleProperty(staticList.findByType('View').props.style, 'backgroundColor')).toBe('transparent');
    });
    it('owns one page notice and resets its fact in nested list scopes', async () => {
        const { ItemList } = await import('./ItemList');
        const { usePageNoticeActive } = await import('./listPresentation');
        function RepeatedFailure() {
            return usePageNoticeActive() ? null : <React.Fragment>Section failure</React.Fragment>;
        }
        const screen = await renderScreen(
            <ItemList pageNoticeActive>
                <React.Fragment>Machine offline</React.Fragment>
                <RepeatedFailure />
                <ItemList presentation="grouped"><RepeatedFailure /></ItemList>
            </ItemList>,
        );
        const scrolls = screen.findAllByType('ScrollView');
        expect(scrolls[0].findAllByType(RepeatedFailure).filter((node) => node.children.length > 0)).toHaveLength(1);
        expect(scrolls[1].findByType(RepeatedFailure).children).toEqual(['Section failure']);
        await screen.update(<ItemList><RepeatedFailure /></ItemList>);
        expect(screen.findByType(RepeatedFailure).children).toEqual(['Section failure']);
    });

    it('defaults a full list to page anatomy and keeps explicit grouped lists grouped', async () => {
        const { ItemList } = await import('./ItemList');
        const { useListPresentation } = await import('./listPresentation');
        function PresentationProbe() {
            return React.createElement('PresentationProbe', { value: useListPresentation() });
        }
        const page = await renderScreen(<ItemList><PresentationProbe /></ItemList>);
        expect(page.findByType('PresentationProbe').props.value).toBe('page');
        const grouped = await renderScreen(<ItemList presentation="grouped"><PresentationProbe /></ItemList>);
        expect(grouped.findByType('PresentationProbe').props.value).toBe('grouped');
    });

    it('uses the canonical keyboard-aware scroll owner when requested by a form flow', async () => {
        const { ItemList } = await import('./ItemList');

        const screen = await renderScreen(
            <ItemList keyboardAware keyboardShouldPersistTaps="handled">
                <React.Fragment />
            </ItemList>,
        );

        const scrollView = screen.findByType('KeyboardAwareScrollView');
        expect(scrollView.props.keyboardShouldPersistTaps).toBe('handled');
        expect(screen.findAllByType('ScrollView')).toHaveLength(0);
    });

    it('keeps static picker content grouped when opened from a page section', async () => {
        const { ItemList, ItemListStatic } = await import('./ItemList');
        const { useListPresentation } = await import('./listPresentation');
        const { HappierPageSectionContext } = await import('@happier-dev/plugin-ui/presentation');
        function PickerProbe() {
            return React.createElement('PickerProbe', {
                presentation: useListPresentation(),
                section: React.useContext(HappierPageSectionContext),
            });
        }
        const screen = await renderScreen(
            <ItemList pageNoticeActive>
                <HappierPageSectionContext.Provider value={{ rowDividerColor: 'divider', rowInsetPx: 18 }}>
                    <ItemListStatic><PickerProbe /></ItemListStatic>
                </HappierPageSectionContext.Provider>
            </ItemList>,
        );
        expect(screen.findByType('PickerProbe').props).toMatchObject({ presentation: 'grouped', section: null });
    });

    it('sets minHeight: 0 on web to allow flex scroll containers to shrink', async () => {
        const rn = await import('react-native');
        const originalPlatformOs = rn.Platform.OS;
        (rn.Platform as unknown as { OS: string }).OS = 'web';

        vi.resetModules();

        const { ItemList } = await import('./ItemList');

        try {
            let tree: renderer.ReactTestRenderer;
            tree = (await renderScreen(<ItemList>
                        <React.Fragment />
                    </ItemList>)).tree;
            await act(async () => {});

            const scrollView = tree!.findByType('ScrollView');
            const styleProp = scrollView.props.style;
            expect(Array.isArray(styleProp)).toBe(true);
            expect(styleProp.some((entry: any) => entry?.minHeight === 0)).toBe(true);
        } finally {
            (rn.Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.resetModules();
        }
    });
});
