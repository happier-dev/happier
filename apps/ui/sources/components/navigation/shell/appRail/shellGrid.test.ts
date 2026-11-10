import { describe, expect, it } from 'vitest';

import {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_PAGE_METRICS,
} from '@happier-dev/plugin-ui/presentation';

import {
  DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX,
  DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX,
} from '../desktopChrome/desktopChromeMetrics';
import {
  APP_RAIL_ITEM_SLOT_PX,
  APP_RAIL_PADDING_TOP_PX,
  APP_RAIL_WIDTH_PX,
  APP_SHELL_TITLE_STRIP_CONTROLS_START_PX,
} from './appRailMetrics';

// The desktop shell grid (DESIGN.md "Spacing, shape, and alignment", owner 2026-11-10): one title row and
// column edges that continue up into the title strip.
describe('the shell grid', () => {
  const titleRowCentrePx = HAPPIER_PAGE_METRICS.paneHeaderHeightPx / 2;

  it("centres the rail's first icon and a column's title on the pane band's centre line", () => {
    expect(APP_RAIL_PADDING_TOP_PX + APP_RAIL_ITEM_SLOT_PX / 2).toBe(
      titleRowCentrePx,
    );
    expect(
      HAPPIER_COLLECTION_LIST_METRICS.headerPaddingTop +
        HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight / 2,
    ).toBe(titleRowCentrePx);
  });

  it("starts the first title-strip glyph on the column's text edge, right of the rail", () => {
    const firstGlyphLeftPx =
      APP_SHELL_TITLE_STRIP_CONTROLS_START_PX +
      (DESKTOP_SIDEBAR_CHROME_TOP_NAV_ICON_TARGET_SIZE_PX -
        DESKTOP_SIDEBAR_CHROME_ICON_GLYPH_SIZE_PX) /
        2;
    expect(firstGlyphLeftPx).toBe(
      APP_RAIL_WIDTH_PX + HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    );
  });
});
