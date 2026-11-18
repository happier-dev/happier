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

// HugeiconsIcon draws path, circle, rect, line and g; it silently drops an `ellipse`, which cut the top off the
// database cylinder (DBW-UI-4 N4). Every glyph the app selects must reach it in elements it draws.
it('hands HugeiconsIcon only elements it draws, including the top of the database cylinder', async () => {
    const registry = await preloadHugeIconRegistry();
    const drawn = new Set(['path', 'circle', 'rect', 'line', 'g']);
    const undrawable = Object.entries(registry).flatMap(([name, glyph]) =>
        (glyph as unknown as ReadonlyArray<readonly [string, unknown]>).filter(([tag]) => !drawn.has(tag)).map(([tag]) => `${name}:${tag}`));
    expect(undrawable).toEqual([]);
    const database = resolveHugeIconGlyph('database', 'regular', 'hugeicons') as unknown as ReadonlyArray<readonly [string, { d?: string }]>;
    expect(database).toHaveLength(5);
    expect(database[0]).toEqual(['path', expect.objectContaining({ d: 'M4 5a8 3 0 1 0 16 0a8 3 0 1 0 -16 0', stroke: 'currentColor' })]);
});
