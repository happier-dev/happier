// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readdir, readFile, symlink, writeFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { openLocalePreparation, prepareLocaleAssets } from './prepareLocaleAssets.mjs';
import { prepareSourceUiAssets, publishSourceUiAssets } from './prepareSourceUiAssets.mjs';

test('locale preparation reuses identical content and defers publication until admission', async t => {
    const { root } = await createTempFixture(t, { prefix: 'happier-locale-publication-' });
    const uiPackageDir = join(root, 'apps/ui');
    const put = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); };
    await put(join(root, 'package.json'), '{"private":true,"type":"module"}');
    await put(join(uiPackageDir, 'package.json'), '{"name":"@fixture/ui","type":"module"}');
    await put(join(uiPackageDir, 'sources/text/_all.ts'), "export const SUPPORTED_LANGUAGE_CODES = ['en', 'fr'];");
    await put(join(uiPackageDir, 'sources/text/bundledPluginTranslations/fr.generated.ts'), 'export const BUNDLED_PLUGIN_TRANSLATIONS = {};');
    const translation = join(uiPackageDir, 'sources/text/translations/fr.ts');
    const prepare = async value => {
        await put(translation, `export const fr = { greeting: ${JSON.stringify(value)} };`);
        return prepareLocaleAssets({ uiPackageDir });
    };
    const a = await prepare('bonjour');
    const before = await stat(a.outputPath);
    const same = await prepareLocaleAssets({ uiPackageDir });
    assert.deepEqual(same.assetPaths, a.assetPaths, 'identical compiled bytes retain their hash');
    assert.equal((await stat(a.outputPath)).mtimeMs, before.mtimeMs, 'unchanged references are not republished');
    const b = await prepare('salut');
    await prepareLocaleAssets({ uiPackageDir });
    await put(translation, "export const fr = { greeting: 'coucou' };");
    const beforeCandidate = await readFile(b.outputPath, 'utf8');
    const candidate = join(root, 'candidate.js');
    await prepareLocaleAssets({ uiPackageDir, outputPath: candidate, publicationPath: b.outputPath });
    assert.equal(await readFile(b.outputPath, 'utf8'), beforeCandidate, 'preparation does not publish before admission');
    const recordPath = join(root, 'prepared.json');
    await put(recordPath, JSON.stringify({ publications: [{ candidatePath: candidate, outputPath: b.outputPath }] }));
    await publishSourceUiAssets({ recordPath });
    assert.equal(await readFile(b.outputPath, 'utf8'), await readFile(candidate, 'utf8'));
    const publishedBytes = await readFile(b.outputPath, 'utf8');
    const publishedAt = await stat(recordPath);
    await rm(candidate);
    await publishSourceUiAssets({ recordPath });
    assert.equal(await readFile(b.outputPath, 'utf8'), publishedBytes,
        'republication reads the published record without replaying retired candidates');
    assert.equal((await stat(recordPath)).mtimeMs, publishedAt.mtimeMs,
        'republication of settled references makes no new publication');
});


test('independent locale producers replace pre-existing references and preserve loaded translations after restart', async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-locale-producers-' });
    const uiPackageDir = fixture.path('apps/ui');
    const put = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); };
    await put(fixture.path('package.json'), '{"private":true,"type":"module"}');
    await put(join(uiPackageDir, 'package.json'), '{"name":"@fixture/ui","type":"module"}');
    await put(join(uiPackageDir, 'sources/text/_all.ts'), "export const SUPPORTED_LANGUAGE_CODES = ['en', 'fr'];");
    await put(join(uiPackageDir, 'sources/text/translations/fr.ts'), "export const fr = { greeting: 'bonjour' };");
    const pluginTranslations = join(uiPackageDir, 'sources/text/bundledPluginTranslations/fr.generated.ts');
    await put(pluginTranslations, "export const BUNDLED_PLUGIN_TRANSLATIONS = { 'happier.alpha': { greeting: 'plugin-before' } };");
    const outputPath = join(uiPackageDir, 'sources/text/localeAssets.generated.js');
    await put(outputPath, 'stale references from an interrupted preparation');
    const owner = new URL('./prepareLocaleAssets.mjs', import.meta.url).href;
    const runProducer = () => promisify(execFile)(process.execPath, ['--input-type=module', '-e',
        `import { prepareLocaleAssets } from ${JSON.stringify(owner)}; await prepareLocaleAssets(${JSON.stringify({ uiPackageDir })});`],
        { cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
    // Finite validation preparation and live Expo can produce these shared
    // content-addressed locale files from separate processes.
    await Promise.all([runProducer(), runProducer()]);
    const loadPublished = async () => {
        const references = await readFile(outputPath, 'utf8');
        const specifier = /"fr": require\(("(?:[^"\\]|\\.)*")\)/u.exec(references);
        assert.ok(specifier, 'the public locale inventory contains the compiled French asset');
        const assetPath = join(dirname(outputPath), JSON.parse(specifier[1]));
        const module = { exports: {} };
        runInNewContext(await readFile(assetPath, 'utf8'), { module, exports: module.exports });
        return { assetPath, bundle: module.exports.bundle };
    };
    const before = await loadPublished();
    assert.equal(before.bundle.host.greeting, 'bonjour');
    assert.equal(before.bundle.plugins['happier.alpha']?.greeting, 'plugin-before');
    await put(pluginTranslations, "export const BUNDLED_PLUGIN_TRANSLATIONS = { 'happier.alpha': { greeting: 'plugin-after' } };");
    // A Stack still serving the earlier graph names it in its source asset record.
    const servingRecord = join(uiPackageDir, '.expo/hstack/plugin-ui-inputs/source-assets.json');
    await put(servingRecord, JSON.stringify({ assetPaths: [before.assetPath] }));
    await runProducer();
    const after = await loadPublished();
    assert.equal(after.bundle.host.greeting, 'bonjour');
    assert.equal(after.bundle.plugins['happier.alpha'].greeting, 'plugin-after');
    assert.notEqual(after.assetPath, before.assetPath, 'changed plugin copy selects new content-addressed bytes');
    const delayed = { exports: {} };
    runInNewContext(await readFile(before.assetPath, 'utf8'), { module: delayed, exports: delayed.exports });
    assert.equal(delayed.exports.bundle.plugins['happier.alpha'].greeting, 'plugin-before',
        'a graph a Stack still serves can fetch its old locale asset after producer restart');
    await rm(servingRecord);
    await runProducer();
    await assert.rejects(readFile(before.assetPath), { code: 'ENOENT' }, 'an unreferenced generation is retired');
    await readFile(after.assetPath);
});

