import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { en } from '../../sources/text/translations/en.js';
import {
    SUPPORTED_LANGUAGE_CODES,
    type SupportedLanguage,
} from '../../sources/text/_all.js';

const INLINE_TRANSLATION_BUNDLE_FILES = [
    'elevenlabs/src/manifest.ts',
    'google/src/voice/declarations.ts',
    'inspector/src/manifest.ts',
    'openai-compat/src/manifest.ts',
    'posthog/src/manifest.ts',
    'scm-azure-devops/src/manifest.ts',
    'scm-bitbucket/src/manifest.ts',
    'scm-github/src/manifest.ts',
    'scm-gitlab/src/manifest.ts',
    'sentry/src/manifest.ts',
] as const;

const MODULE_BUNDLES = [
    'channel-discord',
    'channel-telegram',
    'channels',
    'claude',
    'codex',
    'copilot',
    'gemini',
    'grok',
    'ohmypi',
    'pi',
    'posthog',
    'scm-azure-devops',
    'sentry',
    'triage',
] as const;

const ADDITIONAL_MODULE_BUNDLES = [
    'inspector/src/ui/additionalTranslations.ts',
    'posthog/src/ui/renderTranslations.ts',
    'sentry/src/ui/renderTranslations.ts',
    'scm-azure-devops/src/ui/renderTranslations.ts',
    'scm-azure-devops/src/ui/additionalTranslations.ts',
    'scm-bitbucket/src/ui/renderTranslations.ts',
    'scm-bitbucket/src/ui/additionalTranslations.ts',
    'scm-github/src/ui/renderTranslations.ts',
    'scm-github/src/ui/additionalTranslations.ts',
    'scm-gitlab/src/ui/renderTranslations.ts',
    'scm-gitlab/src/ui/additionalTranslations.ts',
    'triage/src/ui/additionalTranslations.ts',
] as const;

// This source deliberately composes most non-English publication copy from
// reviewed English defaults while localizing every remote-write confirmation.
// It owns real fallback keys, but is not an exact-locale-parity bundle.
const ADDITIONAL_CATALOG_SOURCES = [
    'scm-azure-devops/src/ui/publicationTranslations.ts',
] as const;

type Bundle = Readonly<{ locale: string; keys: readonly string[]; values: readonly string[] }>;

const INTENTIONALLY_UNTRANSLATED_PLUGIN_VALUES = new Set([
    'Azure DevOps',
    'Bitbucket Cloud',
    'Claude Code',
    'Codex',
    'Conversation',
    'Destination',
    'GitHub',
    'GitHub Copilot',
    'GitLab',
    'Google Gemini',
    'Grok',
    'Grok Build CLI (experimental)',
    'OpenAI Codex',
    'Oh My Pi',
    'Pi',
    'PostHog',
    'PostHog URL',
    'Sentry',
    'Sentry URL',
    'Azure DevOps URL',
    'Session',
    'Transport',
    'Automation',
    'minute',
    'minutes',
]);

const FORBIDDEN_SCRIPTS_BY_LOCALE: Readonly<Partial<Record<SupportedLanguage, RegExp>>> = {
    ru: /[\u3040-\u30ff\u3400-\u9fff]/,
    pl: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    es: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    fr: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    it: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    pt: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    ca: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    de: /[\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff]/,
    'zh-Hans': /[\u0400-\u04ff\u3040-\u30ff]/,
    'zh-Hant': /[\u0400-\u04ff\u3040-\u30ff]/,
    ja: /[\u0400-\u04ff]/,
};

function propertyName(node: ts.PropertyName): string | null {
    return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function unwrapObject(node: ts.Expression): ts.ObjectLiteralExpression | null {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
        return unwrapObject(node.expression);
    }
    if (ts.isCallExpression(node)) {
        // Catalog helpers may take a locale discriminator before the literal
        // messages object. The literal remains the author-owned portion this
        // source validator can inspect; generated/spread keys retain their
        // package-local parity tests.
        for (const argument of [...node.arguments].reverse()) {
            const object = unwrapObject(argument);
            if (object !== null) return object;
        }
    }
    return null;
}

function stringValue(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = stringValue(node.left);
        const right = stringValue(node.right);
        return left === null || right === null ? null : left + right;
    }
    return null;
}

