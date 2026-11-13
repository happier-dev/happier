import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readPluginTranslationResources } from '../../../../scripts/testing/readPluginTranslationResources';
import { pluginPackageNameToPackageId, readBundledPluginPackageNames } from '../../../cli/scripts/build-owned/bundledPluginMembership';

import {
    SUPPORTED_LANGUAGE_CODES,
    type SupportedLanguage,
} from '../../sources/text/_all.js';


type Bundle = Readonly<{ locale: string; keys: readonly string[]; values: readonly string[] }>;

const PLUGIN_ROOT = path.resolve(__dirname, '../../../../packages/plugins');

// The former inline/module audit covered these catalogs, not every plugin.
const CONTENT_AUDITED_PLUGINS = new Set([
    'elevenlabs', 'google', 'inspector', 'openai-compat', 'posthog', 'scm-azure-devops',
    'scm-bitbucket', 'scm-github', 'scm-gitlab', 'sentry', 'channel-discord',
    'channel-telegram', 'channels', 'claude', 'cliproxyapi', 'codex', 'copilot',
    'gemini', 'grok', 'ohmypi', 'pi', 'triage',
]);

function packagedPlugins(): readonly string[] {
    return readdirSync(PLUGIN_ROOT, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(path.join(PLUGIN_ROOT, entry.name, 'assets/i18n/en.json')))
        .map(entry => entry.name).sort();
}