const localeFixture = async (t, prefix) => {
    const fixture = await createTempFixture(t, { prefix });
    const uiPackageDir = fixture.path('apps/ui');
    const put = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); };
    await put(fixture.path('package.json'), '{"private":true,"type":"module"}');
    await put(join(uiPackageDir, 'package.json'), '{"name":"@fixture/ui","type":"module"}');
    await put(join(uiPackageDir, 'sources/text/_all.ts'), "export const SUPPORTED_LANGUAGE_CODES = ['en', 'fr'];");
    await put(join(uiPackageDir, 'sources/text/bundledPluginTranslations/fr.generated.ts'), 'export const BUNDLED_PLUGIN_TRANSLATIONS = {};');
    const publish = async value => {
        await put(join(uiPackageDir, 'sources/text/translations/fr.ts'), `export const fr = { greeting: ${JSON.stringify(value)} };`);
        return prepareLocaleAssets({ uiPackageDir });
    };
    const bundles = async () => (await readdir(join(uiPackageDir, '.expo/hstack/locales')))
        .filter(name => name.endsWith('.locale.bundle')).sort();
    return { fixture, uiPackageDir, put, publish, bundles };
};

test('locale publication keeps only bundles a published map or source asset record names', async t => {
    const { uiPackageDir, put, publish, bundles } = await localeFixture(t, 'happier-locale-retention-');
    const first = await publish('un');
    await put(join(uiPackageDir, '.expo/hstack/source-assets/source-assets.json'), JSON.stringify({ assetPaths: first.assetPaths }));
    await publish('deux');
    await publish('trois');
    const current = await publish('quatre');
    assert.deepEqual(await bundles(), [...first.assetPaths, ...current.assetPaths].map(path => basename(path)).sort(),
        'three publications leave the current map and the recorded generation, nothing else');
});

test('a concurrent publisher keeps the bundles an in-flight preparation has written but not yet published', async t => {
    const { uiPackageDir, publish, bundles } = await localeFixture(t, 'happier-locale-concurrent-');
    await publish('un');
    // Another process is mid-preparation: its bundle exists, no map names it yet.
    const directory = join(uiPackageDir, '.expo/hstack/locales');
    const inFlight = await openLocalePreparation(directory);
    const pending = join(directory, `${'f'.repeat(64)}.locale.bundle`);
    await inFlight.retain(pending, 'module.exports = { bundle: { host: {}, plugins: {} } };');
    const current = await publish('deux');
    assert.deepEqual(await bundles(), [basename(pending), ...current.assetPaths.map(path => basename(path))].sort(),
        'the earlier generation is retired; the in-flight bundle survives');
    await inFlight.close();
    await publish('deux');
    assert.deepEqual(await bundles(), current.assetPaths.map(path => basename(path)).sort(),
        'a finished preparation that never published releases its bundle');
});

