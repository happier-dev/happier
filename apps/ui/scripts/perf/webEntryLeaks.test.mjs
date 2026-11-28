// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('export measurement rejects each emitted entry leak and admits demanded leaves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-entry-leaks-'));
    const scripts = join(directory, '_expo/static/js/web');
    const source = 'export const marker = 1;';
    const context = '__d((function(g,r,i,a,m,e,d){m.exports={"./(app)/_layout.tsx":{get:()=>r(d[0])},'
        + '"./(app)/index.tsx":{get:()=>r(d[0])},"./_layout.tsx":{get:()=>r(d[0])}}}),1,{"0":0,"paths":{}});';
    const cases = [
        ['/node_modules/@hugeicons/core-free-icons/dist/esm/index.js', 'hugeIconsBarrel'],
        ['/apps/ui/sources/components/ui/icons/iconRegistryHuge.generated.ts', 'hugeIconRegistry'],
        ['/apps/ui/sources/text/translations/ru.ts', 'nonEnglishHostLocales'],
        ['/apps/ui/sources/text/bundledPluginTranslations/ja.generated.ts', 'nonEnglishPluginLocales'],
        ['/packages/protocol/src/index.ts', 'protocolRoot'],
        ['/node_modules/@revenuecat/purchases-js/dist/index.js', 'revenueCatSdk'],
        ['/apps/ui/sources/text/bundledPluginTranslations/en.generated.ts', null],
        ['/node_modules/@hugeicons/core-free-icons/dist/esm/Alert01Icon.js', null],
    ];
    try {
        await mkdir(scripts, { recursive: true });
        await writeFile(join(directory, 'index.html'), '<script src="/_expo/static/js/web/entry.js"></script>');
        await writeFile(join(scripts, 'entry.js'), `${source}\n${context}`);
        for (const [file, expectedLeak] of cases) {
            // The external export boundary supplies a standard one-segment source map.
            // The real Metro consumer, byte attribution and demand assertion run below.
            await writeFile(join(scripts, 'entry.js.map'), JSON.stringify({
                version: 3, sources: [file], names: [], mappings: 'AAAA', sourcesContent: [source],
            }));
            const result = spawnSync(process.execPath, [
                fileURLToPath(new URL('./measureWebEntry.mjs', import.meta.url)),
                `--from-export=${directory}`, '--verify-entry-demand',
            ], { encoding: 'utf8' });
            const measurement = JSON.parse(result.stdout);
            assert.equal(result.status, expectedLeak ? 1 : 0, result.stderr);
            const leaks = measurement.required[0].entryLeaks;
            assert.deepEqual(Object.entries(leaks).filter(([, leak]) => leak.bytes > 0).map(([name]) => name),
                expectedLeak ? [expectedLeak] : []);
            if (expectedLeak) assert.equal(leaks[expectedLeak].bytes, Buffer.byteLength(source));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
