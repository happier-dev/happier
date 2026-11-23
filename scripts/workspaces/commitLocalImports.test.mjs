import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCommitGate } from './commitGate.mjs';

async function fixture(t) {
  const repo = await mkdtemp(join(tmpdir(), 'happier-local-imports-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = async (path, content) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  const commit = (...paths) => {
    git('add', '--', ...paths);
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  git('config', 'user.name', 'Local import fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await write('apps/ui/tsconfig.json', JSON.stringify({ compilerOptions: {
    module: 'esnext', moduleResolution: 'bundler', paths: { '@/*': ['./sources/*'] },
  } }));
  return { repo, write, commit };
}

const hook = 'apps/ui/sources/useMachinePresets.ts';
const presets = 'apps/ui/sources/machinePresetsResource.ts';
const query = 'apps/ui/sources/usageQueryResource.ts';
const failure = 'apps/ui/sources/usageReadFailure.ts';

test('c456ebb6c75: a new call cannot rely on an import only in the checkout', async t => {
  const { repo, write, commit } = await fixture(t);
  const imports = "import { readMachinePresetRevisionsSnapshot } from '@/machinePresetsResource';\n";
  const countImport = "import { readMachinePresetCountSnapshot } from '@/machinePresetsResource';\n";
  const existing = 'export const readMachinePresetRevisionsSnapshot = () => [];\n';
  const call = 'export const useCount = () => readMachinePresetCountSnapshot();\n';
  await write(hook, imports + 'export const useCount = () => readMachinePresetRevisionsSnapshot().length;\n');
  await write(presets, existing);
  const base = commit('apps/ui');
  await write(hook, imports + call);
  await write(presets, existing + 'export const readMachinePresetCountSnapshot = () => 0;\n');
  const broken = commit(hook, presets);
  await write(hook, countImport + imports + call);
  const rejected = await runCommitGate({ repo, base, tree: broken });
  assert.equal(rejected.verdict, 'refused');
  assert.match(rejected.findings.join('\n'), /missing binding: .*readMachinePresetCountSnapshot.*@\/machinePresetsResource/u);
  assert.equal((await runCommitGate({ repo, base, tree: commit(hook) })).verdict, 'pass');
});

test('d808cd39052: an alias and a relative import cannot resolve a checkout-only file', async t => {
  const { repo, write, commit } = await fixture(t);
  await write(query, 'export const canRetry = () => false;\n');
  await write('apps/ui/sources/assets/logo.png', 'tracked image');
  const base = commit('apps/ui');
  await write(query, [
    "import { canRetryUsageCoverageFailure } from '@/usageReadFailure';",
    "export { needsNewerServer } from './usageReadFailure';",
    "export const logo = require('@/assets/logo.png');",
    'export const canRetry = canRetryUsageCoverageFailure;', '',
  ].join('\n'));
  const broken = commit(query);
  await write(failure, 'export const canRetryUsageCoverageFailure = () => true;\n');
  const rejected = await runCommitGate({ repo, base, tree: broken });
  assert.equal(rejected.verdict, 'refused');
  assert.deepEqual(rejected.findings, [
    `missing module: ${query} -> ./usageReadFailure`,
    `missing module: ${query} -> @/usageReadFailure`,
  ]);
  const missingNamedExport = await runCommitGate({ repo, base, tree: commit(failure) });
  assert.deepEqual(missingNamedExport.findings, [`missing export: ${query} imports { needsNewerServer } from ./usageReadFailure`]);
  await write(failure, 'export const canRetryUsageCoverageFailure = () => true;\nexport const needsNewerServer = () => false;\n');
  assert.equal((await runCommitGate({ repo, base, tree: commit(failure) })).verdict, 'pass');
});
