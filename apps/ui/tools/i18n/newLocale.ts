import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { applyTranslations, extractLiterals, findRoundTripMismatches, isDoNotTranslate } from './localeLiterals';
import { findSatelliteReferences, replaceLocaleBlock } from './satelliteModules';

/**
 * Author a new locale, or retranslate an existing one, without hand-editing a 13k-line file.
 *
 *   yarn i18n:locale:extract -- --locale fr --out /tmp/fr.todo.json
 *   …fill in the translations…
 *   yarn i18n:locale:build   -- --locale fr --translations /tmp/fr.json --out /tmp/fr.preview.ts
 *   yarn i18n:locale:build   -- --locale fr --translations /tmp/fr.json
 *
 * Keys are `<key path>#<occurrence>`, so `build` re-extracts from the CURRENT source and matches by
 * key rather than by position — English can move underneath a half-finished translation without
 * silently pairing a translated string with the wrong English one.
 *
 * THIS APP SPLITS ITS COPY ACROSS TWO PLACES, and both are handled here:
 *
 *   - `en.ts`, the main tree.
 *   - shared modules (`*Translations.ts`) holding one block per locale, which the locale files
 *     mount by assignment or spread. Some of those modules carry their own English, so that English
 *     is NOT in `en.ts` at all. A locale built only from `en.ts` renders English for those whole
 *     domains — silently, because the runtime fallback finds the module's `en` block.
 *
 * `extract` therefore offers strings from `en.ts` AND from each module, namespacing module keys as
 * `<module>::<key>`; `build` writes the locale file and inserts a block into each module.
 */

const TRANSLATIONS_DIR = path.join(__dirname, '../../sources/text/translations');
const SOURCE_LOCALE = 'en';
const MODULE_KEY_SEPARATOR = '::';

type ExtractManifest = {
    locale: string;
    entries: { key: string; en: string }[];
    withheld: number;
    /** Shared modules this locale must also gain a block in. */
    modules: string[];
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

/** Modules the English locale file delegates to, that exist as their own file. */
function satelliteModuleFiles(): { module: string; file: string }[] {
    const source = readFileSync(sourcePath(), 'utf8');
    const seen = new Set<string>();
    const modules: { module: string; file: string }[] = [];
    for (const reference of findSatelliteReferences(source, SOURCE_LOCALE, `${SOURCE_LOCALE}.ts`)) {
        if (seen.has(reference.module)) continue;
        seen.add(reference.module);
        const file = path.join(TRANSLATIONS_DIR, `${reference.module}.ts`);
        // Extension consts declared inside the locale file itself have no module of their own.
        if (existsSync(file)) modules.push({ module: reference.module, file });
    }
    return modules;
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

    const entries = literals
        .filter((literal) => !isDoNotTranslate(literal.text))
        .map((literal) => ({ key: literal.key, en: literal.text }));
    let withheld = literals.length - entries.length;

    const modules: string[] = [];
    for (const { module, file } of satelliteModuleFiles()) {
        const moduleSource = readFileSync(file, 'utf8');
        const moduleLiterals = extractLiterals(moduleSource, `${module}.ts`)
            // Only the module's own ENGLISH block; the other locales are already translated.
            .filter((literal) => /^@(en|english)\./.test(literal.key) || /^@[^.]+\.en\./.test(literal.key));
        if (moduleLiterals.length === 0) continue;
        modules.push(module);
        for (const literal of moduleLiterals) {
            if (isDoNotTranslate(literal.text)) { withheld += 1; continue; }
            entries.push({ key: `${module}${MODULE_KEY_SEPARATOR}${literal.key}`, en: literal.text });
        }
    }

    const manifest: ExtractManifest = { locale, entries, withheld, modules };
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`offered ${entries.length} strings (${withheld} withheld as code/paths/glue) -> ${outPath}`);
    console.log(`  of which from shared modules: ${entries.filter((entry) => entry.key.includes(MODULE_KEY_SEPARATOR)).length} across ${modules.length} module(s)`);
}

/**
 * `en.ts` is both a locale AND the file that DEFINES the shape contract (`DeepTranslationShape`,
 * `TranslationStructure`). A locale file only consumes that contract, so the header and footer are
 * rewritten while the lines between them are left exactly as the translation left them.
 *
 * The satellite references are re-pointed too: a locale file built from `en.ts` would otherwise
 * still read `someTranslations.en` and render English for that whole subtree.
 */
