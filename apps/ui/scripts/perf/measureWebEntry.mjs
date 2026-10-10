import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { applyExpoExportMaxWorkersArgs, prepareExpoCommandEnv, resolveExpoBin } from '../../../stack/scripts/utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../../../stack/scripts/utils/expo/expoNodeHeapEnv.mjs';
import { runSourceBuildCommand } from '../../../stack/scripts/utils/proc/runSourceBuildCommand.mjs';
import { buildStackWebExportEnv } from '../../../stack/scripts/utils/ui/ui_export_env.mjs';
import { prepareSourceWebUi } from '../../../stack/scripts/build/build_source_web_ui.mjs';

// Use Expo's real export driver and Metro's own source-map consumer. This is
// measurement tooling: it changes neither app imports nor bundler chunk policy.
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(uiRoot, '../..');
const require = createRequire(join(uiRoot, 'package.json'));
const metroRequire = createRequire(require.resolve('metro/package.json'));
const Consumer = metroRequire('metro-source-map/private/Consumer/index').default;
const fromExport = process.argv.find(argument => argument.startsWith('--from-export='))?.slice('--from-export='.length);
const outputDir = fromExport ? dirname(resolve(fromExport)) : await mkdtemp(join(tmpdir(), 'happier-web-entry-size-'));
const webOutputDir = fromExport ? resolve(fromExport) : join(outputDir, 'web');
let inventoryPath;
if (!fromExport) {
    console.log(JSON.stringify({ phase: 'source-preparation', outputDir }));
    ({ inventoryPath } = await prepareSourceWebUi({
        repoDir: repoRoot, outputDir: join(outputDir, 'source-inputs'),
    }));
    const { env: isolatedEnv } = await prepareExpoCommandEnv({
        baseDir: outputDir, kind: 'source-web-export', projectDir: uiRoot,
        baseEnv: buildStackWebExportEnv(),
    });
    const env = applyExpoNodeHeapEnv({ ...isolatedEnv, CI: '1', HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath });
    console.log(JSON.stringify({ phase: 'expo-export', outputDir }));
    await runSourceBuildCommand({
        repoDir: repoRoot, command: await resolveExpoBin(uiRoot),
        args: applyExpoExportMaxWorkersArgs([
            'export', '--platform', 'web', '--source-maps', '--output-dir', webOutputDir,
        ], env),
        cwd: uiRoot, env, captureStdout: false,
    });
}

