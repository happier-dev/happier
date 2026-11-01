import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCommitTypeCoherence } from './checkCommitTypeCoherence.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';

// A shared dirty checkout: the worktree holds both halves of a change, a commit takes only one.
async function checkout(t) {
  const repo = await mkdtemp(join(tmpdir(), 'happier-commit-coherence-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'Coherence Test');
  git('config', 'user.email', 'coherence@example.invalid');
  const write = (path, content) => writeFile(join(repo, path), content);
  await write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        types: [],
      },
      include: ['*.ts'],
    }),
  );
  await write('producer.ts', 'export const original = 1;\n');
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: number = original;\n",
  );
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const commitOnly = (...paths) => {
    git('add', '--', ...paths);
    git('commit', '--quiet', '-m', `commit ${paths.join(' ')}`);
    return git('rev-parse', 'HEAD').trim();
  };
  return { repo, write, commitOnly };
}

test('a consumer committed without its uncommitted producer is incoherent at the commit', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'producer.ts',
    'export const original = 1;\nexport const added = 2;\n',
  );
  await write(
    'consumer.ts',
    "import { added } from './producer';\nexport const value: number = added;\n",
  );
  const commit = commitOnly('consumer.ts');

  const result = checkCommitTypeCoherence({
    repo,
    base: `${commit}^`,
    tree: commit,
  });

  assert.deepEqual(
    result.fresh.map((row) => [row.file, row.code]),
    [['consumer.ts', 2305]],
  );
});

test('a committed producer change breaks an importer whose adaptation stayed uncommitted', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', 'export const renamed = 1;\n');
  await write(
    'consumer.ts',
    "import { renamed } from './producer';\nexport const value: number = renamed;\n",
  );
  const commit = commitOnly('producer.ts');

  const result = checkCommitTypeCoherence({
    repo,
    base: `${commit}^`,
    tree: commit,
  });

  assert.deepEqual(
    result.fresh.map((row) => [row.file, row.code]),
    [['consumer.ts', 2305]],
  );
});

test('a slice that carries its producer is coherent although the worktree differs', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'producer.ts',
    'export const original = 1;\nexport const added = 2;\n',
  );
  await write(
    'consumer.ts',
    "import { added } from './producer';\nexport const value: number = added;\n",
  );
  const commit = commitOnly('producer.ts', 'consumer.ts');
  await write('producer.ts', 'export const unrelatedLaterWork = 3;\n');

  assert.deepEqual(
    checkCommitTypeCoherence({ repo, base: `${commit}^`, tree: commit }).fresh,
    [],
  );
});

test('importer discovery ignores fixture text and comments while retaining real imports', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('fixture.ts', "export const source = `import { original } from './producer';`;\n// import { original } from './producer';\n/* require('./producer') */\n");
  await write('dynamic.ts', "export const load = () => import('./producer');\n");
  await write('reexport.ts', "export { original } from './producer';\n");
  await write('type.ts', "export type Module = typeof import('./producer');\n");
  await write('equals.ts', "import producer = require('./producer');\nexport const value = producer.original;\n");
  await write('require.ts', "declare function require(id: string): unknown;\nexport const value = require('./producer');\n");
  await write('mock.ts', "declare const vi: { mock(id: string): void };\nvi.mock('./producer');\n");
  const base = commitOnly('fixture.ts', 'dynamic.ts', 'reexport.ts', 'require.ts', 'mock.ts', 'type.ts', 'equals.ts');
  await write('producer.ts', 'export const original = 2;\n');
  const tree = commitOnly('producer.ts');
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.fresh, []);
  assert.equal(result.roots, 8, 'producer plus seven real importers; fixture text has no importer root');
});

