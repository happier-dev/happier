import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('named app replay keeps preparation and compiler on its tree while the live dependency changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-revision-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = async (path, content) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.invalid');
  await write('package.json', '{}');
  await write('apps/ui/package.json', JSON.stringify({ name: '@fixture/ui', scripts: {
    'typecheck:source:finite': 'node ../../scripts/workspaces/runTypeScriptCli.mjs -p tsconfig.json',
  } }));
  await write('packages/dependency/graph.json', '"first"');
  // These fixture executables are the process boundary of compileApp. The
  // real replay, worktree, dependency-generation and locking owners run intact.
  await write('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs',
    "import { mkdirSync } from 'node:fs'; mkdirSync('node_modules', { recursive: true });");
  await write('apps/ui/scripts/prepareUiBrowserBundles.mjs', `
    import { readFileSync, writeFileSync } from 'node:fs';
    const graph = readFileSync('../../packages/dependency/graph.json', 'utf8');
    writeFileSync('graph.json', graph);
    writeFileSync(process.env.LIVE_DEPENDENCY, '"second"');
    writeFileSync('declarations.json', readFileSync('../../packages/dependency/graph.json', 'utf8'));
  `);
  await write('scripts/workspaces/runTypeScriptCli.mjs', String.raw`
    import { appendFileSync, readFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    appendFileSync(process.env.REPLAY_OBSERVATIONS, JSON.stringify({
      graph: JSON.parse(readFileSync('graph.json', 'utf8')),
      declarations: JSON.parse(readFileSync('declarations.json', 'utf8')),
      compiler: JSON.parse(readFileSync('../../packages/dependency/graph.json', 'utf8')),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
    }) + '\n');
  `);
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  const observations = join(root, 'observations');
  const replay = revision => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./commitPackageTypecheck.mjs', import.meta.url)), '--compiler-admitted'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env,
        HAPPIER_COMMIT_TYPECHECK_DIR: state, HAPPIER_COMMIT_TYPECHECK_REPO: repo,
        HAPPIER_COMMIT_TYPECHECK_REQUEST: JSON.stringify([{ label: revision, base: revision, tree: revision, scope: 'apps/ui' }]),
        LIVE_DEPENDENCY: join(repo, 'packages/dependency/graph.json'), REPLAY_OBSERVATIONS: observations,
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  };
  replay(first);
  assert.ok(existsSync(observations), 'a named app replay must invoke its compiler even with no package diff');
  assert.deepEqual((await readFile(observations, 'utf8')).trim().split('\n').map(JSON.parse), [
    { graph: 'first', declarations: 'first', compiler: 'first', tree: git('rev-parse', `${first}^{tree}`) },
  ]);
  git('add', '.');
  git('commit', '--quiet', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  replay(second);
  const rows = (await readFile(observations, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[1], { graph: 'second', declarations: 'second', compiler: 'second', tree: git('rev-parse', `${second}^{tree}`) });
});
