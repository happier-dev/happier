import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as fontCoverage from './publicProfileFontCoverage.generated';
import { PUBLIC_PROFILE_FONT_FILES, readPublicProfileFont, type PublicProfileFontFace } from './publicProfileFonts';

describe('public profile font coverage table', () => {
    // The checked-in coverage table is derived (fc-query, authoring time only) from the shipped
    // faces; a replaced font without regeneration would silently misjudge glyph coverage.
    it('was generated from the exact font bytes the server ships', async () => {
        const recorded: Partial<Record<string, string>> =
            (fontCoverage as { PUBLIC_PROFILE_FONT_SOURCE_SHA256?: Partial<Record<string, string>> }).PUBLIC_PROFILE_FONT_SOURCE_SHA256 ?? {};
        const stale: string[] = [];
        for (const face of Object.keys(PUBLIC_PROFILE_FONT_FILES) as PublicProfileFontFace[]) {
            const { bytes } = await readPublicProfileFont(face);
            if (recorded[face] !== createHash('sha256').update(bytes).digest('hex')) stale.push(face);
        }
        expect(stale, 'run node scripts/generatePublicProfileFontCoverage.mjs').toEqual([]);
    });
});
