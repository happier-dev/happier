import ts from 'typescript';

import { escapeForSite, extractLiterals, type LocaleLiteral } from './localeLiterals';

/**
 * Locale content that does NOT live in `<locale>.ts`.
 *
 * Several domains — provider settings, voice readiness and privacy, plugin permissions, external
 * sessions — were moved out of the per-locale files into shared modules under
 * `sources/text/translations/*Translations.ts`. Each module carries one block per locale, and a
 * locale file either ASSIGNS a block to a key:
 *
 *     settingsProviders: settingsProvidersTranslations.es,
 *
 * or SPREADS one into a parent:
 *
 *     ...externalSessionOperationTranslations.es,
 *
 * Two consequences that are easy to get wrong, and both were hit while adding French:
 *
 *  1. A new locale added ONLY to `<locale>.ts` silently renders English for every one of those
 *     domains, because `en.ts` delegates to the same modules and the fallback finds the `en` block.
 *     `findSatelliteReferences` exists so a locale can be checked for completeness against them.
 *  2. Some modules hold their own English (`const en = {...}`), so that English is NOT in `en.ts`
 *     and any extraction of `en.ts` alone misses it entirely — 378 strings, when French was added.
 *
 * A module's blocks are not uniformly shaped either: a locale entry can be a bare identifier
 * (`en`), a plain object, or a call wrapping the object (`translated({...})`,
 * `withProviderSharedFields(es, 'es')`). `addLocaleBlock` clones whichever shape is already there.
 */

export type SatelliteReference = {
    /** Variable name of the shared module, e.g. `settingsProvidersTranslations`. */
    module: string;
    /** `assign` mounts the block at `path`; `spread` merges its keys INTO `path`. */
    kind: 'assign' | 'spread';
    /** Key path in the locale tree that this module owns. Empty string means the root. */
    path: string;
};

/** Where a locale file hands subtrees off to shared modules, for the given locale block name. */
export function findSatelliteReferences(source: string, localeBlock: string, fileName = 'locale.ts'): SatelliteReference[] {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const references: SatelliteReference[] = [];

    const moduleOf = (expression: ts.Expression): string | null => {
        if (
            ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            expression.name.text === localeBlock
        ) {
            return expression.expression.text;
        }
        return null;
    };

    const walk = (node: ts.ObjectLiteralExpression, currentPath: string): void => {
        for (const property of node.properties) {
            if (ts.isSpreadAssignment(property)) {
                const module = moduleOf(property.expression);
                if (module) references.push({ module, kind: 'spread', path: currentPath });
                continue;
            }
            if (!ts.isPropertyAssignment(property)) continue;
            const name =
                ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null;
            if (name === null) continue;

            const childPath = currentPath ? `${currentPath}.${name}` : name;
            const module = moduleOf(property.initializer);
            if (module) {
                references.push({ module, kind: 'assign', path: childPath });
                continue;
            }
            if (ts.isObjectLiteralExpression(property.initializer)) walk(property.initializer, childPath);
        }
    };

    const findRoot = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            let initializer: ts.Expression = node.initializer;
            while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
                initializer = initializer.expression;
            }
            if (ts.isObjectLiteralExpression(initializer)) walk(initializer, '');
        }
        ts.forEachChild(node, findRoot);
    };
    ts.forEachChild(sourceFile, findRoot);

    return references;
}

function unwrap(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
    return current;
}

/**
 * Add a locale block to a shared module, cloning the shape of an existing one.
 *
 * `translations` is keyed the same way `extractLiterals` keys the MODULE's own literals, so the
 * caller can read the reference block, translate it, and hand the result straight back.
 */
