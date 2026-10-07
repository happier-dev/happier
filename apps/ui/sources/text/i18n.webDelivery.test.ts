import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
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
            };
            text.setPreferredLanguageFromSettings('es');
            const pendingActive = text.getPreferredLanguage();
            const ready = text.preloadTranslations();
            text.setPreferredLanguageFromSettings('fr');
            await ready;
            const selected = text.getPreferredLanguage();
            const selectedCopy = text.t('tabs.inbox');
            const frenchCopy = text.getTranslationValue('tabs.inbox', 'fr');
            await text.preloadTranslations('de');
            console.log(JSON.stringify({ initial, pendingActive, selected, selectedCopy, frenchCopy,
                afterVoice: text.getPreferredLanguage(),
                voiceLoaded: text.getTranslationValue('voicePresence.welcomeText', 'de') !== undefined,
                unrelatedJapaneseLoaded: text.getTranslationValue('tabs.inbox', 'ja') !== undefined,
                fallback: text.t('agentInput.connectedServiceLabel.gemini') }));
        `], { encoding: 'utf8' }));
        expect(observation).toMatchObject({
            initial: { active: 'en', spanishLoaded: false, frenchLoaded: false },
            pendingActive: 'en', selected: 'fr', afterVoice: 'fr', voiceLoaded: true,
            unrelatedJapaneseLoaded: false, fallback: 'Google Gemini',
        });
        expect(observation.selectedCopy).toBe(observation.frenchCopy);
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
        expect([...staticInputs].filter(input => /translations\/features\/(?!en\.ts)/.test(input))).toEqual([]);
        expect([...staticInputs].filter(input => /bundledPluginTranslations\.generated\.ts$/.test(input))).toEqual([]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