function readMessageObject(
    object: ts.ObjectLiteralExpression,
    locale: string,
    resolveName: (name: ts.PropertyName) => string | null = propertyName,
    resolveValue: (expression: ts.Expression) => string | null = stringValue,
): Bundle {
    const entries = object.properties.flatMap((property) => {
        if (ts.isSpreadAssignment(property)) return [];
        if (!ts.isPropertyAssignment(property)) throw new Error(`${locale}: non-literal translation entry`);
        const key = resolveName(property.name);
        const value = resolveValue(property.initializer);
        if (!key || value === null) throw new Error(`${locale}: non-literal translation entry`);
        return [[key, value] as const];
    });
    return { locale, keys: entries.map(([key]) => key), values: entries.map(([, value]) => value) };
}

function readInlineManifestBundles(file: string): readonly Bundle[] {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const stringConstants = new Map<string, string>();
    for (const statement of root.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const value = stringValue(declaration.initializer);
            if (value !== null) stringConstants.set(declaration.name.text, value);
        }
    }
    const resolveString = (expression: ts.Expression): string | null => (
        stringValue(expression)
        ?? (ts.isIdentifier(expression) ? stringConstants.get(expression.text) ?? null : null)
    );
    const resolvePropertyName = (name: ts.PropertyName): string | null => (
        ts.isComputedPropertyName(name)
            ? resolveString(name.expression)
            : propertyName(name)
    );
    let bundles: Bundle[] | null = null;
    function visit(node: ts.Node): void {
        if (bundles || !ts.isPropertyAssignment(node) || propertyName(node.name) !== 'translations'
            || !ts.isArrayLiteralExpression(node.initializer)) {
            ts.forEachChild(node, visit);
            return;
        }
        const parsed = node.initializer.elements.map((element): Bundle | null => {
            const object = unwrapObject(element as ts.Expression);
            if (!object) return null;
            const localeProperty = object.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'locale');
            const messagesProperty = object.properties.find((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === 'messages');
            if (!localeProperty || !messagesProperty || !ts.isPropertyAssignment(localeProperty) || !ts.isPropertyAssignment(messagesProperty)) return null;
            const locale = resolveString(localeProperty.initializer);
            const messages = unwrapObject(messagesProperty.initializer);
            return locale && messages
                ? readMessageObject(messages, locale, resolvePropertyName, resolveString)
                : null;
        });
        if (parsed.length > 0 && parsed.every((entry): entry is Bundle => entry !== null)) bundles = parsed;
    }
    visit(root);
    if (!bundles) throw new Error(`${file}: literal translations bundle not found`);
    return bundles;
}

function readModuleBundles(file: string): readonly Bundle[] {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of root.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('_UI_TRANSLATIONS') || !declaration.initializer) continue;
            const object = unwrapObject(declaration.initializer);
            if (!object) continue;
            return object.properties.map((property) => {
                if (!ts.isPropertyAssignment(property)) throw new Error(`${file}: non-literal locale bundle`);
                const locale = propertyName(property.name);
                const messages = unwrapObject(property.initializer);
                if (!locale || !messages) throw new Error(`${file}: non-literal locale bundle`);
                return readMessageObject(messages, locale);
            });
        }
    }
    throw new Error(`${file}: *_UI_TRANSLATIONS object not found`);
}

function readGeneratedHostBundles(file: string): ReadonlyMap<string, Readonly<Record<string, string>>> {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of root.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)
                || declaration.name.text !== 'BUNDLED_PLUGIN_TRANSLATIONS'
                || !declaration.initializer) continue;
            const localeObject = unwrapObject(declaration.initializer);
            if (!localeObject) break;
            return new Map(localeObject.properties.map((property) => {
                if (!ts.isPropertyAssignment(property)) throw new Error(`${file}: non-literal generated locale`);
                const locale = propertyName(property.name);
                const messages = unwrapObject(property.initializer);
                if (!locale || !messages) throw new Error(`${file}: non-literal generated locale`);
                const bundle = readMessageObject(messages, locale);
                return [locale, Object.fromEntries(bundle.keys.map((key, index) => [key, bundle.values[index]]))] as const;
            }));
        }
    }
    throw new Error(`${file}: BUNDLED_PLUGIN_TRANSLATIONS object not found`);
}

function placeholders(value: string): readonly string[] {
    return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
        .map((match) => match[1] ?? '')
        .sort();
}

