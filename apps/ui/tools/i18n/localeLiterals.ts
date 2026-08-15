import ts from 'typescript';

/**
 * Read and rewrite the translatable text inside a locale module, by source offset.
 *
 * A locale file is ~10k lines of TypeScript whose SHAPE is a contract: `i18n.integrity.test.ts`
 * requires identical key structure across locales, and the values are not all strings — many are
 * functions whose parameter lists are typechecked and whose bodies interpolate `${...}`.
 *
 * So a bulk locale edit never regenerates the object. It replaces only the *interior* of each
 * string/template literal and leaves every other byte alone, which makes structural parity a
 * property of the transform rather than something a translator has to avoid breaking.
 *
 * `localeLiterals.test.ts` pins that with an identity round-trip over every locale file. Two
 * properties of these files are why it exists, and both were found by it failing:
 *
 *   - The files MIX QUOTE STYLES. `'Cancel'` sits next to `"You're all caught up"`, which is
 *     double-quoted precisely because of the apostrophe. A rewriter cannot change the delimiter
 *     (it only owns the interior), so it must escape for whichever delimiter is already there.
 *   - Template literals write line breaks as the two characters `\n` rather than as real newlines.
 *
 * Both are handled by carrying each literal's `delim` and `raw` source interior and re-escaping
 * against them, rather than by normalising the file to one house style.
 */

export type LiteralKind = 'string' | 'template' | 'tpl-head' | 'tpl-middle' | 'tpl-tail';

export type LocaleLiteral = {
    /** Dotted key path plus occurrence index — stable across unrelated edits to the file. */
    key: string;
    kind: LiteralKind;
    /** The character that opens this literal: `'`, `"` or a backtick. */
    delim: string;
    /** Source offsets of the literal's INTERIOR, excluding its delimiters. */
    start: number;
    end: number;
    /** Cooked value, as the runtime sees it. */
    text: string;
    /** Exact source interior, still escaped. */
    raw: string;
};

function keyPathOf(node: ts.Node): string {
    const parts: string[] = [];
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
        if (ts.isPropertyAssignment(current) || ts.isMethodDeclaration(current)) {
            const name = current.name;
            if (ts.isIdentifier(name) || ts.isStringLiteral(name)) parts.unshift(name.text);
        } else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
            // Preamble extension consts are spread into the locale object; keeping the variable
            // name (prefixed) disambiguates their keys from same-named keys in the main tree.
            parts.unshift(`@${current.name.text}`);
        }
    }
    return parts.join('.');
}

/**
 * Every translatable literal in `source`, in source order.
 *
 * Deliberately skipped: type positions (`'morning' | 'evening'` is a union type, not copy),
 * import/export specifiers, and property NAMES (those are the structure the integrity test pins).
 */
