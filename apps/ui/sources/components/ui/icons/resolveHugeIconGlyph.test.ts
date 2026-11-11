import { expect, it } from 'vitest';
import { preloadHugeIconRegistry, resolveHugeIconGlyph } from './resolveHugeIconGlyph';

it('loads the real selected glyphs on demand, shares pending work and keeps family rules', async () => {
    expect(resolveHugeIconGlyph('file', 'regular', 'hugeicons')).toBeUndefined();
    const first = preloadHugeIconRegistry();
    expect(preloadHugeIconRegistry()).toBe(first);
    const registry = await first;
    expect(resolveHugeIconGlyph('file', 'regular', 'hugeicons')).toBe(registry.file);
    expect(resolveHugeIconGlyph('file', 'regular', 'hugeicons')).toBeDefined();
    expect(resolveHugeIconGlyph('file', 'fill', 'hugeicons')).toBeUndefined();
    expect(resolveHugeIconGlyph('star', 'regular', 'hugeicons')).toBeUndefined();
    expect(resolveHugeIconGlyph('file', 'regular', 'phosphor')).toBeUndefined();
});
