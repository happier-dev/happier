import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HAPPIER_PAGE_METRICS, HappierColumnEdgeContext, HappierPageSectionContext, type HappierPageSection } from '@happier-dev/plugin-ui/presentation';

import { renderScreen } from '@/dev/testkit';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { CoreCollectionScope } = await import('./CoreCollectionScope');

function EdgeProbe(props: Readonly<{ onEdge(px: number): void }>) {
    props.onEdge(React.useContext(HappierColumnEdgeContext));
    return null;
}

const SHEET_ROWS: HappierPageSection = { rowDividerColor: '#000', rowInsetPx: 16, framed: true };

async function edgeUnder(presentation: 'page' | 'grouped', options: Readonly<{ pageInsets?: 'contained'; inSheet?: boolean }> = {}): Promise<number> {
    let edge = -1;
    const scope = <CoreCollectionScope><EdgeProbe onEdge={(px) => { edge = px; }} /></CoreCollectionScope>;
    const screen = await renderScreen(<ListPresentationProvider value={presentation} {...(options.pageInsets ? { pageInsets: options.pageInsets } : {})}>
        {options.inSheet ? <HappierPageSectionContext.Provider value={SHEET_ROWS}>{scope}</HappierPageSectionContext.Provider> : scope}
    </ListPresentationProvider>);
    await screen.unmount();
    return edge;
}

describe('CoreCollectionScope', () => {
    it('tells public sections on a core page that the page column already draws the sheet edge', async () => {
        expect(await edgeUnder('page')).toBe(HAPPIER_PAGE_METRICS.sheetInsetPx);
    });

    it('leaves public sections their own edge where the scope is not on a standard page column', async () => {
        expect(await edgeUnder('grouped')).toBe(0);
        expect(await edgeUnder('page', { pageInsets: 'contained' })).toBe(0);
        expect(await edgeUnder('page', { inSheet: true })).toBe(0);
    });

    it('states no edge inside a page content column, which draws none (Store rows sat 16 pt left of the page edge)', async () => {
        const { PageContentColumn } = await import('@/components/ui/lists/PageContentColumn');
        let edge = -1;
        const screen = await renderScreen(<ListPresentationProvider value="page"><PageContentColumn>
            <CoreCollectionScope><EdgeProbe onEdge={(px) => { edge = px; }} /></CoreCollectionScope>
        </PageContentColumn></ListPresentationProvider>);
        await screen.unmount();
        expect(edge).toBe(0);
    });
});
