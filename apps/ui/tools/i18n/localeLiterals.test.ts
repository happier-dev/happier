import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { SUPPORTED_LANGUAGE_CODES } from '../../sources/text/_all';

import { applyTranslations, extractLiterals, findRoundTripMismatches, isDoNotTranslate } from './localeLiterals';
import { addLocaleBlock, findSatelliteReferences, replaceLocaleBlock } from './satelliteModules';

const TRANSLATIONS_DIR = join(__dirname, '../../sources/text/translations');

/** Include locale-owned payloads as well as shared modules and their tooling aggregates. */
function translationSources(directory = TRANSLATIONS_DIR): string[] {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => entry.isDirectory()
            ? translationSources(join(directory, entry.name)).map((name) => join(entry.name, name))
            : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entry.name] : [])
        .sort();
}

/** Independent source witness: delegates/types have no runtime literal initializer to lose. */
function firstInlinePayloadText(source: string, fileName: string): string | undefined {
    const module = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    let text: string | undefined;
    const visit = (node: ts.Node): void => {
        if (text !== undefined) return;
        if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node))
            && node.initializer && ts.isStringLiteralLike(node.initializer)) {
            text = node.initializer.text;
            return;
        }
        if (ts.isTemplateExpression(node)) {
            text = node.head.text;
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(module, visit);
    return text;
}

function containsTranslatableCopy(value: unknown): boolean {
    if (typeof value === 'string') return !isDoNotTranslate(value);
    if (!value || typeof value !== 'object') return false;
    return Object.values(value).some(containsTranslatableCopy);
}

describe('locale literal extraction', () => {
    // The load-bearing assertion. Every one of these files is rewritten through this transform
    // whenever a language is added or retranslated, and the only thing standing between that and a
    // corrupted 13k-line file is the escaper's ability to reproduce what it just read.
    //
    // It has caught two real properties of these files that a normalising rewriter would destroy:
    // mixed quote styles (`"You're all caught up"` is double-quoted BECAUSE of the apostrophe), and
    // template literals writing line breaks as the two characters `\n`.
    it.each(translationSources())('preserves every literal rewrite invariant in %s', async (fileName) => {
        // Parsing a translation source is synchronous and can take seconds on CI. Yield between
        // exhaustive cases so Vitest can flush completed-task IPC before starting the next parse.
        await yieldToEventLoop();

        const source = readFileSync(join(TRANSLATIONS_DIR, fileName), 'utf8');
        const literals = extractLiterals(source, fileName);
        const inlineText = firstInlinePayloadText(source, fileName);
        if (inlineText !== undefined) {
            expect(literals.map((literal) => literal.text), fileName).toContain(inlineText);
        }

        // Canonical locale entries own copy. Non-English feature entries own extracted copy;
        // the English feature entry delegates to shared English payloads. Shared files can also
        // be copy-parameter factories or types, so their rewrite invariant does not imply copy.
        const ownsCanonicalLocalePayload = SUPPORTED_LANGUAGE_CODES.some((locale) =>
            fileName === (locale === 'zh-Hant' ? 'zh-HantOverrides.ts' : `${locale}.ts`)
            || (locale !== 'en' && fileName === join('features', `${locale}.ts`)));
        if (ownsCanonicalLocalePayload) {
            expect(literals.length).toBeGreaterThan(0);
        }
        expect(findRoundTripMismatches(source, literals)).toEqual([]);
        // The property that matters for an incremental edit: an untranslated literal is not
        // rewritten at all, so its bytes — including any redundant escaping — survive exactly.
        expect(applyTranslations(source, literals, {}).output).toBe(source);
        expect(new Set(literals.map((literal) => literal.key)).size).toBe(literals.length);
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

    it('every module a locale delegates to also carries that locale', async () => {
        const source = readFileSync(join(TRANSLATIONS_DIR, 'fr.ts'), 'utf8');
        const references = findSatelliteReferences(source, 'fr', 'fr.ts');
        expect(references.length).toBeGreaterThan(0);

        for (const reference of references) {
            const modulePath = join(TRANSLATIONS_DIR, `${reference.module}.ts`);
            // Extension consts declared inside the locale file itself have no module of their own.
            try {
                readFileSync(modulePath, 'utf8');
            } catch {
                continue;
            }
            const translations: Record<string, unknown> = await import(modulePath);
            expect(translations[reference.module], reference.module).toHaveProperty('fr');
            const bundle = translations[reference.module];
            expect(containsTranslatableCopy(
                bundle && typeof bundle === 'object' && 'fr' in bundle ? bundle.fr : undefined,
            ), reference.module).toBe(true);
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

    it('replaces an existing English alias when retranslating a shared module', () => {
        const source = [
            "const english = { title: 'Plugin webhooks' };",
            'export const demoTranslations = {',
            '    en: english,',
            '    es: english,',
            '} as const;',
            '',
        ].join('\n');
        const title = extractLiterals(source, 'demo.ts').find((literal) => literal.text === 'Plugin webhooks');

        const output = replaceLocaleBlock(source, 'en', 'es', { [title!.key]: 'Webhooks de plugins' }, 'demo.ts');

        expect(output).toContain("es: { title: 'Webhooks de plugins' },");
        expect(output).toContain('en: english,');
    });

    it('replaces a locale-specific shorthand block without leaving a dead duplicate', () => {
        const source = [
            "const english = { title: 'Plugin webhooks' };",
            "const es = { title: 'Webhooks viejos' };",
            'export const demoTranslations = {',
            '    en: english,',
            '    es,',
            '} as const;',
            '',
        ].join('\n');
        const title = extractLiterals(source, 'demo.ts').find((literal) => literal.text === 'Plugin webhooks');

        const output = replaceLocaleBlock(source, 'en', 'es', { [title!.key]: 'Webhooks de plugins' }, 'demo.ts');

        expect(output).toContain("const es = { title: 'Webhooks de plugins' };");
        expect(output).toContain('    es,');
        expect(output).not.toContain('es: {');
    });

    it('finds bracket-form satellite mounts used by hyphenated locale-safe modules', () => {
        const source = [
            'export const en = {',
            "    settingsPlugins: { ...pluginWebhookAdministrationTranslations['en'] },",
            '};',
            '',
        ].join('\n');

        expect(findSatelliteReferences(source, 'en', 'en.ts')).toContainEqual({
            module: 'pluginWebhookAdministrationTranslations',
            kind: 'spread',
            path: 'settingsPlugins',
        });
    });
});
