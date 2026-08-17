import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production Voice code must not depend on the design lab.
 *
 * The lab (`components/dev/voiceLab/**`) is a mutable exploration surface reached
 * only through `isDevRouteEnabled()`. Production importing from it would drag
 * fixtures, lab-only state vocabulary and design scaffolding into the shipped
 * bundle, and would invert the authority order the spec sets out: the lab
 * consumes production components, never the reverse.
 *
 * This is a guard, not a repair — nothing violates it today. It exists because
 * the direction is easy to get backwards during a file move, and it was in fact
 * gotten backwards three times while extracting this module: `useVoiceEnergy`
 * imported the lab's state spec, `VoiceControls` its control spec, and
 * `VoiceTranscriptStream` its transcript entry. Each was caught by the compiler
 * and fixed by giving the production module its own presentational type. A
 * source-text guard makes the next one fail loudly instead of quietly compiling
 * because someone re-exported a lab type.
 */

const LAB_SPECIFIER = 'components/dev/voiceLab';

function sourcesRoot(): string {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** This guard names the forbidden specifier, so it must not scan itself. */
const SELF = fileURLToPath(import.meta.url);

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            collectFiles(full, out);
        } else if (/\.tsx?$/.test(entry) && full !== SELF) {
            out.push(full);
        }
    }
    return out;
}

describe('voice production seam', () => {
    it('never imports the design lab from production Voice modules', () => {
        const root = sourcesRoot();
        const offenders = collectFiles(join(root, 'components', 'voice'))
            .filter((file) => readFileSync(file, 'utf8').includes(LAB_SPECIFIER))
            .map((file) => file.slice(root.length + 1));

        expect(offenders).toEqual([]);
    });

    it('keeps the extracted light material free of lab vocabulary', () => {
        const root = sourcesRoot();
        const offenders = collectFiles(join(root, 'components', 'voice'))
            .filter((file) => /\bVoiceLab[A-Z]/.test(readFileSync(file, 'utf8')))
            .map((file) => file.slice(root.length + 1));

        expect(offenders).toEqual([]);
    });
});