function readPackagedBundles(plugin: string): readonly Bundle[] {
    const packageRoot = pathToFileURL(`${path.join(PLUGIN_ROOT, plugin)}${path.sep}`);
    const messagesByLocale = readPluginTranslationResources(packageRoot);
    expect(readdirSync(new URL('assets/i18n/', packageRoot)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort())
        .toEqual([...SUPPORTED_LANGUAGE_CODES].sort());
    return Object.keys(messagesByLocale).map(locale => {
        const file = new URL(`assets/i18n/${locale}.json`, packageRoot);
        const source = ts.parseJsonText(file.pathname, readFileSync(file, 'utf8'));
        const statement = source.statements[0];
        const object = statement && ts.isExpressionStatement(statement) ? unwrapObject(statement.expression) : null;
        if (!object) throw new Error(`${file.pathname}: expected a JSON message object`);
        // Preserve duplicate-key detection: JSON.parse alone silently overwrites them.
        return readMessageObject(object, locale);
    });
}

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
    return [...new Set([...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
        .map((match) => match[1] ?? ''))]
        .sort();
}

function parityPlaceholders(key: string, value: string, english: ReadonlyMap<string, string>): readonly string[] {
    const otherKey = key.replace(/\.(zero|one|two|few|many|other)$/, '.other');
    // Count formatters supply {count} to every plural form. English may spell out
    // "one", while Russian's "one" form also covers 21 and must interpolate it.
    const countPlural = /\.(zero|one|two|few|many|other)$/.test(key)
        && placeholders(english.get(otherKey) ?? '').includes('count');
    return placeholders(value).filter(name => !countPlural || name !== 'count');
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
            JSON.stringify(parityPlaceholders(bundle.keys[index]!, value, englishValuesByKey))
                === JSON.stringify(parityPlaceholders(bundle.keys[index]!, englishValuesByKey.get(bundle.keys[index]!) ?? '', englishValuesByKey))
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
    it('allows count interpolation across plural forms while preserving other placeholder contracts', () => {
        const keys = ['checks.one', 'checks.other', 'status'];
        const bundles = SUPPORTED_LANGUAGE_CODES.map(locale => ({ locale, keys,
            values: locale === 'ru' ? ['{count} {source} {source}', '{count} {source}', '{source}']
                : ['One {source}', '{count} {source}', '{source}'],
        }));
        expect(() => assertComplete('plural-fixture', bundles)).not.toThrow();
        const changedSource = bundles.map(bundle => bundle.locale === 'ru'
            ? { ...bundle, values: ['{count} {wrong}', '{count} {source}', '{source}'] } : bundle);
        expect(() => assertComplete('plural-fixture', changedSource)).toThrow(/interpolation placeholder drift/);
        const ordinaryCount = bundles.map(bundle => bundle.locale === 'ru'
            ? { ...bundle, values: ['{count} {source}', '{count} {source}', '{count} {source}'] } : bundle);
        expect(() => assertComplete('plural-fixture', ordinaryCount)).toThrow(/interpolation placeholder drift/);
    });

    it('loads Channels copy from admitted Resource declarations through the shared runtime', async () => {
        const { CHANNELS_PLUGIN_ID, PLUGIN_MANIFEST } = await import('../../../../packages/plugins/channels/src/manifest');
        const { parsePluginManifest } = await import('@happier-dev/plugin-sdk/manifest');
        const { projectPluginUiTranslationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui/declarationProjection');
        const { PluginDeclaredUiEntriesV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { EMPTY_PLUGIN_UI_PROJECTION } = await import('../../sources/sync/domains/plugins/ui/projection');
        const { createPluginUiTranslationRuntime, resolvePluginLocalizedText } = await import('../../sources/sync/domains/plugins/ui/i18n');
        const admitted = parsePluginManifest(PLUGIN_MANIFEST);
        if (!admitted.ok) throw new Error(admitted.diagnostics.map(diagnostic => diagnostic.message).join('; '));
        const declarations = admitted.manifest.contributes.ui?.translations ?? [];
        const entriesById = {};
        projectPluginUiTranslationsV1({ uiTranslationsV2: declarations.map(definition => ({ pluginId: CHANNELS_PLUGIN_ID, definition })) }, entriesById, 'de');
        const projected = PluginDeclaredUiEntriesV1Schema.parse(entriesById)[`translations:${CHANNELS_PLUGIN_ID}`];
        const locales = projected && Array.isArray(projected.locales)
            && projected.locales.every((locale): locale is string => typeof locale === 'string') ? projected.locales : null;
        if (!projected || projected.contributionKind !== 'translations' || projected.pluginId !== CHANNELS_PLUGIN_ID || !locales) {
            throw new Error('Expected Channels translation declarations');
        }
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: { [CHANNELS_PLUGIN_ID]: {
            ...projected, pluginId: projected.pluginId, contributionKind: 'translations' as const, locales,
        } } };
        const reads: string[] = [];
        const packageRoot = path.resolve(__dirname, '../../../../packages/plugins/channels');
        const runtime = createPluginUiTranslationRuntime({ projection, readResourceBytes: async (_source, _pluginId, resourceId) => {
            reads.push(resourceId);
            const resource = admitted.manifest.contributes.resources?.find(({ id }) => id === resourceId);
            if (typeof resource?.path !== 'string') throw new Error('Expected a packaged locale Resource');
            return new Uint8Array(readFileSync(path.join(packageRoot, resource.path)));
        } });
        try {
            expect(reads).toEqual([]);
            await runtime.demand(CHANNELS_PLUGIN_ID, 'de');
            expect(reads).toHaveLength(2);
            expect(runtime.getBundle(CHANNELS_PLUGIN_ID, 'de')).toMatchObject({
                'plugins.channels.surface.bindingCreatePermissionPlan': 'Planungsmodus',
            });
            expect(resolvePluginLocalizedText({ projection, runtime, pluginId: CHANNELS_PLUGIN_ID, locale: 'de',
                value: { key: 'plugins.channels.surface.bindingCreatePermissionYolo', fallback: 'Skip approval prompts' },
            })).toBe('Ohne Genehmigungen arbeiten');
        } finally {
            runtime.dispose();
        }
    });

    it('ships every packaged locale and preserves the established catalog content checks', () => {
        const plugins = packagedPlugins();
        const bundledWithLocales = readBundledPluginPackageNames(path.resolve(PLUGIN_ROOT, '../..'))
            .map(pluginPackageNameToPackageId)
            .filter(plugin => existsSync(path.join(PLUGIN_ROOT, plugin, 'assets/i18n/en.json')))
            .sort();
        expect(plugins).toEqual(bundledWithLocales);
        for (const plugin of plugins) {
            const bundles = readPackagedBundles(plugin);
            if (!CONTENT_AUDITED_PLUGINS.has(plugin)) continue;
            // GitLab publication copy was composed through a spread from a separate
            // module, outside the old literal/module audit; preserve its exact values.
            const audited = plugin === 'scm-gitlab' ? bundles.map(bundle => {
                const indices = bundle.keys.flatMap((key, index) => key.startsWith('plugins.gitlab.ui.publication.') ? [] : [index]);
                return { locale: bundle.locale, keys: indices.map(index => bundle.keys[index]!), values: indices.map(index => bundle.values[index]!) };
            }) : bundles;
            assertComplete(plugin, audited);
        }
    });

    it('keeps the generated host bundle synchronized with source plugin catalogs', () => {
        const root = path.resolve(__dirname, '../../../..');
        const generatedByLocale = readGeneratedHostBundles(
            path.join(root, 'apps/ui/sources/text/bundledPluginTranslations.generated.ts'),
        );

        for (const plugin of packagedPlugins()) {
            for (const bundle of readPackagedBundles(plugin)) {
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
