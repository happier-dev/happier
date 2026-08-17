import { readFileSync } from 'node:fs';
import path from 'node:path';

import { extractLiterals, isDoNotTranslate, type LocaleLiteral } from './localeLiterals';

/**
 * Check a filled translation map BEFORE it is written into a locale file.
 *
 *   yarn i18n:locale:verify -- --translations /tmp/fr.json
 *
 * A translation can fail in ways neither the typecheck nor the integrity test will ever see,
 * because the file still compiles and still has the right keys:
 *
 *   whitespace   Many strings are fragments either side of a `${...}` hole. `" and "` coming back
 *                as `"et"` glues two words to the interpolated value.
 *   interpolation A stray `${` in the translation breaks the build; a translated placeholder name
 *                breaks the sentence at runtime.
 *   code         A localised `--force`, path or CLI invocation is a command that does not run.
 *   newlines     A dropped `\n` collapses a multi-line alert into one line.
 *
 * Every one of these was observed while translating this app into French, which is why they are
 * checked mechanically rather than reviewed by eye across thousands of strings.
 *
 * Keys namespaced `<module>::<key>` belong to a shared translation module; pass `--source` to
 * validate those against the module they came from.
 */

const TRANSLATIONS_DIR = path.join(__dirname, '../../sources/text/translations');
const SOURCE_LOCALE = 'en';
const MODULE_KEY_SEPARATOR = '::';

type Problem = { kind: string; key: string; en: string; translated: string };

function readArg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
}

export function findTranslationProblems(
    literals: readonly LocaleLiteral[],
    translations: Readonly<Record<string, string>>,
): { problems: Problem[]; missing: string[] } {
    const byKey = new Map(literals.map((literal) => [literal.key, literal]));
    const problems: Problem[] = [];

    for (const [rawKey, translated] of Object.entries(translations)) {
        // Module-scoped keys are validated against their own module, not against en.ts.
        const separator = rawKey.indexOf(MODULE_KEY_SEPARATOR);
        const key = separator === -1 ? rawKey : rawKey.slice(separator + MODULE_KEY_SEPARATOR.length);
        const literal = byKey.get(key);
        if (!literal) {
            if (separator === -1) problems.push({ kind: 'unknown-key', key: rawKey, en: '', translated });
            continue;
        }
        const en = literal.text;
        const push = (kind: string): void => void problems.push({ kind, key: rawKey, en, translated });

        if (typeof translated !== 'string') { push('not-a-string'); continue; }
        // Fragment boundaries are part of the sentence, not formatting.
        if (/^\s/.test(en) !== /^\s/.test(translated)) push('leading-whitespace');
        if (/\s$/.test(en) !== /\s$/.test(translated)) push('trailing-whitespace');
        if (translated.includes('${')) push('interpolation-introduced');
        if ((en.match(/\n/g)?.length ?? 0) !== (translated.match(/\n/g)?.length ?? 0)) push('newline-count');
        if (isDoNotTranslate(en) && translated !== en) push('code-modified');
    }

    const covered = new Set(
        Object.keys(translations).map((key) => {
            const separator = key.indexOf(MODULE_KEY_SEPARATOR);
            return separator === -1 ? key : key.slice(separator + MODULE_KEY_SEPARATOR.length);
        }),
    );
    const missing = literals
        .filter((literal) => !isDoNotTranslate(literal.text) && !covered.has(literal.key))
        .map((literal) => literal.key);

    return { problems, missing };
}

const translationsPath = readArg('translations');
if (!translationsPath) {
    console.error('usage: validateTranslationMap.ts --translations <file> [--source <locale.ts>]');
    process.exit(1);
}

const sourceFile = readArg('source') ?? path.join(TRANSLATIONS_DIR, `${SOURCE_LOCALE}.ts`);
const literals = extractLiterals(readFileSync(sourceFile, 'utf8'), path.basename(sourceFile));
const translations = JSON.parse(readFileSync(translationsPath, 'utf8')) as Record<string, string>;
const { problems, missing } = findTranslationProblems(literals, translations);

const byKind = new Map<string, number>();
for (const problem of problems) byKind.set(problem.kind, (byKind.get(problem.kind) ?? 0) + 1);

console.log(`translated  : ${Object.keys(translations).length}`);
console.log(`untranslated: ${missing.length} (these will render as English)`);
for (const [kind, count] of [...byKind].sort((left, right) => right[1] - left[1])) {
    console.log(`${kind.padEnd(24)}: ${count}`);
}
for (const problem of problems.slice(0, 20)) {
    console.log(`  [${problem.kind}] ${problem.key}\n     en: ${JSON.stringify(problem.en)}\n     tr: ${JSON.stringify(problem.translated)}`);
}

// Missing strings are a coverage report, not an error — a partial locale renders English and is a
// legitimate intermediate state. A malformed one is not.
process.exit(problems.length > 0 ? 1 : 0);