export function extractLiterals(source: string, fileName = 'locale.ts'): LocaleLiteral[] {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const literals: LocaleLiteral[] = [];
    const occurrences = new Map<string, number>();

    const record = (node: ts.Node, kind: LiteralKind, start: number, end: number, text: string): void => {
        const path = keyPathOf(node);
        const seen = occurrences.get(path) ?? 0;
        occurrences.set(path, seen + 1);
        literals.push({
            key: `${path}#${seen}`,
            kind,
            delim: kind === 'string' ? source[start - 1]! : '`',
            start,
            end,
            text,
            raw: source.slice(start, end),
        });
    };

    const visit = (node: ts.Node): void => {
        if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if (ts.isPropertySignature(node) || ts.isEnumMember(node)) return;

        if (ts.isPropertyAssignment(node)) {
            visit(node.initializer);
            return;
        }
        if (ts.isStringLiteral(node)) {
            record(node, 'string', node.getStart(sourceFile) + 1, node.getEnd() - 1, node.text);
            return;
        }
        if (ts.isNoSubstitutionTemplateLiteral(node)) {
            record(node, 'template', node.getStart(sourceFile) + 1, node.getEnd() - 1, node.text);
            return;
        }
        if (ts.isTemplateExpression(node)) {
            // Head/middle/tail are the translatable chunks; the `${...}` expressions are untouched.
            // `- 2` on head/middle strips the trailing "${".
            record(node.head, 'tpl-head', node.head.getStart(sourceFile) + 1, node.head.getEnd() - 2, node.head.text);
            for (const span of node.templateSpans) {
                visit(span.expression);
                const literal = span.literal;
                const isTail = ts.isTemplateTail(literal);
                record(
                    literal,
                    isTail ? 'tpl-tail' : 'tpl-middle',
                    literal.getStart(sourceFile) + 1,
                    literal.getEnd() - (isTail ? 1 : 2),
                    literal.text,
                );
            }
            return;
        }
        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return literals;
}

/**
 * Escape `value` for the exact literal site it is being written back into.
 *
 * Follows the site's existing delimiter and newline convention instead of imposing one — see the
 * module comment for why the files are not uniform.
 */
export function escapeForSite(raw: string, delim: string, value: string): string {
    let escaped = value.replace(/\\/g, '\\\\');
    if (delim === '`') {
        escaped = escaped.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    } else {
        escaped = escaped.split(delim).join(`\\${delim}`);
    }
    if (!raw.includes('\n')) escaped = escaped.replace(/\n/g, '\\n');
    if (!raw.includes('\t')) escaped = escaped.replace(/\t/g, '\\t');
    return escaped;
}

export type ApplyResult = {
    output: string;
    applied: number;
    /** Keys present in `source` that the map did not cover. */
    untouched: number;
};

/** Rewrite `source`, substituting translations keyed by `LocaleLiteral.key`. */
export function applyTranslations(
    source: string,
    literals: readonly LocaleLiteral[],
    translations: Readonly<Record<string, string>>,
): ApplyResult {
    const edits: { start: number; end: number; text: string }[] = [];
    let untouched = 0;
    for (const literal of literals) {
        const replacement = translations[literal.key];
        if (typeof replacement !== 'string') {
            untouched += 1;
            continue;
        }
        edits.push({ start: literal.start, end: literal.end, text: escapeForSite(literal.raw, literal.delim, replacement) });
    }
    // Right-to-left so earlier offsets stay valid as the string grows or shrinks.
    edits.sort((left, right) => right.start - left.start);
    let output = source;
    for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    return { output, applied: edits.length, untouched };
}

export type RoundTripMismatch = { key: string; kind: LiteralKind; before: string; after: string };

/**
 * Feed every literal its own text, re-parse the result, and require every string to still say
 * exactly what it said.
 *
 * This is the gate that makes a bulk locale edit safe: if the escaper cannot reproduce the values
 * of the file it is about to rewrite, it must not rewrite it.
 *
 * The comparison is on VALUES, not bytes, and that is deliberate. Some locale files carry
 * redundantly escaped literals — `\"` inside a backtick template, where a double quote needs no
 * escape — and `escapeForSite` emits the minimal valid form instead. Normalising those is correct
 * and harmless (it only ever happens to a literal being rewritten anyway), so it must not be
 * reported as a failure. Use `findEscapeNormalisations` to see them.
 */
export function findRoundTripMismatches(source: string, literals: readonly LocaleLiteral[]): RoundTripMismatch[] {
    const identity = Object.fromEntries(literals.map((literal) => [literal.key, literal.text]));
    const { output } = applyTranslations(source, literals, identity);
    const reparsed = extractLiterals(output);

    const mismatches: RoundTripMismatch[] = [];
    const byKey = new Map(reparsed.map((literal) => [literal.key, literal]));
    for (const literal of literals) {
        const after = byKey.get(literal.key);
        if (!after) {
            mismatches.push({ key: literal.key, kind: literal.kind, before: literal.text, after: '<missing>' });
            continue;
        }
        if (after.text !== literal.text) {
            mismatches.push({ key: literal.key, kind: literal.kind, before: literal.text, after: after.text });
        }
    }
    if (reparsed.length !== literals.length) {
        mismatches.push({ key: '<count>', kind: 'string', before: String(literals.length), after: String(reparsed.length) });
    }
    return mismatches;
}

/**
 * Literals whose source spelling is not the minimal escaping — informational, not a defect.
 * Rewriting one of these normalises it; leaving it alone keeps it byte-identical.
 */
export function findEscapeNormalisations(literals: readonly LocaleLiteral[]): RoundTripMismatch[] {
    const normalisations: RoundTripMismatch[] = [];
    for (const literal of literals) {
        const minimal = escapeForSite(literal.raw, literal.delim, literal.text);
        if (minimal !== literal.raw) {
            normalisations.push({ key: literal.key, kind: literal.kind, before: literal.raw, after: minimal });
        }
    }
    return normalisations;
}

/**
 * Literals that must survive byte-identical: interpolation glue, code, flags, paths, URLs and
 * whole CLI invocations. Sending these to a translator is how `happier attach <session-id>`
 * becomes a command that does not run.
 *
 * This is a HEURISTIC for deciding what to *offer* a translator, never a licence to skip a string
 * silently. It cannot see a code span sitting inside a sentence — for that the marketing site keeps
 * an explicit per-key token list (`apps/website/src/i18n/generated/dnt.json`) and validates against
 * it, which is the right model whenever exact tokens have to survive inside prose.
 */
export function isDoNotTranslate(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === '') return true;
    // Pure punctuation, symbols or digits: interpolation glue such as " · " or "%".
    if (/^[\s\p{P}\p{S}\d]+$/u.test(text)) return true;
    if (/^https?:\/\//.test(trimmed)) return true;
    if (/^--?[\w-]+$/.test(trimmed)) return true;
    if (/\//.test(trimmed) && /^[~./]?[\w./*-]+$/.test(trimmed)) return true;
    // A whole command line: lowercase executable followed only by args, flags or <placeholders>.
    // The leading-lowercase requirement keeps ordinary sentences ("Choose a model") out.
    if (/^[a-z][\w.@/-]*(\s+(--?[\w-]+|<[\w-]+>|[\w.@:/*-]+))+$/.test(trimmed)) return true;
    return false;
}
