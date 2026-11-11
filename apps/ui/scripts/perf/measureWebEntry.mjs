import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { applyExpoExportMaxWorkersArgs, prepareExpoCommandEnv, resolveExpoBin } from '../../../stack/scripts/utils/expo/command.mjs';
import { applyExpoNodeHeapEnv } from '../../../stack/scripts/utils/expo/expoNodeHeapEnv.mjs';
import { runSourceBuildCommand } from '../../../stack/scripts/utils/proc/runSourceBuildCommand.mjs';
import { buildStackWebExportEnv } from '../../../stack/scripts/utils/ui/ui_export_env.mjs';
import { withSourceWebUiInputs } from '../../../stack/scripts/build/build_source_web_ui.mjs';
import { getDefaultAutostartPaths } from '../../../stack/scripts/utils/paths/paths.mjs';
import { SOURCE_WEB_EXPORT_ADMISSION_CLASS } from '../../../stack/scripts/utils/dev_targets/remote_commands.mjs';
import { withBuildInputDependencies, withSingleTrailingBuildPass } from '../../../../scripts/workspaces/buildInputConvergence.mjs';

// Use Expo's real export driver and Metro's own source-map consumer. This is
// measurement tooling: it changes neither app imports nor bundler chunk policy.
const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(uiRoot, '../..');
const require = createRequire(join(uiRoot, 'package.json'));
const metroRequire = createRequire(require.resolve('metro/package.json'));
const Consumer = metroRequire('metro-source-map/private/Consumer/index').default;
const fromExport = process.argv.find(argument => argument.startsWith('--from-export='))?.slice('--from-export='.length);
const exportWorkerDir = process.argv.find(argument => argument.startsWith('--export-worker='))?.slice('--export-worker='.length);
const outputDir = fromExport ? dirname(resolve(fromExport)) : exportWorkerDir ? resolve(exportWorkerDir)
    : await mkdtemp(join(tmpdir(), 'happier-web-entry-size-'));
const webOutputDir = fromExport ? resolve(fromExport) : join(outputDir, 'web');
let inventoryPath;
if (!fromExport && !exportWorkerDir) {
    // One admitted finite producer contains capture, preparation and Metro;
    // dependency custody is never held by the parent across admission waits.
    await runSourceBuildCommand({ repoDir: repoRoot, scriptPath: fileURLToPath(import.meta.url),
        args: [`--export-worker=${outputDir}`], admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStdout: false });
} else if (exportWorkerDir) {
    const workerOutputDir = resolve(exportWorkerDir);
    const workerWebOutputDir = join(workerOutputDir, 'web');
    await withSingleTrailingBuildPass({ run: async trailing => {
      if (trailing) await rm(workerWebOutputDir, { recursive: true, force: true });
      return await withBuildInputDependencies({ sourceDir: repoRoot }, async dependencyEnv => {
        console.log(JSON.stringify({ phase: 'source-preparation', outputDir: workerOutputDir }));
        const { env: isolatedEnv, paths } = await prepareExpoCommandEnv({
            baseDir: getDefaultAutostartPaths(dependencyEnv).baseDir, kind: 'source-web-export', projectDir: uiRoot,
            baseEnv: buildStackWebExportEnv({ baseEnv: dependencyEnv }),
        });
        return await withSourceWebUiInputs({ repoDir: repoRoot, baseDir: paths.stateDir, env: dependencyEnv }, async inputs => {
            inventoryPath = inputs.inventoryPath;
            const env = applyExpoNodeHeapEnv({ ...isolatedEnv, CI: '1', HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath });
            console.log(JSON.stringify({ phase: 'expo-export', outputDir: workerOutputDir }));
            await runSourceBuildCommand({
                repoDir: repoRoot, command: await resolveExpoBin(uiRoot),
                args: applyExpoExportMaxWorkersArgs([
                    'export', '--platform', 'web', '--source-maps', '--output-dir', workerWebOutputDir,
                ], env),
                cwd: inputs.uiProjectDir, env, admissionClass: SOURCE_WEB_EXPORT_ADMISSION_CLASS, captureStdout: false,
            });
        });
      });
    } });
    process.exit(0);
}

const html = await readFile(join(webOutputDir, 'index.html'), 'utf8');
const required = [];
const unselectedLocaleModules = new Set();
const eagerSecondaryRoutes = new Set();
const eagerProtocolRootModules = new Set();
const eagerSessionImplementations = new Set();
// Attribute the suspected entry leaks from Metro's emitted map, rather than
// inferring delivery from source imports (or from a retained export).
const entryLeakPatterns = {
    hugeIconsBarrel: /\/@hugeicons\/core-free-icons\/(?:dist\/[^/]+\/)?index\.js$/,
    hugeIconRegistry: /\/components\/ui\/icons\/iconRegistryHuge\.generated\.ts$/,
    pluginTranslationAggregate: /\/text\/bundledPluginTranslations\.generated\.ts$/,
    nonEnglishHostLocales: /\/text\/translations\/(?:ca|de|es|fr|it|ja|pl|pt|ru|zh-Hans|zh-HantOverrides)\.ts$/,
    nonEnglishPluginLocales: /\/text\/bundledPluginTranslations\/(?!en\.)[^/]+\.generated\.ts$/,
    protocolRoot: /\/packages\/protocol\/src\/index\.ts$/,
    revenueCatSdk: /\/@revenuecat\/purchases-js\//,
};
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
        if (/\/packages\/protocol\/src\/index\.ts$/.test(file)) eagerProtocolRootModules.add(file);
        if (/\/components\/sessions\/shell\/SessionView\.tsx$/.test(file)) eagerSessionImplementations.add(file);
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
        entryLeaks: Object.fromEntries(Object.entries(entryLeakPatterns).map(([name, pattern]) => {
            const modules = contributors.filter(({ file }) => pattern.test(file));
            return [name, { bytes: modules.reduce((sum, module) => sum + module.bytes, 0), modules }];
        })),
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
    unselectedLocaleModules: [...unselectedLocaleModules], eagerSecondaryRoutes: [...eagerSecondaryRoutes],
    eagerProtocolRootModules: [...eagerProtocolRootModules], eagerSessionImplementations: [...eagerSessionImplementations] };
if (!fromExport) await writeFile(join(outputDir, 'measurement.json'), JSON.stringify(measurement, null, 2));
console.log(JSON.stringify({ ...measurement,
    eagerSecondaryRoutes: { count: measurement.eagerSecondaryRoutes.length,
        examples: measurement.eagerSecondaryRoutes.slice(0, 5) },
}, null, 2));
if (process.argv.includes('--verify-entry-demand')) {
    for (const script of required) for (const [name, leak] of Object.entries(script.entryLeaks)) {
        assert.deepEqual(leak.modules, [], `${script.file} must not eagerly deliver ${name}`);
    }
}
if (process.argv.includes('--verify-locale-demand')) {
    assert.deepEqual(measurement.unselectedLocaleModules, [],
        'required production scripts must not download unselected host or aggregate plugin locales');
}
if (process.argv.includes('--verify-route-demand')) {
    assert.deepEqual(measurement.eagerSecondaryRoutes, [],
        'required production scripts must not download unopened settings or development routes');
}
if (process.argv.includes('--verify-protocol-demand')) {
    assert.deepEqual(measurement.eagerProtocolRootModules, [],
        'required production scripts must not download the complete Protocol root barrel');
}
if (process.argv.includes('--verify-session-demand')) {
    assert.deepEqual(measurement.eagerSessionImplementations, [],
        'required production scripts must not download the unopened session implementation');
}