function assertComplete(file: string, bundles: readonly Bundle[]): void {
    const locales = bundles.map(({ locale }) => locale);
    expect(new Set(locales).size, `${file}: duplicate translation locale`).toBe(locales.length);
    expect(SUPPORTED_LANGUAGE_CODES.every((locale) => locales.includes(locale)), `${file}: missing supported host locale`).toBe(true);
    const english = bundles.find(({ locale }) => locale === 'en');
    expect(english, `${file}: missing English translation bundle`).toBeDefined();
    for (const bundle of bundles) {
        expect(new Set(bundle.keys).size, `${file}:${bundle.locale}: duplicate translation key`).toBe(bundle.keys.length);
        expect(bundle.keys, `${file}:${bundle.locale}`).toEqual(english?.keys);
        expect(bundle.values.every((value) => value.trim().length > 0), `${file}:${bundle.locale}`).toBe(true);
        expect(bundle.values.every((value) => value === value.trim()), `${file}:${bundle.locale}: padded translation`).toBe(true);
        const placeholderDrift = bundle.values.flatMap((value, index) => (
            JSON.stringify(placeholders(value)) === JSON.stringify(placeholders(english?.values[index] ?? ''))
                ? []
                : [bundle.keys[index]]
        ));
        expect(placeholderDrift, `${file}:${bundle.locale}: interpolation placeholder drift`).toEqual([]);
        const forbiddenScript = FORBIDDEN_SCRIPTS_BY_LOCALE[bundle.locale as SupportedLanguage];
        if (forbiddenScript) {
            const contaminated = bundle.values.flatMap((value, index) => (
                forbiddenScript.test(value) ? [bundle.keys[index]] : []
            ));
            expect(contaminated, `${file}:${bundle.locale}: mixed-script translation`).toEqual([]);
        }
        if (bundle.locale !== 'en' && english) {
            const untranslated = bundle.values.flatMap((value, index) => (
                value === english.values[index] && !INTENTIONALLY_UNTRANSLATED_PLUGIN_VALUES.has(value)
                    ? [bundle.keys[index]]
                    : []
            ));
            expect(untranslated, `${file}:${bundle.locale}: English fallback copy`).toEqual([]);
        }
    }
}

function unlocalizedLiteralFallbacks(file: string): readonly string[] {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const gaps: string[] = [];
    function expressionHasTranslatableText(expression: ts.Expression, ignoreAllCalls: boolean): boolean {
        let found = false;
        function inspect(node: ts.Node): void {
            if (found) return;
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                const isTranslationCall = ts.isIdentifier(callee)
                    ? callee.text === 'text'
                        || callee.text === 't'
                        || callee.text === 'translate'
                        || callee.text === 'parseResourceErrorMessage'
                    : ts.isPropertyAccessExpression(callee) && callee.name.text === 't';
                // Direct Text call results are provider/author data. Other JSX
                // props still inspect non-translation calls because their literal
                // fallbacks are executable chrome too.
                if (ignoreAllCalls || isTranslationCall) return;
                for (const argument of node.arguments) inspect(argument);
                return;
            }
            if (ts.isConditionalExpression(node)) {
                inspect(node.whenTrue);
                inspect(node.whenFalse);
                return;
            }
            if (ts.isBinaryExpression(node)) {
                if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                    inspect(node.left);
                    inspect(node.right);
                } else if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
                    inspect(node.right);
                }
                return;
            }
            if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
                && /[A-Za-z]{3}/.test(node.text)) {
                found = true;
                return;
            }
            if (ts.isTemplateExpression(node)) {
                const staticText = node.head.text + node.templateSpans.map((span) => span.literal.text).join('');
                if (/[A-Za-z]{3}/.test(staticText)) {
                    found = true;
                    return;
                }
            }
            ts.forEachChild(node, inspect);
        }
        inspect(expression);
        return found;
    }
    function visit(node: ts.Node): void {
        if (ts.isJsxElement(node)) {
            const tagName = node.openingElement.tagName;
            const isText = ts.isIdentifier(tagName) && tagName.text === 'Text';
            if (isText) {
                for (const child of node.children) {
                    const literal = ts.isJsxText(child)
                        ? child.text.trim()
                        : ts.isJsxExpression(child)
                            && child.expression
                            && (ts.isStringLiteral(child.expression) || ts.isNoSubstitutionTemplateLiteral(child.expression))
                            ? child.expression.text.trim()
                            : '';
                    if (literal.length > 0) {
                        const location = root.getLineAndCharacterOfPosition(child.getStart(root));
                        gaps.push(`${file}:${location.line + 1}:Text=${JSON.stringify(literal)}`);
                    } else if (ts.isJsxExpression(child)
                        && child.expression
                        && expressionHasTranslatableText(child.expression, true)) {
                        const location = root.getLineAndCharacterOfPosition(child.getStart(root));
                        gaps.push(`${file}:${location.line + 1}:Text=${JSON.stringify(child.expression.getText(root))}`);
                    }
                }
            }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const attributes = new Map(node.attributes.properties.flatMap((property) => (
                ts.isJsxAttribute(property) && ts.isIdentifier(property.name)
                    ? [[property.name.text, property] as const]
                    : []
            )));
            for (const [fallbackName, keyName] of [
                ['title', 'titleKey'],
                ['description', 'descriptionKey'],
                ['label', 'labelKey'],
                ['placeholder', 'placeholderKey'],
                ['accessibilityLabel', 'accessibilityLabelKey'],
            ] as const) {
                const fallback = attributes.get(fallbackName)?.initializer;
                if (fallback && ts.isStringLiteral(fallback) && !attributes.has(keyName)) {
                    const location = root.getLineAndCharacterOfPosition(fallback.getStart(root));
                    gaps.push(`${file}:${location.line + 1}:${fallbackName}=${JSON.stringify(fallback.text)}`);
                } else if (fallback
                    && ts.isJsxExpression(fallback)
                    && fallback.expression
                    && !attributes.has(keyName)
                    && expressionHasTranslatableText(fallback.expression, false)) {
                    const location = root.getLineAndCharacterOfPosition(fallback.getStart(root));
                    gaps.push(`${file}:${location.line + 1}:${fallbackName}=${JSON.stringify(fallback.expression.getText(root))}`);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(root);
    return gaps;
}

function collectTranslationKeys(value: unknown, prefix = ''): readonly string[] {
    if (value === null || typeof value !== 'object') return prefix.length > 0 ? [prefix] : [];
    return Object.entries(value).flatMap(([key, nested]) => (
        collectTranslationKeys(nested, prefix.length === 0 ? key : `${prefix}.${key}`)
    ));
}

function sourceFilesBelow(directory: string): readonly string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'dist' || entry.name === 'node_modules'
            ? []
            : sourceFilesBelow(absolute);
        return entry.isFile()
            && /\.(?:ts|tsx)$/.test(entry.name)
            && !/\.(?:test|test-d)\.(?:ts|tsx)$/.test(entry.name)
            ? [absolute]
            : [];
    });
}