function toLocaleModule(translated: string, locale: string, modules: readonly string[]): string {
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

    if (modules.length > 0) {
        const pattern = new RegExp(`\\b(${modules.join('|')})\\.${SOURCE_LOCALE}\\b`, 'g');
        output = output.replace(pattern, `$1.${localeConst}`);
    }

    const tailAnchor = output.indexOf('type DeepTranslationShape<T> =');
    if (tailAnchor === -1) throw new Error('anchor `type DeepTranslationShape` not found — en.ts changed shape');
    return `${output.slice(0, tailAnchor).replace(/\s*$/, '\n')}\nexport type Translations${capitalise(locale)} = typeof ${localeConst};\n`;
}

function runBuild(): void {
    const locale = requireArg('locale');
    const localeConst = locale.replace(/-/g, '');
    const translations = JSON.parse(readFileSync(requireArg('translations'), 'utf8')) as Record<string, string>;

    // Split the map back into the main tree and the per-module blocks.
    const mainTranslations: Record<string, string> = {};
    const moduleTranslations = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(translations)) {
        const separator = key.indexOf(MODULE_KEY_SEPARATOR);
        if (separator === -1) { mainTranslations[key] = value; continue; }
        const module = key.slice(0, separator);
        const moduleKey = key.slice(separator + MODULE_KEY_SEPARATOR.length);
        const bucket = moduleTranslations.get(module) ?? {};
        bucket[moduleKey] = value;
        moduleTranslations.set(module, bucket);
    }

    const source = readFileSync(sourcePath(), 'utf8');
    const literals = extractLiterals(source, `${SOURCE_LOCALE}.ts`);
    const known = new Set(literals.map((literal) => literal.key));
    const unknown = Object.keys(mainTranslations).filter((key) => !known.has(key));
    if (unknown.length > 0) {
        // Almost always means the map was built against an older en.ts and a key moved or was
        // renamed. Silently dropping those would ship English in their place.
        throw new Error(
            `${unknown.length} translated keys no longer exist in ${SOURCE_LOCALE}.ts. Re-run extract and remap.\n` +
                unknown.slice(0, 10).map((key) => `  ${key}`).join('\n'),
        );
    }

    const modules = satelliteModuleFiles();
    const { output, applied } = applyTranslations(source, literals, mainTranslations);
    const outPath = readArg('out') ?? path.join(TRANSLATIONS_DIR, `${locale}.ts`);
    writeFileSync(outPath, toLocaleModule(output, locale, modules.map((entry) => entry.module)));

    const offered = literals.filter((literal) => !isDoNotTranslate(literal.text));
    const covered = offered.filter((literal) => typeof mainTranslations[literal.key] === 'string').length;
    console.log(`rewrote ${applied} of ${literals.length} literals -> ${outPath}`);
    console.log(`translatable coverage: ${covered}/${offered.length}`);

    // `--out` is a preview of the locale file only; leave the shared modules alone.
    if (readArg('out')) {
        console.log(`preview only — ${modules.length} shared module(s) NOT modified; re-run without --out to write them.`);
        return;
    }

    for (const { module, file } of modules) {
        const moduleTranslation = moduleTranslations.get(module);
        if (!moduleTranslation) {
            console.log(`WARNING ${module}: no translations supplied — this locale will render English for that domain.`);
            continue;
        }
        const moduleSource = readFileSync(file, 'utf8');
        const updated = replaceLocaleBlock(moduleSource, SOURCE_LOCALE, localeConst, moduleTranslation, `${module}.ts`);
        if (updated === moduleSource) {
            console.log(`${module}: already has '${localeConst}'`);
            continue;
        }
        writeFileSync(file, updated);
        console.log(`${module}: inserted '${localeConst}' (${Object.keys(moduleTranslation).length} strings)`);
    }

    console.log('Next: register the locale in _all.ts, i18n.ts and i18n.integrity.test.ts.');
}

const command = process.argv[2];
if (command === 'extract') runExtract();
else if (command === 'build') runBuild();
else {
    console.error('usage: newLocale.ts extract --locale <code> [--out <file>]');
    console.error('       newLocale.ts build   --locale <code> --translations <file> [--out <file>]');
    process.exit(1);
}
