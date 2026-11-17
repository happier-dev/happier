import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('loads selected web copy before activation and keeps explicit voice demand independent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-i18n-web-'));
    try {
        const result = await build({
            entryPoints: [resolve('sources/text/i18n.ts')],
            outdir: directory,
            outExtension: { '.js': '.mjs' },
            bundle: true,
            splitting: true,
            format: 'esm',
            platform: 'node',
            resolveExtensions: ['.web.ts', '.ts', '.js'],
            metafile: true,
        });
        // Run emitted ESM directly: Vitest's native resolver cannot exercise web chunk boundaries.
        const observation = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
            const text = await import(${JSON.stringify(pathToFileURL(join(directory, 'i18n.mjs')).href)});
            const initial = {
                active: text.getPreferredLanguage(),
                spanishLoaded: text.getTranslationValue('tabs.inbox', 'es') !== undefined,
                frenchLoaded: text.getTranslationValue('tabs.inbox', 'fr') !== undefined,
                pluginKeyKnown: text.getAllTranslationKeys().includes('agentInput.connectedServiceLabel.gemini'),
            };
            const commits = [];
            const unsubscribe = text.subscribePreferredLanguage(() => commits.push({ language: text.getPreferredLanguage(), copy: text.t('tabs.inbox') }));
            text.setPreferredLanguageFromSettings('es');
            const pendingActive = text.getPreferredLanguage();
            const ready = text.preloadTranslations();
            text.setPreferredLanguageFromSettings('fr');
            await ready;
            const selected = text.getPreferredLanguage();
            const selectedCopy = text.t('tabs.inbox');
            const frenchCopy = text.getTranslationValue('tabs.inbox', 'fr');
            await text.preloadTranslations('de');
            await text.preloadTranslations('zh-Hant');
            text.setPreferredLanguageFromSettings('fr');
            unsubscribe();
            console.log(JSON.stringify({ initial, pendingActive, selected, selectedCopy, frenchCopy,
                commits,
                afterVoice: text.getPreferredLanguage(),
                voiceLoaded: text.getTranslationValue('voicePresence.welcomeText', 'de') !== undefined,
                traditionalChineseLoaded: text.getTranslationValue('tabs.inbox', 'zh-Hant') !== undefined,
                simplifiedChineseActivated: text.getTranslationValue('tabs.inbox', 'zh-Hans') !== undefined,
                unrelatedJapaneseLoaded: text.getTranslationValue('tabs.inbox', 'ja') !== undefined,
                fallback: text.t('agentInput.connectedServiceLabel.gemini') }));
        `], { encoding: 'utf8' }));
        expect(observation).toMatchObject({
            initial: { active: 'en', spanishLoaded: false, frenchLoaded: false, pluginKeyKnown: true },
            pendingActive: 'en', selected: 'fr', afterVoice: 'fr', voiceLoaded: true,
            commits: [{ language: 'fr', copy: expect.any(String) }],
            traditionalChineseLoaded: true, simplifiedChineseActivated: false,
            unrelatedJapaneseLoaded: false, fallback: 'Google Gemini',
        });
        expect(observation.selectedCopy).toBe(observation.frenchCopy);
        expect(observation.commits[0].copy).toBe(observation.frenchCopy);
        const entry = Object.values(result.metafile.outputs).find(output => output.entryPoint?.endsWith('/i18n.ts'));
        expect(entry).toBeDefined();
        const staticInputs = new Set<string>();
        const visit = (file: string) => {
            const output = result.metafile.outputs[file];
            for (const input of Object.keys(output.inputs)) staticInputs.add(input);
            for (const dependency of output.imports) {
                if (dependency.kind === 'dynamic-import' || dependency.external) continue;
                visit(dependency.path);
            }
        };
        visit(Object.entries(result.metafile.outputs).find(([, output]) => output === entry)![0]);
        console.info(JSON.stringify({ entry: 'web translation lookup', entryBytes: entry!.bytes,
            staticModules: staticInputs.size, emittedChunks: Object.keys(result.metafile.outputs).length }));
        expect([...staticInputs].filter(input => /translations\/features\/(?:[^/]*\.)?(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)\.ts$/.test(input))).toEqual([]);
        expect([...staticInputs].filter(input => /bundledPluginTranslations\.generated\.ts$/.test(input))).toEqual([]);
        expect([...staticInputs].filter(input => /bundledPluginTranslations\/(?!en\.generated\.ts)/.test(input))).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

// Translation modules that still keep every locale in one module. Their English copy is read on every
// load, so each non-English table here is parsed and evaluated for nobody. Move a module's other locales
// into `translations/features/<locale>.ts` (the module keeps its types and English) and drop it from this
// list. New copy never adds a module here.
const PENDING_PER_LOCALE_SPLIT: readonly string[] = [
    'botStoreTranslations.ts',
    'botTemplateEditorTranslations.ts',
    'botTemplatePageTranslations.ts',
    'botTemplatePresentationTranslations.ts',
    'botTemplateSetupTranslations.ts',
    'botTemplateSharingTranslations.ts',
    'botTemplateUpdateTranslations.ts',
    'capabilityDetailTranslations.ts',
    'deploymentEditorsTranslations.ts',
    'deploymentMonitoringTranslations.ts',
    'deploymentOperationalTranslations.ts',
    'deploymentOverviewTranslations.ts',
    'deploymentPreparationTranslations.ts',
    'deploymentReceiptTranslations.ts',
    'deploymentRecommendationTranslations.ts',
    'discussionControlsTranslations.shared.ts',
    'discussionQuoteTranslations.shared.ts',
    'fileAiSuggestionsTranslations.shared.ts',
    'glassAppearanceTranslations.shared.ts',
    'machineWidgetBodyTranslations.shared.ts',
    'mcpAddTranslations.ts',
    'mcpSignInTranslations.ts',
    'mediaKeyboardTranslations.ts',
    'newAppTranslations.shared.ts',
    'projectReadinessTranslations.ts',
    'registriesTranslations.ts',
    'sessionCapabilityTranslations.ts',
    'sessionReadinessTranslations.shared.ts',
    'simulatorViewerTranslations.ts',
    'storeAppPageTranslations.ts',
    'storeAppTranslations.ts',
    'storeBrowserExtensionTranslations.ts',
    'storeSoftwareTranslations.ts',
    'storeTranslations.ts',
    'templateChoicesTranslations.ts',
];

it('evaluates only English copy at boot: no English-root translation module holds another locale', async () => {
    const result = await build({
        entryPoints: [resolve('sources/text/i18n.ts')],
        write: false,
        bundle: true,
        format: 'esm',
        platform: 'node',
        resolveExtensions: ['.web.ts', '.ts', '.js'],
        // Only first-party copy is under test; packages and locale assets stay outside the graph.
        packages: 'external',
        loader: { '.bundle': 'empty' },
        metafile: true,
        logLevel: 'silent',
    });
    const otherLocales = new Set(['ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant', 'zhHans', 'zhHant', 'zh_Hans', 'zh_Hant']);
    const holdsOtherLocale = (file: string) => {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        let found = false;
        const visit = (node: ts.Node) => {
            if (found) return;
            if (ts.isObjectLiteralExpression(node) && node.properties.some(property => property.name
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && otherLocales.has(property.name.text))) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        return found;
    };
    const staticInputs = Object.keys(result.metafile.inputs);
    const multiLocale = staticInputs
        .filter(input => /sources\/text\/translations\/[^/]+\.ts$/.test(input) && holdsOtherLocale(input))
        .map(input => input.replace(/^.*sources\/text\/translations\//, ''))
        .sort();
    console.info(JSON.stringify({ entry: 'English locale root', staticModules: staticInputs.length, multiLocaleModules: multiLocale.length }));
    expect(multiLocale).toEqual([...PENDING_PER_LOCALE_SPLIT].sort());
});
