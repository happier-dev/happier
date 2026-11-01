import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';
import { ENTRY_GRAPHS } from './entry-load.mjs';

const entry = fileURLToPath(new URL('./entry-load.mjs', import.meta.url));

function graphResults(stdout) {
  return stdout.split('\n').filter(line => line.startsWith('{"graph":')).map(line => JSON.parse(line));
}

test('a symlinked entry executes every declared graph and preserves aggregate failure status', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-entry-symlink-' });
  const link = fixture.path('entry-load.mjs');
  await symlink(entry, link, 'file');
  const result = await runNodeCapture([link]);
  const graphs = graphResults(result.stdout);
  assert.deepEqual(graphs.map(graph => graph.graph), ENTRY_GRAPHS.map(graph => graph.id),
    `exit=${result.code}; graph records=${graphs.length}; ${result.stderr}`);
  assert.equal(result.code, graphs.some(graph => graph.status === 'failed') ? 1 : 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Entry loads incomplete/);
});

test('a symlinked native-child entry imports its requested graph instead of passing silently', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-entry-child-' });
  const link = fixture.path('entry-load.mjs');
  await symlink(entry, link, 'file');
  await mkdir(fixture.path('apps/cli/src'), { recursive: true });
  await writeFile(fixture.path('apps/cli/src/index.ts'), "throw new Error('ENTRYGUARD_CHILD_REACHED');\n");
  const result = await runNodeCapture([link, '--child=cli', `--repo-dir=${fixture.root}`]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /ENTRYGUARD_CHILD_REACHED/);
  assert.equal(graphResults(result.stdout).length, 0, 'the child must not run the parent graph suite');
  assert.doesNotMatch(result.stderr, /Entry loads incomplete/);
});

test('an early successful process exit fails explicitly for zero or partial graph results', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-entry-incomplete-' });
  for (const completed of [0, 2]) {
    await t.test(`${completed} completed graphs`, async () => {
      const preload = fixture.path(`exit-after-${completed}.mjs`);
      // Process creation and filesystem allocation are OS boundaries. Keep the
      // real graph loop, result aggregation and exit handling under test.
      await writeFile(preload, `
      import childProcess from 'node:child_process';
      import fs from 'node:fs/promises';
      import { EventEmitter } from 'node:events';
      import { PassThrough } from 'node:stream';
      import { syncBuiltinESMExports } from 'node:module';
      const mkdtemp = fs.mkdtemp;
      let started = 0;
      fs.mkdtemp = async (...args) => {
        if (String(args[0]).includes('hstack-entry-load-') && started++ === ${completed}) process.exit(0);
        return mkdtemp(...args);
      };
      childProcess.spawn = () => {
        const child = new EventEmitter();
        child.stderr = new PassThrough();
        process.nextTick(() => child.emit('close', 0, null));
        return child;
      };
      syncBuiltinESMExports();
      `);
      const result = await runNodeCapture(['--import', pathToFileURL(preload).href, entry]);
      assert.equal(graphResults(result.stdout).length, completed, result.stderr);
      assert.equal(result.code, 1, `exit after ${completed} results must fail: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`Entry loads incomplete: ${completed}/${ENTRY_GRAPHS.length} graph results`));
      for (const graph of ENTRY_GRAPHS.slice(completed)) assert.ok(result.stderr.includes(graph.id), `missing graph ${graph.id} must be named`);
    });
  }
});