test('diagnostics already present at the base are not attributed to the slice', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\n",
  );
  const broken = commitOnly('consumer.ts');
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\nexport const more = 1;\n",
  );
  const commit = commitOnly('consumer.ts');

  assert.equal(
    checkCommitTypeCoherence({ repo, base: broken, tree: commit }).fresh.length,
    0,
  );
  assert.deepEqual(
    checkCommitTypeCoherence({
      repo,
      base: `${broken}^`,
      tree: broken,
    }).fresh.map((row) => row.code),
    [2322],
  );
});

test('an exact same-directory rename retains its diagnostic baseline without hiding new importer failures', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', 'export const original: string = 1;\n');
  const base = commitOnly('producer.ts');
  execFileSync('git', ['mv', 'producer.ts', 'producer.composed.ts'], { cwd: repo });
  const renamed = commitOnly('producer.composed.ts');
  const result = checkCommitTypeCoherence({ repo, base, tree: renamed });
  assert.deepEqual(result.fresh.map(({ file, code }) => [file, code]), [['consumer.ts', 2307]]);
});

test('excluded unmodified importers do not inject globals into the owner, while included importers are checked', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'], exclude: ['*.composed.ts'] }));
  await write('excluded.composed.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\n");
  const base = commitOnly('tsconfig.json', 'excluded.composed.ts');
  await write('producer.ts', "export const original = 'changed';\nexport const error: Error = { name: 'Error', message: 'fixture' };\n");
  const tree = commitOnly('producer.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree }).fresh.map(({ file, code }) => [file, code]), [['consumer.ts', 2322]]);
  await write('excluded.composed.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\nexport const invalid: number = 'invalid';\n");
  const changedExcluded = commitOnly('excluded.composed.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base: tree, tree: changedExcluded }).fresh, []);
});

test('an aggregate with a renamed excluded renderer importer uses the package compiler context', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'], exclude: ['*.composed.ts'] }));
  await write('renderer.test.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\n");
  const base = commitOnly('tsconfig.json', 'renderer.test.ts');
  execFileSync('git', ['mv', 'renderer.test.ts', 'renderer.composed.ts'], { cwd: repo });
  commitOnly('renderer.composed.ts');
  await write('producer.ts', "export const original = 1;\nexport const error: Error = { name: 'Error', message: 'fixture' };\n");
  const tree = commitOnly('producer.ts');

  const args = ['--showConfig', '-p', join(repo, 'tsconfig.json')];
  // --showConfig only reads configuration; this boundary fixture needs no compiler admission.
  const compiler = resolveTypeScriptCliInvocation({ args, workspaceDir: repo, env: { CI: 'true' } });
  const configured = JSON.parse(execFileSync(compiler.command, [...compiler.argsPrefix, ...args], { cwd: repo, encoding: 'utf8' }));
  assert.deepEqual(configured.files.sort(), ['./consumer.ts', './producer.ts']);
  // Later worktree configuration must not change the committed package's membership.
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree }).fresh, []);
});

test('a new diagnostic location is not hidden by an identical message elsewhere in the base', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\n",
  );
  const base = commitOnly('consumer.ts');
  await write(
    'consumer.ts',
    "import { original } from './producer';\n\nexport const value: string = original;\n",
  );
  const tree = commitOnly('consumer.ts');

  assert.deepEqual(
    checkCommitTypeCoherence({ repo, base, tree }).fresh.map(
      ({ file, line, code }) => ({ file, line, code }),
    ),
    [{ file: 'consumer.ts', line: 3, code: 2322 }],
  );
});

test('a pre-existing error in an unchanged file stays attributed to the base when its printed types change', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', "export const original = { a: '' };\n");
  const broken = commitOnly('producer.ts');
  // The slice reshapes the producer; the untouched consumer's existing TS2322 now prints `{ b: string; }`.
  await write('producer.ts', "export const original = { b: '' };\n");
  const commit = commitOnly('producer.ts');

  assert.equal(
    checkCommitTypeCoherence({ repo, base: broken, tree: commit }).fresh.length,
    0,
  );
});
