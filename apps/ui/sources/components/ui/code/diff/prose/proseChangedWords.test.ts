import { describe, expect, it } from 'vitest';
import { buildProseChangedLines } from './proseChangedWords';

describe('one version read against its base', () => {
    // REAL-USER-PASS-2 G8: What's new dumped the whole section; it shows only the changed lines, words marked.
    it('yields only the changed line, with the words this side changed marked', () => {
        const lines = buildProseChangedLines('Keep notes.\nBefore drafting, ask me which packages to include.\nBe brief.\n',
            'Keep notes.\nBefore drafting, run prerelease-check on every bumped package.\nBe brief.\n');
        expect(lines).toHaveLength(1);
        expect(lines[0]!.filter(run => !run.changed).map(run => run.text).join('')).toContain('Before drafting,');
        expect(lines[0]!.filter(run => run.changed).map(run => run.text).join('')).toContain('run prerelease-check');
        expect(lines[0]!.map(run => run.text).join('')).not.toContain('ask me');
    });

    it('reads appended lines as changed lines without blank lines or numbering', () => {
        const lines = buildProseChangedLines('', '\nFirst new line.\n\nSecond new line.\n');
        expect(lines.map(line => line.map(run => run.text).join(''))).toEqual(['First new line.', 'Second new line.']);
        expect(lines.every(line => line.every(run => run.changed))).toBe(true);
    });
});
