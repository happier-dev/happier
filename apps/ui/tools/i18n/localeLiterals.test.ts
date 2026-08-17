import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyTranslations, extractLiterals, findRoundTripMismatches, isDoNotTranslate } from './localeLiterals';
import { addLocaleBlock, findSatelliteReferences } from './satelliteModules';

const TRANSLATIONS_DIR = join(__dirname, '../../sources/text/translations');

/** Locale files AND the shared modules — both get rewritten when a language is added. */
function translationSources(): string[] {
    return readdirSync(TRANSLATIONS_DIR)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .sort();
}

describe('locale literal extraction', () => {
    // The load-bearing assertion. Every one of these files is rewritten through this transform
    // whenever a language is added or retranslated, and the only thing standing between that and a
    // corrupted 13k-line file is the escaper's ability to reproduce what it just read.
    //
    // It has caught two real properties of these files that a normalising rewriter would destroy:
    // mixed quote styles (`"You're all caught up"` is double-quoted BECAUSE of the apostrophe), and
    // template literals writing line breaks as the two characters `\n`.
    it.each(translationSources())('round-trips every string in %s', (fileName) => {
        const source = readFileSync(join(TRANSLATIONS_DIR, fileName), 'utf8');
        const literals = extractLiterals(source, fileName);

        expect(literals.length).toBeGreaterThan(0);
        expect(findRoundTripMismatches(source, literals)).toEqual([]);
    });

    it('never touches a literal the translation map does not name', () => {
        // The property that matters for an incremental edit: an untranslated literal is not
        // rewritten at all, so its bytes — including any redundant escaping — survive exactly.
        for (const fileName of translationSources()) {
            const source = readFileSync(join(TRANSLATIONS_DIR, fileName), 'utf8');
            const literals = extractLiterals(source, fileName);
            expect(applyTranslations(source, literals, {}).output).toBe(source);
        }
    });

    it('gives every literal a unique key so translations cannot collide', () => {
        for (const fileName of translationSources()) {
            const literals = extractLiterals(readFileSync(join(TRANSLATIONS_DIR, fileName), 'utf8'), fileName);
            expect(new Set(literals.map((literal) => literal.key)).size).toBe(literals.length);
        }
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
        for (const text of ['Cancel', 'You have ', 'Choose a model', 'Push and don’t ask again']) {
            expect(isDoNotTranslate(text)).toBe(false);
        }
    });
});

describe('satellite translation modules', () => {
    // A locale that exists only in `<locale>.ts` renders English for every domain that was moved
    // into a shared module, because `en.ts` delegates to the same modules and the fallback finds
    // the `en` block. This asserts the delegation is real so the workflow cannot forget it.
    it('finds the shared modules a locale file delegates to', () => {
        const source = readFileSync(join(TRANSLATIONS_DIR, 'es.ts'), 'utf8');
        const references = findSatelliteReferences(source, 'es', 'es.ts');

        expect(references.length).toBeGreaterThan(0);
        expect(references.some((reference) => reference.kind === 'assign')).toBe(true);
        expect(references.some((reference) => reference.kind === 'spread')).toBe(true);
        // A nested mount point — the naive "top-level key" assumption is wrong here.
        expect(references.some((reference) => reference.path.includes('.'))).toBe(true);
    });

    it('every module a locale delegates to also carries that locale', () => {
        const source = readFileSync(join(TRANSLATIONS_DIR, 'fr.ts'), 'utf8');
        const references = findSatelliteReferences(source, 'fr', 'fr.ts');
        expect(references.length).toBeGreaterThan(0);

        for (const reference of references) {
            const modulePath = join(TRANSLATIONS_DIR, `${reference.module}.ts`);
            // Extension consts declared inside the locale file itself have no module of their own.
            let moduleSource: string;
            try {
                moduleSource = readFileSync(modulePath, 'utf8');
            } catch {
                continue;
            }
            expect(`${reference.module}: ${/\bfr\s*:/.test(moduleSource)}`).toBe(`${reference.module}: true`);
        }
    });

    it('clones a reference block, keeping its wrapper and swapping the locale tag', () => {
        const source = [
            'const es = { hello: "Hola" };',
            'function withShared<T>(translation: T, locale: string) { return { ...translation, locale }; }',
            'export const demoTranslations = {',
            "    es: withShared(es, 'es'),",
            '} as const;',
            '',
        ].join('\n');

        const literals = extractLiterals(source, 'demo.ts');
        const hello = literals.find((literal) => literal.text === 'Hola');
        const output = addLocaleBlock(source, 'es', 'fr', { [hello!.key]: 'Bonjour' }, 'demo.ts');

        expect(output).toContain(`fr: withShared({ hello: "Bonjour" }, 'fr'),`);
        // The reference locale is left exactly as it was.
        expect(output).toContain(`es: withShared(es, 'es'),`);
    });

    it('is a no-op when the locale block already exists', () => {
        const source = ['export const demoTranslations = {', "    es: { a: 'A' },", "    fr: { a: 'A' },", '} as const;', ''].join('\n');
        expect(addLocaleBlock(source, 'es', 'fr', {}, 'demo.ts')).toBe(source);
    });
});