test('a preparation under another storage root keeps the bundles a first root\'s record names until that record is gone', async t => {
    const { fixture, put, publish, bundles } = await localeFixture(t, 'happier-locale-roots-');
    const previous = process.env.HAPPIER_STACK_STORAGE_DIR;
    t.after(() => { if (previous === undefined) delete process.env.HAPPIER_STACK_STORAGE_DIR; else process.env.HAPPIER_STACK_STORAGE_DIR = previous; });
    // This process prepares under storage root B (a QA bed, a lane HOME, a routed guest).
    process.env.HAPPIER_STACK_STORAGE_DIR = fixture.path('root-b');
    const served = await publish('un');
    // A Stack under storage root A publishes the record its inventory serves.
    const staged = fixture.path('root-a/repo-dev/expo-dev/instance/plugin-ui/.happier-plugin-ui-stage-x/inputs/source-assets.json');
    const record = fixture.path('root-a/repo-dev/expo-dev/instance/plugin-ui/source-assets.json');
    await put(staged, JSON.stringify({ assetPaths: served.assetPaths, publications: [] }));
    await publishSourceUiAssets({ recordPath: staged, outputPath: record });
    await rm(dirname(dirname(staged)), { recursive: true });
    const current = await publish('deux');
    assert.deepEqual(await bundles(), [...served.assetPaths, ...current.assetPaths].map(path => basename(path)).sort(),
        'root B\'s publication keeps the bundles root A\'s record names');
    await rm(record);
    await publish('deux');
    assert.deepEqual(await bundles(), current.assetPaths.map(path => basename(path)).sort(),
        'once the record is gone its bundles retire, so the store stays bounded');
});

test('locale publication retains each serving Metro map until its reader ends', async t => {
    const { uiPackageDir, fixture, put, publish, bundles } = await localeFixture(t, 'happier-locale-readers-');
    const { protectMetroDependencyConsumption } = createRequire(import.meta.url)('./metroDependencyConsumption.cjs');
    const serve = () => {
        let readGraph;
        // Metro supplies this callback for its actual graph read and ends it at shutdown.
        const metro = {
            getBundler: () => ({ getDeltaBundler: () => ({
                unstable_setDependencyConsumption(read) { readGraph = read; },
            }) }),
            end: async () => {},
        };
        protectMetroDependencyConsumption(metro, uiPackageDir);
        t.after(() => metro.end());
        return { read: callback => readGraph(callback), end: () => metro.end() };
    };

    const first = await publish('un');
    const readerA = serve();
    const mapA = await readerA.read(() => readFile(first.outputPath, 'utf8'));
    assert.ok(mapA.includes(basename(first.assetPaths[0])));

    const translation = join(uiPackageDir, 'sources/text/translations/fr.ts');
    await put(translation, "export const fr = { greeting: 'deux' };");
    const recordPath = fixture.path('source-assets.json');
    const candidatePath = fixture.path('candidate.js');
    const second = await prepareLocaleAssets({ uiPackageDir, outputPath: candidatePath, publicationPath: first.outputPath });
    await put(recordPath, JSON.stringify({ assetPaths: second.assetPaths,
        publications: [{ candidatePath, outputPath: first.outputPath }] }));
    await publishSourceUiAssets({ recordPath });
    const readerB = serve();
    const mapB = await readerB.read(() => readFile(first.outputPath, 'utf8'));
    assert.ok(mapB.includes(basename(second.assetPaths[0])));

    const third = await publish('trois');
    const name = generation => basename(generation.assetPaths[0]);
    assert.deepEqual(await bundles(), [name(first), name(second), name(third)].sort());
    assert.match(await readFile(first.assetPaths[0], 'utf8'), /un/);

    await readerA.end();
    await rm(recordPath);
    await publish('trois');
    assert.deepEqual(await bundles(), [name(second), name(third)].sort());

    await readerB.end();
    await publish('trois');
    assert.deepEqual(await bundles(), [name(third)]);
});

test('reusing source assets never pairs another publisher’s locale map with an older record', async t => {
    const { fixture, uiPackageDir, publish, put } = await localeFixture(t, 'happier-locale-reuse-');
    const previousTasks = process.env.HAPPIER_UI_POSTINSTALL_TASKS;
    process.env.HAPPIER_UI_POSTINSTALL_TASKS = '[]';
    t.after(() => {
        if (previousTasks === undefined) delete process.env.HAPPIER_UI_POSTINSTALL_TASKS;
        else process.env.HAPPIER_UI_POSTINSTALL_TASKS = previousTasks;
    });
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), fixture.path('node_modules'), 'junction');
    const translation = join(uiPackageDir, 'sources/text/translations/fr.ts');
    await put(translation, 'export const fr = { greeting: "un" };');
    const recordPath = join(uiPackageDir, '.expo/hstack/consumer-a/source-assets.json');
    const first = await prepareSourceUiAssets({ uiPackageDir, recordPath, outputDir: fixture.path('stage-a') });
    const locale = first.groups.find(group => group.outputPath.endsWith('localeAssets.generated.js'));
    const firstMap = await readFile(locale.outputPath, 'utf8');
    const other = await publish('deux');
    assert.notEqual(await readFile(other.outputPath, 'utf8'), firstMap);
    // Restoring the source lets A legitimately reuse its own recorded bytes.
    // The mutable map still names B's bundles until A republishes.
    await put(translation, 'export const fr = { greeting: "un" };');
    await prepareSourceUiAssets({ uiPackageDir, recordPath, outputDir: fixture.path('stage-a-refresh') });
    assert.equal(await readFile(locale.outputPath, 'utf8'), firstMap);
    await readFile(locale.assetPaths[0]);
});