function localizedFallbackKeys(file: string): readonly string[] {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const keys: string[] = [];
    function visit(node: ts.Node): void {
        if (ts.isObjectLiteralExpression(node)) {
            const keyProperty = node.properties.find((property) => (
                ts.isPropertyAssignment(property) && propertyName(property.name) === 'key'
            ));
            const fallbackProperty = node.properties.find((property) => (
                ts.isPropertyAssignment(property) && propertyName(property.name) === 'fallback'
            ));
            if (keyProperty && fallbackProperty
                && ts.isPropertyAssignment(keyProperty)
                && ts.isPropertyAssignment(fallbackProperty)) {
                const key = stringValue(keyProperty.initializer);
                const fallback = stringValue(fallbackProperty.initializer);
                if (key !== null && fallback !== null) keys.push(key);
            }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const attributes = new Map(node.attributes.properties.flatMap((property) => (
                ts.isJsxAttribute(property)
                    && ts.isIdentifier(property.name)
                    && property.initializer !== undefined
                    ? [[property.name.text, property.initializer] as const]
                    : []
            )));
            for (const [fallbackName, keyName] of [
                ['title', 'titleKey'],
                ['description', 'descriptionKey'],
                ['label', 'labelKey'],
                ['placeholder', 'placeholderKey'],
                ['accessibilityLabel', 'accessibilityLabelKey'],
                ['fallback', 'valueKey'],
            ] as const) {
                const fallbackAttribute = attributes.get(fallbackName);
                const keyAttribute = attributes.get(keyName);
                const fallback = fallbackAttribute !== undefined && ts.isStringLiteral(fallbackAttribute)
                    ? fallbackAttribute.text
                    : null;
                const key = keyAttribute !== undefined && ts.isStringLiteral(keyAttribute)
                    ? keyAttribute.text
                    : null;
                if (fallback !== null && key !== null) keys.push(key);
            }
        }
        if (ts.isCallExpression(node) && node.arguments.length >= 2) {
            const key = stringValue(node.arguments[0]);
            const fallback = stringValue(node.arguments[1]);
            if (key?.startsWith('plugins.') === true && fallback !== null) keys.push(key);
        }
        ts.forEachChild(node, visit);
    }
    visit(root);
    return keys;
}

