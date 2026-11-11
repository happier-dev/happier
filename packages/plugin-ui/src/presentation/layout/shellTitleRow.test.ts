import { describe, expect, it } from 'vitest';

import { resolveHappierTitleRowTitleLiftPx } from './shellTitleRow.js';

// Measured on the live desktop shell (SIDEBAR-RHYTHM-1111, 1440 web): the rail's first glyph inks from 59.9,
// a 15 px column title ("My work") centred on the row inks its capitals from 62.5, the owner's red-line gap.
describe("the shell title row: a title hangs its capitals from the row glyph's top", () => {
  it("lifts a column title (15 px) onto the rail glyph's top", () => {
    expect(resolveHappierTitleRowTitleLiftPx(15)).toBe(3);
  });

  it('leaves a page title (22 px), whose capitals already span the glyph, where centring puts it', () => {
    expect(resolveHappierTitleRowTitleLiftPx(22)).toBe(0);
  });
});