export function addLocaleBlock(
    source: string,
    referenceLocale: string,
    newLocale: string,
    translations: Readonly<Record<string, string>>,
    fileName = 'module.ts',
): string {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const consts = new Map<string, ts.Expression>();
    let exportObject: ts.ObjectLiteralExpression | null = null;
    ts.forEachChild(sourceFile, (node) => {
        if (!ts.isVariableStatement(node)) return;
        for (const declaration of node.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            consts.set(declaration.name.text, declaration.initializer);
            const isExported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
            const initializer = unwrap(declaration.initializer);
            if (isExported && ts.isObjectLiteralExpression(initializer)) exportObject = initializer;
        }
    });
    if (!exportObject) throw new Error(`${fileName}: no exported object literal`);
    const exported: ts.ObjectLiteralExpression = exportObject;

    const nameOf = (property: ts.ObjectLiteralElementLike): string | null =>
        property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;

    if (exported.properties.some((property) => nameOf(property) === newLocale)) return source;

    const entry = exported.properties.find((property) => nameOf(property) === referenceLocale);
    if (!entry) throw new Error(`${fileName}: no '${referenceLocale}' entry to clone`);

    // Resolve the entry down to the object literal that actually holds the strings, through
    // identifiers and wrapper calls alike.
    const resolveObject = (expression: ts.Expression | undefined): ts.ObjectLiteralExpression | null => {
        if (!expression) return null;
        const current = unwrap(expression);
        if (ts.isIdentifier(current)) {
            const referenced = consts.get(current.text);
            return referenced ? resolveObject(referenced) : null;
        }
        if (ts.isObjectLiteralExpression(current)) return current;
        if (ts.isCallExpression(current)) {
            for (const argument of current.arguments) {
                const resolved = resolveObject(argument);
                if (resolved) return resolved;
            }
        }
        return null;
    };

    const initializer = ts.isShorthandPropertyAssignment(entry) ? consts.get(entry.name.text) : (entry as ts.PropertyAssignment).initializer;
    const objectLiteral = resolveObject(initializer);
    if (!objectLiteral) throw new Error(`${fileName}: could not resolve the '${referenceLocale}' object literal`);

    // Translate inside a clone of the reference object's SOURCE TEXT, so function parameters,
    // `${}` holes and formatting survive exactly.
    const objectStart = objectLiteral.getStart(sourceFile);
    const objectEnd = objectLiteral.getEnd();
    const literalsInObject = extractLiterals(source, fileName).filter(
        (literal) => literal.start >= objectStart && literal.end <= objectEnd,
    );
    const edits = literalsInObject
        .filter((literal): literal is LocaleLiteral => typeof translations[literal.key] === 'string')
        .map((literal) => ({
            start: literal.start,
            end: literal.end,
            text: escapeForSite(literal.raw, literal.delim, translations[literal.key]!),
        }))
        .sort((left, right) => right.start - left.start);

    let objectText = source.slice(objectStart, objectEnd);
    for (const edit of edits) {
        objectText = objectText.slice(0, edit.start - objectStart) + edit.text + objectText.slice(edit.end - objectStart);
    }

    // Re-emit whatever wrapper the reference entry used, swapping any locale tag argument.
    const unwrapped = initializer ? unwrap(initializer) : undefined;
    const wrapper = unwrapped && ts.isCallExpression(unwrapped) ? unwrapped : null;
    const newInitializer = wrapper
        ? `${wrapper.expression.getText(sourceFile)}(${wrapper.arguments
              .map((argument) => {
                  if (resolveObject(argument) === objectLiteral) return objectText;
                  if (ts.isStringLiteral(argument) && argument.text === referenceLocale) return `'${newLocale}'`;
                  return argument.getText(sourceFile);
              })
              .join(', ')})`
        : objectText;

    const insertAt = entry.getEnd() + (source[entry.getEnd()] === ',' ? 1 : 0);
    const lineStart = source.lastIndexOf('\n', entry.getStart(sourceFile)) + 1;
    const indent = source.slice(lineStart, entry.getStart(sourceFile)).match(/^\s*/)?.[0] ?? '    ';
    const key = /^[A-Za-z_$][\w$]*$/.test(newLocale) ? newLocale : `'${newLocale}'`;
    return `${source.slice(0, insertAt)}\n${indent}${key}: ${newInitializer},${source.slice(insertAt)}`;
}
