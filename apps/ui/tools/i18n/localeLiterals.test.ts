import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { applyTranslations, extractLiterals, findRoundTripMismatches, isDoNotTranslate } from './localeLiterals';

const TRANSLATIONS_DIR = join(__dirname, '../../sources/text/translations');

function localeFiles(): string[] {
    return readdirSync(TRANSLATIONS_DIR)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .sort();
}

describe('locale literal extraction', () => {
    // The load-bearing assertion. Every locale file is rewritten through this transform whenever a
    // language is added or retranslated, and the only thing standing between that and a corrupted
    // 10k-line file is the escaper's ability to reproduce what it just read.
    //
    // It has caught two real properties of these files that a normalising rewriter would destroy:
    // mixed quote styles (`"You're all caught up"` is double-quoted BECAUSE of the apostrophe), and
    // template literals writing line breaks as the two characters `\n`.
    it.each(localeFiles())('preserves every literal rewrite invariant in %s', async (fileName) => {
        // Each locale spends several seconds in synchronous TypeScript parsing on CI. Yield before
        // the next parse so Vitest's worker can flush completed-task RPC between locale cases.
        await yieldToEventLoop();

        const source = readFileSync(join(TRANSLATIONS_DIR, fileName), 'utf8');
        const literals = extractLiterals(source, fileName);

        expect(literals.length).toBeGreaterThan(0);
        expect(findRoundTripMismatches(source, literals)).toEqual([]);
        // The property that matters for an incremental edit: an untranslated literal is not
        // rewritten at all, so its bytes — including any redundant escaping — survive exactly.
        expect(applyTranslations(source, literals, {}).output).toBe(source);
        expect(new Set(literals.map((literal) => literal.key)).size).toBe(literals.length);
    });

    it('rewrites only the targeted literal and leaves the rest of the file alone', () => {
        const source = [
            "export const en = {",
            "    common: {",
            "        cancel: 'Cancel',",
            '        greet: ({ name }: { name: string }) => `Hello, ${name}!`,',
            "    },",
            "} as const;",
            '',
        ].join('\n');
        const literals = extractLiterals(source);
        const cancel = literals.find((literal) => literal.key.endsWith('cancel#0'));
        expect(cancel).toBeDefined();

        const { output, applied } = applyTranslations(source, literals, { [cancel!.key]: 'Annuler' });
        expect(applied).toBe(1);
        expect(output).toBe(source.replace("'Cancel'", "'Annuler'"));
    });

    it('keeps interpolations out of the translatable set and preserves fragment whitespace', () => {
        const source = 'export const en = { n: ({ count }: { count: number }) => `You have ${count} new items` } as const;\n';
        const literals = extractLiterals(source);

        // The `${count}` expression is structure; only the text either side of it is copy.
        expect(literals.map((literal) => literal.text)).toEqual(['You have ', ' new items']);

        const translated = applyTranslations(
            source,
            literals,
            Object.fromEntries([
                [literals[0]!.key, 'Tu as '],
                [literals[1]!.key, ' nouveaux éléments'],
            ]),
        );
        expect(translated.output).toContain('`Tu as ${count} nouveaux éléments`');
    });

    it('escapes for the delimiter already at the site rather than normalising quote style', () => {
        const source = `export const en = { a: 'plain', b: "already double" } as const;\n`;
        const literals = extractLiterals(source);
        const [a, b] = literals;

        const output = applyTranslations(
            source,
            literals,
            Object.fromEntries([
                [a!.key, "l'apostrophe"],
                [b!.key, 'le "guillemet"'],
            ]),
        ).output;

        // Single-quoted site escapes the apostrophe; double-quoted site escapes the double quote.
        expect(output).toContain("'l\\'apostrophe'");
        expect(output).toContain('"le \\"guillemet\\""');
    });

    it('treats commands, paths, flags and URLs as do-not-translate', () => {
        for (const text of [
            'happier attach <session-id>',
            'git push --force-with-lease',
            '/path/to/project',
            '--force',
            'https://example.com',
            ' · ',
            '',
        ]) {
            expect(isDoNotTranslate(text)).toBe(true);
        }
        // Ordinary copy must stay translatable — the command heuristic keys off a lowercase
        // executable, so a normal sentence never matches it.
        for (const text of ['Cancel', 'You have ', 'Choose a model', 'Push and don’t ask again']) {
            expect(isDoNotTranslate(text)).toBe(false);
        }
    });
});
