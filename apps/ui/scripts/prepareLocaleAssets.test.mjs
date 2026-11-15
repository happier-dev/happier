// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../stack/scripts/testkit/core/temp_fixture.mjs';
import { openLocalePreparation, prepareLocaleAssets } from './prepareLocaleAssets.mjs';
import { publishSourceUiAssets } from './prepareSourceUiAssets.mjs';

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
