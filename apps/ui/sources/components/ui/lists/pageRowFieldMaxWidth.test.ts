import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { resolveHappierPageRowFieldMaxWidth } = await import('@happier-dev/plugin-ui/presentation');

describe('resolveHappierPageRowFieldMaxWidth', () => {
  it('keeps a short-named phone row inline: the measured name and the field fit one line', async () => {
    const { Dimensions } = await import('react-native');
    const window = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    try {
      // A 358px phone row: 358 - 32 - 14 - 120 (name and "changed") leaves 192px for the field.
      expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 120 })).toBe(192);
      // The shared 200px column leaves 112px: below the field's narrowest trigger, so it stacks.
      expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16 })).toBeNull();
    } finally {
      window.mockRestore();
    }
  });

  // A 323px pane row (the Work pane at its 340px default) with the page sheet's 16px insets.
  it('holds a short-named row only to the room its name needs, not to the shared 200px column', () => {
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16 })).toBeNull();
    // "Reviewer" and its "changed" marker need ~130px: the field keeps what is left (323 - 32 - 14 - 130).
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16, titleNaturalWidthPx: 130 })).toBe(147);
    // A marker beside the name counts with its gap (61 + 8 + 57); until it is measured the shared column holds.
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16, titleNaturalWidthPx: 61, titleAccessoryWidthPx: 57, titleAccessoryGapPx: 8 })).toBe(151);
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16, titleNaturalWidthPx: 61, titleAccessoryWidthPx: null, titleAccessoryGapPx: 8 })).toBeNull();
  });

  it('moves a field beneath its label once its value fills the room beside it, so the value reads in full', () => {
    // "Incoming messages" beside "All allowed messages" on a 358px phone row: 172px is above the
    // narrowest trigger, but the value filled the box at 172px and was cut ("All allowed …").
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 140 })).toBe(172);
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 140, fieldSaturatedAtPx: 172 })).toBeNull();
    // A value that filled a narrower box still fits the wider room a shorter name leaves.
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 60, fieldSaturatedAtPx: 172 })).toBe(252);
  });

  it('keeps the shared column for a short name with a description, so the description is not squeezed beside the field', () => {
    // "MCP" over "Follow the product default for this surface." on a 358px phone row: the description
    // shares the label's column, so the 200px column holds and the field moves beneath, as its siblings do.
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 34, described: true })).toBeNull();
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 358, rowInsetPx: 16, titleNaturalWidthPx: 34 })).toBe(278);
  });

  it('never gives a name less than it needs, and still stacks a field that would not fit its minimum', () => {
    // A name wider than the shared column keeps the shared column.
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16, titleNaturalWidthPx: 260 })).toBeNull();
    // Under the field's narrowest trigger (132px) the field moves beneath instead.
    expect(resolveHappierPageRowFieldMaxWidth({ rowWidthPx: 323, rowInsetPx: 16, titleNaturalWidthPx: 160 })).toBeNull();
  });
});