/** Collect catalog-owned keys even when locale records use tuples or spreads. */
function localizedCatalogKeys(file: string): readonly string[] {
    const source = readFileSync(file, 'utf8');
    const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const keys = new Set<string>();
    function visit(node: ts.Node): void {
        if (ts.isPropertyAssignment(node)) {
            const key = propertyName(node.name);
            if (key?.includes('.') === true) keys.add(key);
        }
        if (ts.isStringLiteralLike(node)
            && ts.isArrayLiteralExpression(node.parent)
            && /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/u.test(node.text)) {
            keys.add(node.text);
        }
        ts.forEachChild(node, visit);
    }
    visit(root);
    return [...keys];
}

describe('built-in plugin translation bundles', () => {
    it('covers every supported host locale with exact key parity', () => {
        const root = path.resolve(__dirname, '../../../..');
        for (const relativeFile of INLINE_TRANSLATION_BUNDLE_FILES) {
            const file = path.join(root, 'packages/plugins', relativeFile);
            assertComplete(file, readInlineManifestBundles(file));
        }
        for (const plugin of MODULE_BUNDLES) {
            const file = path.join(root, 'packages/plugins', plugin, 'src/ui/translations.ts');
            assertComplete(file, readModuleBundles(file));
        }
        for (const relativeFile of ADDITIONAL_MODULE_BUNDLES) {
            const file = path.join(root, 'packages/plugins', relativeFile);
            assertComplete(file, readModuleBundles(file));
        }
    });

    it('keeps the generated host bundle synchronized with source plugin catalogs', () => {
        const root = path.resolve(__dirname, '../../../..');
        const pluginRoot = path.join(root, 'packages/plugins');
        const generatedByLocale = readGeneratedHostBundles(
            path.join(root, 'apps/ui/sources/text/bundledPluginTranslations.generated.ts'),
        );

        for (const plugin of MODULE_BUNDLES) {
            const file = path.join(pluginRoot, plugin, 'src/ui/translations.ts');
            for (const bundle of readModuleBundles(file)) {
                const generated = generatedByLocale.get(bundle.locale);
                expect(generated, `${plugin}:${bundle.locale}: missing generated locale`).toBeDefined();
                expect(
                    generated,
                    `${plugin}:${bundle.locale}: generated host bundle drift`,
                ).toMatchObject(
                    Object.fromEntries(bundle.keys.map((key, index) => [key, bundle.values[index]])),
                );
            }
        }
    });

    it('resolves every built-in localized fallback key from a real catalog', () => {
        const root = path.resolve(__dirname, '../../../..');
        const pluginRoot = path.join(root, 'packages/plugins');
        const declared = new Set<string>(collectTranslationKeys(en));

        for (const relativeFile of INLINE_TRANSLATION_BUNDLE_FILES) {
            for (const key of localizedCatalogKeys(path.join(pluginRoot, relativeFile))) declared.add(key);
        }
        for (const plugin of MODULE_BUNDLES) {
            for (const key of localizedCatalogKeys(
                path.join(pluginRoot, plugin, 'src/ui/translations.ts'),
            )) declared.add(key);
        }
        for (const relativeFile of ADDITIONAL_MODULE_BUNDLES) {
            for (const key of localizedCatalogKeys(path.join(pluginRoot, relativeFile))) declared.add(key);
        }
        for (const relativeFile of ADDITIONAL_CATALOG_SOURCES) {
            for (const key of localizedCatalogKeys(path.join(pluginRoot, relativeFile))) declared.add(key);
        }

        const missing = readdirSync(pluginRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .filter((entry) => existsSync(path.join(pluginRoot, entry.name, 'src')))
            .flatMap((entry) => sourceFilesBelow(path.join(pluginRoot, entry.name, 'src'))
                .flatMap((file) => localizedFallbackKeys(file)
                    .filter((key) => !declared.has(key))
                    .map((key) => `${entry.name}:${key}`)))
            .sort();

        expect(missing).toEqual([]);
    });

    it('does not leave literal built-in UI chrome outside the translation-key seam', () => {
        const root = path.resolve(__dirname, '../../../..');
        const pluginRoot = path.join(root, 'packages/plugins');
        const gaps = readdirSync(pluginRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .filter((entry) => existsSync(path.join(pluginRoot, entry.name, 'src')))
            .flatMap((entry) => sourceFilesBelow(path.join(pluginRoot, entry.name, 'src'))
                .flatMap(unlocalizedLiteralFallbacks))
            .sort();

        expect(gaps).toEqual([]);
    });
});
