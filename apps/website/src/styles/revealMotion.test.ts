import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'globals.css');
const css = readFileSync(cssPath, 'utf8');

describe('reveal word motion', () => {
    it('keeps the full desktop blur while capping mobile reveal blur at two pixels', () => {
        expect(css).toMatch(/\.reveal-word\s*{[^}]*filter:\s*blur\(10px\)/s);
        expect(css).toMatch(/@media\s+\(hover:\s*none\)\s+and\s+\(pointer:\s*coarse\)\s*{[^@]*\.reveal-word\s*{[^}]*filter:\s*blur\(2px\)/s);
    });
});

/**
 * The /security wire (SecurityPage.tsx, .wire* in globals.css).
 *
 * Guarded here rather than left to a reviewer's eye because this animation is
 * the only one on the site that CARRIES A CLAIM: the chip is readable at the
 * ends and ciphertext in the middle, and that transition is the page's argument
 * rather than an ornament. Two ways to break it silently, so two assertions.
 *
 * The reduced-motion one is the important half. Every other reduce block in
 * this file removes motion and leaves a neutral resting state; this one has to
 * PICK a frame, because a frozen chip showing the plaintext would state the
 * opposite of the section it sits in. It freezes over the relay, showing the
 * ciphertext — verified in a reduced-motion browser context, and pinned here so
 * a later edit cannot quietly reverse which text survives.
 */
describe('the security wire', () => {
    it('crossfades plaintext to ciphertext on the same clock as the travel', () => {
        for (const name of ['wire-travel', 'wire-plain', 'wire-cipher']) {
            expect(css, `${name} is not on the shared 9s loop`).toMatch(
                new RegExp(`animation:\\s*${name}\\s+9s`),
            );
        }
        // The chip pauses over the relay (41% → 59%) and the ciphertext is up
        // for the whole of that window (27% → 73%), so the frame a reader stops
        // on is always the encrypted one.
        const travel = css.match(/@keyframes wire-travel\s*{[\s\S]*?\n}/)?.[0] ?? '';
        expect(travel, 'wire-travel keyframes are missing').not.toBe('');
        expect(travel).toMatch(/41%\s*{\s*transform:\s*translateX\(50%\)/);
        expect(travel).toMatch(/59%\s*{\s*transform:\s*translateX\(50%\)/);
    });

    it('freezes over the relay showing ciphertext when motion is reduced', () => {
        const reduceBlocks = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\n}/g) ?? [];
        const wireBlock = reduceBlocks.find((block) => block.includes('.wire__carrier'));
        expect(wireBlock, 'the wire has no reduced-motion block at all').toBeDefined();

        // Parked at the relay, not at either end.
        expect(wireBlock).toMatch(/\.wire__carrier\s*{[^}]*animation:\s*none[^}]*transform:\s*translateX\(50%\)/s);
        // And it is the CIPHERTEXT that survives the freeze.
        expect(wireBlock).toMatch(/\.wire__text--plain\s*{[^}]*opacity:\s*0/s);
        expect(wireBlock).toMatch(/\.wire__text--cipher\s*{[^}]*opacity:\s*1/s);
    });
});
