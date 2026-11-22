import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';

/**
 * True inside a page header's mark slot. A `BrandMark` there draws at the glyph step the host's own
 * identity header uses, whatever `size` it asked for, so a plugin's header and the host's loading
 * identity header carry the same mark in the same footprint.
 */
const PageHeaderMarkContext = createContext(false);

export function usePageHeaderMarkGlyphPx(): number | undefined {
  return useContext(PageHeaderMarkContext) ? HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx : undefined;
}

/** The page header's leading mark in its one stable footprint; the mark never resizes the title beside it. */
export function PageHeaderMarkSlot(props: Readonly<{ children: ReactNode; testID?: string }>): ReactElement {
  return (
    <PageHeaderMarkContext.Provider value>
      <View
        testID={props.testID}
        style={{
          width: HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx,
          height: HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx,
          // The glyph stands on the page's leading edge, where the section titles under the header start; the
          // slot's spare width falls between the mark and the title (TRIAGE-DESIGN-ACCEPT-250 F11).
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        {props.children}
      </View>
    </PageHeaderMarkContext.Provider>
  );
}
