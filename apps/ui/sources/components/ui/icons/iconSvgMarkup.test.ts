import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/components/ui/icons/Icon');
vi.unmock('./iconRegistry.generated');
vi.unmock('./iconRegistryHuge.generated');

const { readIconSvgMarkup, readIconSvgCssUrl } =
  await import('./iconSvgMarkup');
const { setIconFamily, getIconFamily } = await import('./iconFamily');
const { preloadHugeIconRegistry } = await import('./resolveHugeIconGlyph');
await preloadHugeIconRegistry();

const CHIP_GLYPHS = [
  'file',
  'folder',
  'chat-circle',
  'sparkle',
  'puzzle-piece',
  'tree-structure',
  'squares-four',
  'at',
] as const;
const initialFamily = getIconFamily();

afterEach(() => setIconFamily(initialFamily));

describe('readIconSvgMarkup', () => {
  it.each(['hugeicons', 'phosphor'] as const)(
    'draws every reference-chip glyph in the selected %s family',
    (family) => {
      setIconFamily(family);
      for (const name of CHIP_GLYPHS) {
        const markup = readIconSvgMarkup(name);
        expect(markup, name).toMatch(
          /^<svg [^>]*viewBox="0 0 (24 24|256 256)"[^>]*>.*<path [^>]*d="[^"]+"/,
        );
        expect(markup, name).toContain(
          family === 'hugeicons'
            ? 'viewBox="0 0 24 24"'
            : 'viewBox="0 0 256 256"',
        );
      }
    },
  );

  it('gives a CSS mask URL that follows a family change', () => {
    setIconFamily('hugeicons');
    const huge = readIconSvgCssUrl('file');
    setIconFamily('phosphor');
    const phosphor = readIconSvgCssUrl('file');
    expect(huge).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(phosphor).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(phosphor).not.toBe(huge);
  });
});