const html = await readFile(join(webOutputDir, 'index.html'), 'utf8');
const required = [];
const unselectedLocaleModules = new Set();
const eagerSecondaryRoutes = new Set();
for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g)) {
    const filename = match[1].replace(/^\//, '');
    const source = await readFile(join(webOutputDir, filename), 'utf8');
    const sourceMap = JSON.parse(await readFile(join(webOutputDir, `${filename}.map`), 'utf8'));
    const lines = source.split('\n');
    const bytesBySource = new Map();
    const add = (mapping, endColumn) => {
        if (!mapping?.source) return;
        const bytes = Buffer.byteLength(lines[mapping.generatedLine - 1].slice(mapping.generatedColumn, endColumn));
        bytesBySource.set(mapping.source, (bytesBySource.get(mapping.source) ?? 0) + bytes);
    };
    let previous;
    for (const mapping of new Consumer(sourceMap).generatedMappings()) {
        if (previous) add(previous, previous.generatedLine === mapping.generatedLine
            ? mapping.generatedColumn : lines[previous.generatedLine - 1].length);
        previous = mapping;
    }
    if (previous) add(previous, lines[previous.generatedLine - 1].length);
    const contributors = [...bytesBySource].map(([file, bytes]) => ({ file, bytes }))
        .sort((left, right) => right.bytes - left.bytes);
    const topContributors = contributors.slice(0, 15);
    const appContributors = contributors.filter(({ file }) => file.includes('/apps/ui/sources/')
        && !file.includes('/sources/text/'));
    for (const { file } of contributors) {
        if (/\/sources\/app\/\(app\)\/(?:settings|dev)\//.test(file)) eagerSecondaryRoutes.add(file);
    }
    const textContributors = contributors.filter(({ file }) => file.includes('/sources/text/'));
    for (const { file } of textContributors) {
        if (/\/text\/(?:translations\/(?:features\/)?(?:[^/]*\.)?(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)(?:Overrides)?\.ts|bundledPluginTranslations\/(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-Hant)\.generated\.ts|bundledPluginTranslations\.generated\.ts)$/.test(file)) {
            unselectedLocaleModules.add(file);
        }
    }
    const groupedBytes = {};
    for (const { file, bytes } of contributors) {
        const group = file.includes('/sources/text/') ? 'text'
            : file.includes('/node_modules/') ? 'dependencies'
                : file.includes('/packages/protocol/') ? 'protocol' : 'other';
        groupedBytes[group] = (groupedBytes[group] ?? 0) + bytes;
    }
    required.push({ file: filename, bytes: Buffer.byteLength(source), gzipBytes: gzipSync(source).byteLength,
        attributedBytes: [...bytesBySource.values()].reduce((sum, bytes) => sum + bytes, 0),
        groupedBytes, appSourceBytes: appContributors.reduce((sum, contribution) => sum + contribution.bytes, 0),
        topContributors, appContributors: appContributors.slice(0, 10),
        featureDependencies: contributors.filter(({ file }) => /\/(?:@revenuecat\/purchases-js|livekit-client|katex|@sentry-internal\/replay)\/|\/web\/wasm\/md4c\.js$/.test(file)),
        textContributors: textContributors.slice(0, 15) });
}
if (required.length === 0) throw new Error('Expo export has no required JavaScript script tags');
// Async Router also downloads layouts and the selected page before showing '/'.
// Count those separately: HTML scripts alone are not a first-visible-page claim.
const homeRouteFiles = ['/sources/app/_layout.tsx', '/sources/app/(app)/_layout.tsx',
    '/sources/app/(app)/index.tsx'];
const homeRouteChunks = [];
const chunkDirectory = '_expo/static/js/web';
const mapSources = map => [...(map.sources ?? []),
    ...(map.sections ?? []).flatMap(section => mapSources(section.map))];
for (const name of await readdir(join(webOutputDir, chunkDirectory))) {
    if (!name.endsWith('.js.map')) continue;
    const filename = `${chunkDirectory}/${name.slice(0, -4)}`;
    if (required.some(script => script.file === filename)) continue;
    const map = JSON.parse(await readFile(join(webOutputDir, chunkDirectory, name), 'utf8'));
    const routes = mapSources(map).filter(file => homeRouteFiles.some(route => file.endsWith(route)));
    if (routes.length === 0) continue;
    const source = await readFile(join(webOutputDir, filename));
    homeRouteChunks.push({ file: filename, bytes: source.byteLength,
        gzipBytes: gzipSync(source).byteLength, routes });
}
const measurement = { outputDir: webOutputDir, inventory: inventoryPath, required,
    homeRouteChunks,
    requiredBytes: required.reduce((sum, script) => sum + script.bytes, 0),
    homeRouteMinimumBytes: [...required, ...homeRouteChunks].reduce((sum, script) => sum + script.bytes, 0),
    unselectedLocaleModules: [...unselectedLocaleModules], eagerSecondaryRoutes: [...eagerSecondaryRoutes] };
if (!fromExport) await writeFile(join(outputDir, 'measurement.json'), JSON.stringify(measurement, null, 2));
console.log(JSON.stringify({ ...measurement,
    eagerSecondaryRoutes: { count: measurement.eagerSecondaryRoutes.length,
        examples: measurement.eagerSecondaryRoutes.slice(0, 5) },
}, null, 2));
if (process.argv.includes('--verify-locale-demand')) {
    assert.deepEqual(measurement.unselectedLocaleModules, [],
        'required production scripts must not download unselected host or aggregate plugin locales');
}
if (process.argv.includes('--verify-route-demand')) {
    assert.deepEqual(measurement.eagerSecondaryRoutes, [],
        'required production scripts must not download unopened settings or development routes');
}
