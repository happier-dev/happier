import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createLoadSentinel, sentinelGraphs } from './load-sentinel.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

test('SDK publication preflight detects wildcard incident, deduplicates URGENT, and clears after repair', async t => {
  const graph = sentinelGraphs().find(graph => graph.id === 'sdk-publication-spec');
  assert.ok(graph, 'publication preflight is included in every sentinel pass');
  const fixture = await createTempFixture(t, { prefix: 'sentinel-sdk-spec-' });
  const sdk = fixture.path('packages/plugin-sdk');
  await mkdir(sdk, { recursive: true });
  await cp(join(repo, 'packages/plugin-sdk/src'), join(sdk, 'src'), { recursive: true });
  await cp(join(repo, 'packages/plugin-sdk/package.json'), join(sdk, 'package.json'));
  const spec = join(sdk, 'src/scm/hosting/index.public.ts');
  const original = await readFile(spec, 'utf8');
  const results = [], posts = [];
  const sentinel = createLoadSentinel({ repoDir: fixture.root, graphs: [graph], signal: t.signal,
    waitForQuiet: async () => {}, onResult: result => results.push(result),
    post: async notice => posts.push(notice) });
  await sentinel.request();
  assert.equal(results.at(-1).status, 'passed');
  await writeFile(spec, "export * from '../hostingProvider.js';\n");
  await sentinel.request();
  assert.equal(results.at(-1).status, 'failed');
  assert.equal(results.at(-1).loadError.code, 'sdk_publication_spec_failed');
  assert.equal(posts.length, 1);
  assert.match(posts[0], /URGENT/);
  assert.equal(await readFile(spec, 'utf8'), "export * from '../hostingProvider.js';\n");
  await sentinel.request();
  assert.equal(posts.length, 1);
  await writeFile(spec, original);
  await sentinel.request();
  assert.equal(results.at(-1).status, 'passed');
  assert.equal(posts.length, 2);
  assert.match(posts[1], /cleared/);
  console.log(JSON.stringify({ probe: graph.id, samples: results.map(({status, elapsedMs}) => ({status, elapsedMs})) }));
});
