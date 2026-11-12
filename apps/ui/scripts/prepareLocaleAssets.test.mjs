// @happier-test-preparation source
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareLocaleAssets } from './prepareLocaleAssets.mjs';
import { publishSourceUiAssets } from './prepareSourceUiAssets.mjs';

test('locale preparation reuses identical content and defers publication until admission', async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-locale-publication-'));
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
    await put(translation, "export const fr = { greeting: 'coucou' };");
    const beforeCandidate = await readFile(b.outputPath, 'utf8');
    const candidate = join(root, 'candidate.js');
    const c = await prepareLocaleAssets({ uiPackageDir, outputPath: candidate, publicationPath: b.outputPath });
    assert.equal(await readFile(b.outputPath, 'utf8'), beforeCandidate, 'preparation does not publish before admission');
    const recordPath = join(root, 'prepared.json');
    await put(recordPath, JSON.stringify({ publications: [{ candidatePath: candidate, outputPath: b.outputPath }] }));
    await publishSourceUiAssets({ recordPath });
    assert.equal(await readFile(b.outputPath, 'utf8'), await readFile(candidate, 'utf8'));
    await readFile(b.assetPaths[0]);
    await readFile(c.assetPaths[0]);
    await prepareLocaleAssets({ uiPackageDir });
    await readFile(b.assetPaths[0]);
});
