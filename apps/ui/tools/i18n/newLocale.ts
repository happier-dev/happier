import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { applyTranslations, extractLiterals, findRoundTripMismatches, isDoNotTranslate } from './localeLiterals';

/**
 * Author a new locale, or retranslate an existing one, without hand-editing a 10k-line file.
 *
 *   yarn i18n:locale:extract -- --locale fr --out /tmp/fr.todo.json
 *   …fill in the French for every entry…
 *   yarn i18n:locale:build   -- --locale fr --translations /tmp/fr.fr.json
 *
 * `extract` offers every translatable string in `en.ts`, keyed by a stable
 * `<key path>#<occurrence>` id. `build` re-extracts from the CURRENT `en.ts` and applies the map by
 * that key, so English can move underneath a half-finished translation without silently pairing a
 * French string with the wrong English one — a positional id could not survive that.
 *
 * Building only writes the locale file. Registering it is three edits the tool deliberately does not
 * make for you, because each one is a product decision:
 *   - `sources/text/_all.ts`      — add the code to `SupportedLanguage` and its `nativeName`.
 *   - `sources/text/i18n.ts`      — import it and add a thunk to `TRANSLATION_TREE_BY_LANGUAGE`
 *                                   (a thunk, so only the active language is materialised).
 *   - `sources/text/i18n.integrity.test.ts` — add it to the locale lists so it is held to the same
 *                                   completeness bar as every other language.
 */

const TRANSLATIONS_DIR = path.join(__dirname, '../../sources/text/translations');
const SOURCE_LOCALE = 'en';

type ExtractManifest = {
    locale: string;
    source: string;
    /** Strings offered for translation, in source order. */
    entries: { key: string; en: string }[];
    /** Strings deliberately withheld: code, paths, flags, URLs, interpolation glue. */
    withheld: number;
};

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

function requireArg(name: string): string {
    const value = readArg(name);
    if (!value) throw new Error(`missing --${name}`);
    return value;
}

function capitalise(locale: string): string {
    const compact = locale.replace(/-/g, '');
    return compact.charAt(0).toUpperCase() + compact.slice(1);
}

function sourcePath(): string {
    return path.join(TRANSLATIONS_DIR, `${SOURCE_LOCALE}.ts`);
}

function runExtract(): void {
    const locale = requireArg('locale');
    const outPath = readArg('out') ?? path.join(TRANSLATIONS_DIR, `${locale}.todo.json`);
    const source = readFileSync(sourcePath(), 'utf8');
    const literals = extractLiterals(source, `${SOURCE_LOCALE}.ts`);

    const mismatches = findRoundTripMismatches(source, literals);
    if (mismatches.length > 0) {
        throw new Error(
            `${SOURCE_LOCALE}.ts does not round-trip (${mismatches.length} strings change value). ` +
                'Fix tools/i18n/localeLiterals.ts before rewriting any locale file.',
        );
    }

    const offered = literals.filter((literal) => !isDoNotTranslate(literal.text));
    const manifest: ExtractManifest = {
        locale,
        source: path.relative(process.cwd(), sourcePath()),
        entries: offered.map((literal) => ({ key: literal.key, en: literal.text })),
        withheld: literals.length - offered.length,
    };
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`offered ${manifest.entries.length} strings (${manifest.withheld} withheld as code/paths/glue) -> ${outPath}`);
}

/**
 * `en.ts` is both a locale AND the file that DEFINES the shape contract (`DeepTranslationShape`,
 * `TranslationStructure`). A locale file only consumes that contract, so the header and footer are
 * rewritten while the ~10k lines between them are left exactly as the translation left them.
 */
function toLocaleModule(translated: string, locale: string): string {
    let output = translated;

    if (!/^import type \{ TranslationStructure \}/.test(output)) {
        output = `import type { TranslationStructure } from "../_types";\n\n${output}`;
    }

    const exportAnchor = new RegExp(`export const ${SOURCE_LOCALE} = \\{`);
    if (!exportAnchor.test(output)) {
        throw new Error(`anchor \`export const ${SOURCE_LOCALE} = {\` not found — en.ts changed shape`);
    }
    const localeConst = locale.replace(/-/g, '');
    output = output.replace(exportAnchor, `export const ${localeConst}: TranslationStructure = {`);

    const tailAnchor = output.indexOf('type DeepTranslationShape<T> =');
    if (tailAnchor === -1) {
        throw new Error('anchor `type DeepTranslationShape` not found — en.ts changed shape');
    }
    return `${output.slice(0, tailAnchor).replace(/\s*$/, '\n')}\nexport type Translations${capitalise(locale)} = typeof ${localeConst};\n`;
}

function runBuild(): void {
    const locale = requireArg('locale');
    const translationsPath = requireArg('translations');
    const source = readFileSync(sourcePath(), 'utf8');
    const literals = extractLiterals(source, `${SOURCE_LOCALE}.ts`);
    const translations = JSON.parse(readFileSync(translationsPath, 'utf8')) as Record<string, string>;

    const known = new Set(literals.map((literal) => literal.key));
    const unknown = Object.keys(translations).filter((key) => !known.has(key));
    if (unknown.length > 0) {
        // Almost always means the map was built against an older en.ts and a key moved or was
        // renamed. Silently dropping those would ship English in their place.
        throw new Error(
            `${unknown.length} translated keys no longer exist in ${SOURCE_LOCALE}.ts. Re-run extract and remap.\n` +
                unknown.slice(0, 10).map((key) => `  ${key}`).join('\n'),
        );
    }

    const { output, applied } = applyTranslations(source, literals, translations);
    // `--out` writes somewhere harmless so the result can be diffed before it replaces a locale
    // file. This checkout is shared and a locale file may carry edits made since the map was built.
    const outPath = readArg('out') ?? path.join(TRANSLATIONS_DIR, `${locale}.ts`);
    writeFileSync(outPath, toLocaleModule(output, locale));

    // A map may legitimately cover withheld literals too (round-tripping an existing locale supplies
    // every literal), so coverage is reported against the offered set rather than against `applied`.
    const offered = literals.filter((literal) => !isDoNotTranslate(literal.text));
    const covered = offered.filter((literal) => typeof translations[literal.key] === 'string').length;
    console.log(`rewrote ${applied} of ${literals.length} literals -> ${outPath}`);
    console.log(`translatable coverage: ${covered}/${offered.length}`);
    if (covered < offered.length) {
        console.log(`${offered.length - covered} offered strings were left in English — they will render as English until translated.`);
    }
    console.log('Next: register the locale in _all.ts, i18n.ts and i18n.integrity.test.ts.');
}

const command = process.argv[2];
if (command === 'extract') runExtract();
else if (command === 'build') runBuild();
else {
    console.error('usage: newLocale.ts extract --locale <code> [--out <file>]');
    console.error('       newLocale.ts build   --locale <code> --translations <file>');
    process.exit(1);
}
