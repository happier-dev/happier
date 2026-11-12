// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareLocaleAssets, publishLocaleAssets } from './prepareLocaleAssets.mjs';
import { publishSourceUiAssets } from './prepareSourceUiAssets.mjs';

test('locale publication retains two distinct generations, including deferred publication, and reuses identical content', async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-locale-retention-'));
    t.after(() => rm(root, { recursive: true, force: true }));
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
    await readFile(a.assetPaths[0]); // A warm repeat must not evict the previous distinct generation.
    await put(translation, "export const fr = { greeting: 'coucou' };");
    const beforeCandidate = await readFile(b.outputPath, 'utf8');
    const candidate = join(root, 'candidate.js');
    const c = await prepareLocaleAssets({ uiPackageDir, outputPath: candidate, publicationPath: b.outputPath });
    await readFile(a.assetPaths[0]);
    assert.equal(await readFile(b.outputPath, 'utf8'), beforeCandidate, 'preparation does not publish before admission');
    const recordPath = join(root, 'prepared.json');
    await put(recordPath, JSON.stringify({ publications: [{ candidatePath: candidate, outputPath: b.outputPath }] }));
    await publishSourceUiAssets({ recordPath });
    const bundles = (await readdir(dirname(c.assetPaths[0]))).filter(name => name.endsWith('.locale.bundle'));
    assert.equal(bundles.length, 2, 'superseded generation is pruned only after publication');
    await assert.rejects(readFile(a.assetPaths[0]), { code: 'ENOENT' });
    await readFile(b.assetPaths[0]);
    await readFile(c.assetPaths[0]);
    await prepareLocaleAssets({ uiPackageDir });
    await readFile(b.assetPaths[0]);
});

// This record is the readiness input that the original prune invalidated.
test('pruning preserves older published and staged source asset records until their consumers release them', async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-locale-records-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = join(root, 'stacks');
    const saved = process.env.HAPPIER_STACK_STORAGE_DIR;
    const savedInventory = process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    process.env.HAPPIER_STACK_STORAGE_DIR = storage;
    t.after(() => { if (saved === undefined) delete process.env.HAPPIER_STACK_STORAGE_DIR;
        else process.env.HAPPIER_STACK_STORAGE_DIR = saved;
        if (savedInventory === undefined) delete process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
        else process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = savedInventory; });
    const uiPackageDir = join(root, 'apps/ui');
    const put = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); };
    const outputPath = join(uiPackageDir, 'sources/text/localeAssets.generated.js');
    const directory = join(uiPackageDir, '.expo/hstack/locales');
    const asset = n => join(directory, `${String(n).padStart(64, '0')}.locale.bundle`);
    const contents = n => `export const LOCALE_ASSETS = { fr: require(${JSON.stringify(asset(n))}) };`;
    const publishedRecord = join(storage, 'repo-dev/expo-dev/instance/plugin-ui/source-assets.json');
    const stagedRecord = join(uiPackageDir, '.expo/hstack/plugin-ui-inputs/.happier-plugin-ui-stage-fixture/inputs/source-assets.json');
    const otherRecords = [join(uiPackageDir, '.expo/hstack/source-assets/source-assets.json'),
        join(uiPackageDir, 'sources/sync/domains/plugins/availability/source-assets.json'),
        join(root, 'explicit-inventory/source-assets.json')];
    process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = join(root, 'explicit-inventory/inventory.js');
    for (let n = 6; n <= 8; n++) {
        await put(asset(n), 'locale bytes');
        await put(otherRecords[n - 6], JSON.stringify({ assetPaths: [asset(n)] }));
    }
    for (let n = 1; n <= 4; n++) {
        await put(asset(n), 'locale bytes');
        await publishLocaleAssets({ outputPath, contents: contents(n) });
        if (n === 1) await put(publishedRecord, JSON.stringify({ assetPaths: [asset(1)] }));
        if (n === 2) await put(stagedRecord, JSON.stringify({ assetPaths: [asset(2)] }));
    }
    const { resolveUiWorkspaceStartupOutputs } = await import('./ensureWorkspacePackagesBuilt.mjs');
    const { hasUsableWorkspaceLastGreen } = await import('../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
    const inventoryPath = join(dirname(publishedRecord), 'inventory.js');
    await put(inventoryPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];');
    const outputs = resolveUiWorkspaceStartupOutputs({ uiPackageDir, env: { HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: inventoryPath } });
    assert.equal(await hasUsableWorkspaceLastGreen(uiPackageDir, { requiredFiles: outputs }), true,
        'Expo readiness must still admit the record naming the older locale generation');
    await readFile(asset(2));
    for (let n = 6; n <= 8; n++) await readFile(asset(n));
    for (const record of otherRecords) await rm(record);
    await rm(publishedRecord);
    await rm(stagedRecord);
    await put(asset(5), 'locale bytes');
    await publishLocaleAssets({ outputPath, contents: contents(5) });
    await assert.rejects(readFile(asset(1)), { code: 'ENOENT' });
    await assert.rejects(readFile(asset(2)), { code: 'ENOENT' });
    await readFile(asset(4));
    await readFile(asset(5));
    for (let n = 6; n <= 8; n++) await assert.rejects(readFile(asset(n)), { code: 'ENOENT' });
});
