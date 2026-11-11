// @happier-test-preparation source
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
for (const [name, entry, body] of [
    ['icons', 'components/ui/icons/resolveHugeIconGlyph.ts', '/iconRegistryHuge.generated.ts'],
    ['plugin evaluator', 'components/plugins/reactNative/commonJsLoaderBackend.ts', '/commonJsEvaluator.ts'],
    ['billing engine', 'sync/engine/purchases/syncPurchases.ts', '/revenueCat.web.ts'],
]) test(`${name} loads its body only on feature demand`, async () => {
    const entryPoint = `apps/ui/sources/${entry}`;
    const { metafile } = await build({
        absWorkingDir: root, entryPoints: [entryPoint], tsconfig: 'apps/ui/tsconfig.json',
        bundle: true, splitting: true, format: 'esm', platform: 'browser', packages: 'external',
        resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.js'],
        outdir: '.web-owner-demand-probe', write: false, metafile: true, logLevel: 'silent',
        loader: { '.png': 'file', '.jpg': 'file', '.ttf': 'file', '.svg': 'file' },
    });
    const outputs = metafile.outputs;
    const required = new Set();
    const visit = file => {
        if (required.has(file)) return;
        required.add(file);
        for (const edge of outputs[file].imports) if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
    };
    visit(Object.keys(outputs).find(file => outputs[file].entryPoint === entryPoint));
    assert.ok(Object.keys(metafile.inputs).some(file => file.endsWith(body)), 'feature demand retains its real implementation');
    const eager = [...required].flatMap(file => Object.keys(outputs[file].inputs));
    assert.deepEqual(eager.filter(file => file.endsWith(body)), [], 'initial entry excludes the implementation');
    if (name === 'plugin evaluator') {
        assert.deepEqual(eager.filter(file => file.endsWith('/hostModules.ts')), [], 'the host ABI is acquired with executable demand');
        assert.equal([...required].some(file => outputs[file].imports.some(edge => edge.path === '@happier-dev/protocol')), false,
            'the complete Protocol namespace is not an entry dependency');
    }
    console.log(JSON.stringify({ owner: name, eagerBodyModules: eager.filter(file => file.endsWith(body)).length }));
});

test('locale demand loads only the selected host and plugin copy', async () => {
    const { SUPPORTED_LANGUAGE_CODES } = await import('../../sources/text/_all.ts');
    const { metafile } = await build({
        absWorkingDir: root,
        entryPoints: ['apps/ui/sources/text/i18n.ts', 'apps/ui/sources/text/localeBundleLoaders.ts'],
        tsconfig: 'apps/ui/tsconfig.json', bundle: true, splitting: true, format: 'esm',
        platform: 'browser', packages: 'external', write: false, metafile: true,
        outdir: '.web-locale-demand-probe', logLevel: 'silent',
    });
    const inputsFor = entry => {
        const visited = new Set();
        const visit = file => {
            if (visited.has(file)) return;
            visited.add(file);
            for (const edge of metafile.outputs[file].imports) {
                if (!edge.external && edge.kind !== 'dynamic-import') visit(edge.path);
            }
        };
        visit(entry);
        return [...visited].flatMap(file => Object.keys(metafile.outputs[file].inputs));
    };
    const translationPaths = inputs => inputs.filter(file => {
        if (/\/text\/bundledPluginTranslations(?:\/[^/]+)?\.generated\.ts$/.test(file)) return true;
        const locale = file.match(/\/text\/translations\/(?:features\/)?([^/]+)\.ts$/)?.[1].replace(/Overrides$/, '');
        return SUPPORTED_LANGUAGE_CODES.includes(locale);
    });
    const initial = Object.keys(metafile.outputs).find(file => metafile.outputs[file].entryPoint === 'apps/ui/sources/text/i18n.ts');
    const initialCopy = translationPaths(inputsFor(initial));
    const english = [
        'apps/ui/sources/text/bundledPluginTranslations/en.generated.ts',
        'apps/ui/sources/text/translations/en.ts',
    ];
    for (const file of english) assert.ok(initialCopy.includes(file));
    assert.deepEqual(initialCopy.filter(file => ![...english, 'apps/ui/sources/text/translations/features/en.ts'].includes(file)), [],
        'startup contains English fallback only');
    for (const language of SUPPORTED_LANGUAGE_CODES.filter(language => language !== 'en')) {
        for (const relative of [
            `translations/${language === 'zh-Hant' ? 'zh-HantOverrides' : language}.ts`,
            `bundledPluginTranslations/${language}.generated.ts`,
        ]) {
            const entryPoint = `apps/ui/sources/text/${relative}`;
            const chunk = Object.keys(metafile.outputs).find(file => metafile.outputs[file].entryPoint === entryPoint);
            assert.ok(chunk, `${language} remains available on demand`);
            const expected = [entryPoint];
            if (relative.startsWith('translations/')) expected.push(
                `apps/ui/sources/text/translations/features/${language}.ts`,
                'apps/ui/sources/text/translations/features/en.ts', // Existing untranslated-feature fallback.
            );
            if (language === 'zh-Hant' && relative.startsWith('translations/')) {
                // Traditional Chinese deliberately inherits Simplified Chinese copy.
                expected.push('apps/ui/sources/text/translations/zh-Hans.ts');
                expected.push('apps/ui/sources/text/translations/features/zh-Hans.ts');
            }
            const copy = translationPaths(inputsFor(chunk));
            assert.ok(copy.includes(entryPoint));
            assert.deepEqual(copy.filter(file => !expected.includes(file)), [], `${language} must not acquire other locales`);
        }
    }
    console.log(JSON.stringify({ owner: 'locales', demandLocales: SUPPORTED_LANGUAGE_CODES.length - 1, eagerNonEnglishModules: 0 }));
});
