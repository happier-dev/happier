import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  HAPPIER_COLLECTION_RAIL_WIDTH_PX,
  isHappierSectionActionStacked,
  resolveHappierPageBackMeasuringLine,
  resolveHappierPageBackPlacement,
} from './pageMetrics.js';

describe('isHappierSectionActionStacked', () => {
  // A Work pane section at the pane's default width: a short title beside an ⓘ and a +.
  const narrowPane = { headerWidthPx: 251, actionWidthPx: 70, gapPx: 12 };

  it('moves a labelled action under the text when the text column would get too narrow', () => {
    expect(
      isHappierSectionActionStacked({ ...narrowPane, actionLayout: 'inline' }),
    ).toBe(true);
  });

  it('moves a labelled action beneath a described section on a phone, beside a title-only one', () => {
    // A 390pt phone page: "+ Add connection" fits beside the text column, but beside a description
    // it would sit against wrapped explanation lines (anatomy: on narrow widths it drops beneath).
    const phone = {
      headerWidthPx: 358,
      actionWidthPx: 132,
      gapPx: 12,
      actionLayout: 'inline' as const,
    };
    expect(
      isHappierSectionActionStacked({ ...phone, hasDescription: true }),
    ).toBe(true);
    expect(
      isHappierSectionActionStacked({ ...phone, hasDescription: false }),
    ).toBe(false);
    // A desktop page keeps it beside the description.
    expect(
      isHappierSectionActionStacked({
        ...phone,
        headerWidthPx: 704,
        hasDescription: true,
      }),
    ).toBe(false);
  });

  it('keeps a short action on the line of a short title-only heading on a phone', () => {
    // "33 threads" + "New thread" on a 390pt phone: the 200px label column does not fit beside the
    // action, but the title itself does, so the action stays on its line instead of reading as a
    // second heading beneath it.
    const phone = {
      headerWidthPx: 294,
      actionWidthPx: 113,
      gapPx: 12,
      actionLayout: 'inline' as const,
    };
    expect(isHappierSectionActionStacked({ ...phone, titleWidthPx: 90 })).toBe(
      false,
    );
    // A title that already fills (wraps in) the room beside the action still moves the action beneath.
    expect(isHappierSectionActionStacked({ ...phone, titleWidthPx: 169 })).toBe(
      true,
    );
    // A described section keeps the phone rule: the action drops beneath its explanation.
    expect(
      isHappierSectionActionStacked({
        ...phone,
        titleWidthPx: 90,
        hasDescription: true,
      }),
    ).toBe(true);
  });

  it('keeps a lone icon action on the title line of a described phone section', () => {
    // "Your presets" + its "+" on a 390pt phone: a single icon control is a quiet trailing glyph, not a
    // labelled action, so it stays at the title line's end instead of dropping onto a line of its own.
    expect(
      isHappierSectionActionStacked({
        headerWidthPx: 358,
        actionWidthPx: 28,
        gapPx: 12,
        actionLayout: 'inline',
        hasDescription: true,
      }),
    ).toBe(false);
    // An adaptive labelled action on the same phone still moves beneath.
    expect(
      isHappierSectionActionStacked({
        headerWidthPx: 358,
        actionWidthPx: 132,
        gapPx: 12,
        actionLayout: 'adaptive',
        hasDescription: true,
      }),
    ).toBe(true);
  });

  it('keeps a trailing icon cluster on the title line at any width', () => {
    expect(
      isHappierSectionActionStacked({
        ...narrowPane,
        actionLayout: 'trailing',
      }),
    ).toBe(false);
    expect(
      isHappierSectionActionStacked({
        headerWidthPx: 180,
        actionWidthPx: null,
        actionLayout: 'trailing',
        gapPx: 12,
      }),
    ).toBe(false);
  });
});

describe('resolveHappierPageBackPlacement', () => {
  const columnMaxWidthPx = 720;

  it('puts back in the gutter where the space left of the content edge holds it', () => {
    expect(
      resolveHappierPageBackPlacement({ paneWidthPx: 1100, columnMaxWidthPx }),
    ).toBe('gutter');
  });

  it('puts back on its own line above the title when the column fills the pane, never before the title', () => {
    // A Team's sub-page beside the Teams rail at 1440: the column fills the ~725px pane.
    expect(
      resolveHappierPageBackPlacement({ paneWidthPx: 725, columnMaxWidthPx }),
    ).toBe('above-title');
  });

  it('waits for the pane to be measured', () => {
    expect(
      resolveHappierPageBackPlacement({ paneWidthPx: null, columnMaxWidthPx }),
    ).toBeNull();
  });

  it('places nothing when no back will render, so a narrow pane keeps zero extra space', () => {
    expect(
      resolveHappierPageBackPlacement({
        paneWidthPx: 725,
        columnMaxWidthPx,
        backShown: false,
      }),
    ).toBeNull();
    expect(
      resolveHappierPageBackPlacement({
        paneWidthPx: 725,
        columnMaxWidthPx,
        backShown: true,
      }),
    ).toBe('above-title');
  });
});

describe('resolveHappierPageBackMeasuringLine', () => {
  it('reserves the line above the title while measuring a detail beside a list of unknown width', () => {
    // Beside a list the pane is narrow by construction: reserve the line, so the header never grows.
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: true,
        collectionMode: 'split',
        detailWidthPx: null,
      }),
    ).toBe(true);
  });

  it('reserves nothing when the split already published the detail pane width: placement is decided from it', () => {
    // A wide window would reserve the line and then drop it one frame later, shifting the header up.
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: true,
        collectionMode: 'split',
        detailWidthPx: 2200,
      }),
    ).toBe(false);
  });

  it('keeps the gutter assumption on a page that is not beside a list', () => {
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: true,
        collectionMode: null,
        detailWidthPx: null,
      }),
    ).toBe(false);
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: true,
        collectionMode: 'stacked',
        detailWidthPx: null,
      }),
    ).toBe(false);
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: true,
        collectionMode: 'measuring',
        detailWidthPx: null,
      }),
    ).toBe(false);
  });

  it('reserves nothing for a page whose back is hidden (a collection-root detail beside its list)', () => {
    expect(
      resolveHappierPageBackMeasuringLine({
        backShown: false,
        collectionMode: 'split',
        detailWidthPx: null,
      }),
    ).toBe(false);
  });
});

describe('HAPPIER_COLLECTION_RAIL_WIDTH_PX', () => {
  it('names two rail roles, the detailed one wider for rows that carry a description and facts', () => {
    expect(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard).toBe(272);
    expect(HAPPIER_COLLECTION_RAIL_WIDTH_PX.detailed).toBeGreaterThan(
      HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard,
    );
  });

  it.each(['HAPPIER_COLLECTION_RAIL_WIDTH_PX', 'resolveHappierRowTitleMetaPlacement'])(
    'keeps %s in the host layer rather than the plugin author API', (symbol) => {
      const srcRoot = join(new URL('.', import.meta.url).pathname, '..', '..');
      for (const authorEntry of [
        'components/index.public.ts',
        'presentation/index.public.ts',
        'index.public.ts',
      ]) {
        expect(
          readFileSync(join(srcRoot, authorEntry), 'utf8'),
          authorEntry,
        ).not.toContain(symbol);
      }
      expect(readFileSync(join(srcRoot, 'advanced/index.public.ts'), 'utf8')).toContain(symbol);
    },
  );
});
