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

// The Metro graph evaluates English only: web and native load every other locale from the locale
// producer's bundles, which read the untransformed sources. The Babel override in babel.config.js
// turns the other-locale entries of each translation module's locale maps into getters in the
// Metro graph, so a module written with every locale inline evaluates only its English copy at boot.
const otherLocales = new Set(['ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant', 'zhHans', 'zhHant', 'zh_Hans', 'zh_Hant']);

function holdsOtherLocaleMap(file: string, source: string): boolean {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isObjectLiteralExpression(node)) {
            // Other-locale entries left as getters are not evaluated at boot.
            const keys = node.properties.map(property => !ts.isGetAccessorDeclaration(property) && property.name
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null);
            const english = node.properties.find(property => property.name
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'en');
            const englishIsText = english && ts.isPropertyAssignment(english)
                && (ts.isStringLiteral(english.initializer) || ts.isNoSubstitutionTemplateLiteral(english.initializer));
            if (english && !englishIsText && keys.some(key => key !== null && otherLocales.has(key))) {
                found = true;
                return;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(tree);
    return found;
}

// The Metro boot graph's transform for translation modules, read from the Babel config Metro uses.
async function englishBootCopyTransform(): Promise<(filename: string, source: string) => Promise<string>> {
    const babel = await import('@babel/core');
    const loadConfig = (await import(pathToFileURL(resolve('babel.config.js')).href)).default as (api: unknown) => {
        overrides?: { test: (filename: string) => boolean; plugins: unknown[] }[];
    };
    const api = { cache: { using: () => undefined }, caller: () => undefined };
    const overrides = loadConfig(api).overrides ?? [];
    return async (filename, source) => {
        const plugins = overrides.filter(override => override.test(filename)).flatMap(override => override.plugins);
        if (plugins.length === 0) return source;
        const result = await babel.transformAsync(source, {
            filename, babelrc: false, configFile: false, plugins: plugins as never[],
            parserOpts: { plugins: ['typescript'] }, retainLines: true,
        });
        return result?.code ?? source;
    };
}

it('the Metro boot graph evaluates English copy only: no translation module keeps an eager locale map', async () => {
    const transform = await englishBootCopyTransform();
    const transformed = new Map<string, string>();
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
        plugins: [{
            name: 'english-boot-copy',
            setup(pluginBuild) {
                pluginBuild.onLoad({ filter: /sources[\\/]text[\\/]translations[\\/][^\\/]+\.ts$/ }, async args => {
                    const contents = await transform(args.path, readFileSync(args.path, 'utf8'));
                    transformed.set(args.path, contents);
                    return { contents, loader: 'ts' };
                });
            },
        }],
    });
    const multiLocale = [...transformed].filter(([file, source]) => holdsOtherLocaleMap(file, source))
        .map(([file]) => file.replace(/^.*sources\/text\/translations\//, '')).sort();
    console.info(JSON.stringify({ entry: 'English locale root', staticModules: Object.keys(result.metafile.inputs).length,
        translationModules: transformed.size, multiLocaleModules: multiLocale.length }));
    expect(transformed.size).toBeGreaterThan(100);
    expect(multiLocale).toEqual([]);
});

it('a new feature module written with every locale inline evaluates only its English copy at boot', async () => {
    const transform = await englishBootCopyTransform();
    const filename = resolve('sources/text/translations/newFeatureTranslations.ts');
    const source = [
        "const words = { en: { title: 'Title' }, fr: { title: 'Titre' }, 'zh-Hans': { title: '标题' } } as const;",
        "export const newFeatureTranslations = { en: words.en, de: { title: 'Titel' }, zhHant: { title: '標題' } };",
        "export const languageNames = { en: 'English', fr: 'French' };",
    ].join('\n');
    const output = await transform(filename, source);
    expect(holdsOtherLocaleMap(filename, output)).toBe(false);
    expect(output).toContain("title: 'Title'");
    // A map whose English entry is plain text is English copy (e.g. language names), not a locale map.
    expect(output).toContain("fr: 'French'");
});
