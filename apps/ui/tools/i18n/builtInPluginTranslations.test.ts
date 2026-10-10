import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

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
    'cliproxyapi',
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

type Bundle = Readonly<{ locale: string; keys: readonly string[]; values: readonly string[] }>;

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

function unwrapRowsArray(node: ts.Expression): ts.ArrayLiteralExpression | null {
    if (ts.isArrayLiteralExpression(node)) return node;
    if (ts.isCallExpression(node)) {
        // A manifest may project its locale rows through a catalog helper (the
        // triage sources wrap theirs in the shared source-settings projector).
        // The literal rows remain the author-owned portion this source
        // validator can inspect; helper-projected keys retain their owner
        // tests in `@happier-dev/triage-sources`.
        for (const argument of [...node.arguments].reverse()) {
            const rows = unwrapRowsArray(argument);
            if (rows !== null) return rows;
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
        if (bundles || !ts.isPropertyAssignment(node) || propertyName(node.name) !== 'translations') {
            ts.forEachChild(node, visit);
            return;
        }
        const rows = unwrapRowsArray(node.initializer);
        if (rows === null) {
            ts.forEachChild(node, visit);
            return;
        }
        const parsed = rows.elements.map((element): Bundle | null => {
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
    const englishValuesByKey = new Map(english!.keys.map((key, index) => [key, english!.values[index]]));
    for (const bundle of bundles) {
        expect(new Set(bundle.keys).size, `${file}:${bundle.locale}: duplicate translation key`).toBe(bundle.keys.length);
        expect([...bundle.keys].sort(), `${file}:${bundle.locale}`).toEqual([...english!.keys].sort());
        expect(bundle.values.every((value) => value.trim().length > 0), `${file}:${bundle.locale}`).toBe(true);
        expect(bundle.values.every((value) => value === value.trim()), `${file}:${bundle.locale}: padded translation`).toBe(true);
        const placeholderDrift = bundle.values.flatMap((value, index) => (
            JSON.stringify(placeholders(value)) === JSON.stringify(placeholders(englishValuesByKey.get(bundle.keys[index]!) ?? ''))
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
    }
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

});
