import { describe, expect, it } from 'vitest';

import {
  HAPPIER_COLLECTION_LIST_METRICS,
  resolveHappierColumnBandSlotStyle,
} from './CollectionList.js';
import { HAPPIER_SHELL_RAIL_STEP_PX as STEP } from '../layout/shellTitleRow.js';

/**
 * SHELL-ACCEPT-1116: a band under a column's title (Sessions' spaces strip, Services' grouping switch) stands one rail
 * step under the title row and one above the first row, also where the content after it keeps the header gap itself
 * (Sessions). Distances from the title row's centre, at the default text size.
 */
describe('column band slot', () => {
  it.each([
    { following: 0, band: 24 },
    { following: 0, band: 36 },
    { following: HAPPIER_COLLECTION_LIST_METRICS.headerGap, band: 24 },
    { following: HAPPIER_COLLECTION_LIST_METRICS.headerGap, band: 36 },
  ])(
    'centres a $band px band one step under the title and one above the first row (following gap $following)',
    ({ following, band }) => {
      const slot = resolveHappierColumnBandSlotStyle(following);
      const titleFoot = HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight / 2;
      const content = Math.max(
        slot.minHeight - slot.paddingTop - slot.paddingBottom,
        band,
      );
      const slotHeight = content + slot.paddingTop + slot.paddingBottom;
      const bandCentre = titleFoot + slot.paddingTop + content / 2;
      const firstRowCentre =
        titleFoot +
        slotHeight +
        following +
        HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight / 2;
      expect(bandCentre).toBe(STEP);
      expect(firstRowCentre - bandCentre).toBe(STEP);
    },
  );
});
