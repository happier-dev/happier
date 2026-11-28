import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

const execFileAsync = promisify(execFile);

test('web entry attribution includes the prerequisites of Home and excludes undemanded chunks', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-entry-delivery-' });
  const scriptDirectory = '_expo/static/js/web';
  const chunk = name => `/${scriptDirectory}/${name}.js`;
  const context = `__d((function(g,r,i,a,m,e,d){m.exports={"./(app)/_layout.tsx":{get:()=>r(d[2])},"./(app)/index.tsx":{get:()=>r(d[1])(d[3],d.paths)},"./(app)/settings.tsx":{get:()=>r(d[1])(d[4],d.paths)},"./_layout.tsx":{get:()=>r(d[2])}}}),1,{"0":0,"1":7,"2":10,"3":11,"4":12,"paths":{"11":${JSON.stringify([chunk('__common'), chunk('home')])},"12":${JSON.stringify(chunk('settings'))}}});`;
  const files = {
    entry: { source: context, route: '/sources/app/_layout.tsx' },
    home: { source: '__d(home);', route: '/sources/app/(app)/index.tsx' },
    __common: { source: '__d(shared);', route: '/sources/shared/boot.ts' },
    settings: { source: '__d(settings);', route: '/sources/app/(app)/settings.tsx' },
  };
  await mkdir(fixture.path(scriptDirectory), { recursive: true });
  await writeFile(fixture.path('index.html'), `<script src="${chunk('entry')}"></script>`);
  for (const [name, { source, route }] of Object.entries(files)) {
    const file = fixture.path(scriptDirectory, `${name}.js`);
    await writeFile(file, source);
    if (name === '__common') continue;
    await writeFile(`${file}.map`, JSON.stringify({
      version: 3, sources: [route], names: [], mappings: 'AAAA', sourcesContent: [source],
    }));
  }
  const measure = fileURLToPath(new URL('../../apps/ui/scripts/perf/measureWebEntry.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [measure, `--from-export=${fixture.root}`]);
  const { required, homeRouteChunks, homeRouteMinimumBytes } = JSON.parse(stdout);

  assert.deepEqual(required.map(row => `/${row.file}`), [chunk('entry')]);
  assert.deepEqual(homeRouteChunks.map(row => `/${row.file}`), [chunk('__common'), chunk('home')]);
  assert.equal(homeRouteMinimumBytes, Buffer.byteLength(files.entry.source + files.__common.source + files.home.source));
});
