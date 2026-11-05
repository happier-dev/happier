import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as touched from './typecheckTouched.mjs';
import { compareTouchedTypecheckLocations } from './typecheckDiagnostics.mjs';
import { isSelfDispatchingPackageCommand, renderNativeCommandPolicy, resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';

test('explicit shared baseline ignores newer corridor inventories and normalizes both recorded formats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  for (const path of ['apps/ui/sources/a.ts', 'apps/cli/src/b.ts']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), '');
  }
  const files = [
    ['ui-old.locs', 'sources/old.ts:1:TS2322\n'],
    ['ui-current.locs', 'sources/a.ts:7:TS2322\n../cli/src/b.ts(3,8): error TS2345\n'],
    ['ui-current-new-vs-old.locs', 'sources/not-a-baseline.ts:1:TS2322\n'],
    ['ui-partial.locs', 'sources/incomplete.ts:1:TS2322\n'],
    ['ui-corridor.locs', 'sources/a.ts:99:TS2322\n'],
  ];
  for (const [index, [name, body]] of files.entries()) {
    const file = join(directory, name);
    await writeFile(file, body);
    await utimes(file, index + 1, index + 1);
  }
  const result = await touched.readSharedTypecheckBaseline(root, 'apps/ui', '.project/tmp/systemic-orch/ui-current.locs');
  assert.equal(result.path, join(directory, 'ui-current.locs'));
  assert.deepEqual(result.locations, ['apps/cli/src/b.ts:3:TS2345', 'apps/ui/sources/a.ts:7:TS2322']);
  await writeFile(join(directory, 'ui-current.locs'), 'compiler did not launch\n');
  await assert.rejects(touched.readSharedTypecheckBaseline(root, 'apps/ui', '.project/tmp/systemic-orch/ui-current.locs'), /invalid.*baseline/i);
});

test('repository-relative shared baseline matches unchanged UI, sibling CLI and plugin diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  // Location-only vectors from ui-1104b; the sibling path also covers the
  // apps/ui/../cli form before the compiler owner normalizes it.
  const current = [
    'apps/ui/sources/__tests__/app/machine/machineInstallables.managedProjection.test.tsx:70:TS2741',
    'apps/cli/src/agent/acp/runtime/publicSession/createPublicAcpSession.ts:1880:TS2322',
    'packages/plugins/channels/src/channelAttachmentRuntime.ts:72:TS18046',
  ];
  for (const row of current) {
    const path = row.replace(/:\d+:TS\d+$/u, '');
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), '');
  }
  const baselineFile = join(directory, 'ui-1104b.locs');
  await writeFile(baselineFile, [current[0], current[1].replace('apps/cli/', 'apps/ui/../cli/'),
    current[2].replaceAll('/', '\\')].join('\n'));
  const baseline = await touched.readSharedTypecheckBaseline(root, 'apps/ui', baselineFile);
  assert.deepEqual(compareTouchedTypecheckLocations({ baseline: baseline.locations, current,
    paths: ['apps/ui', 'apps/cli', 'packages/plugins'] }), { added: [], removed: [], unattributed: [] });
  assert.deepEqual(baseline.locations, [...current].sort());
  // ui-1104b also contains compiler headers with columns and diagnostic prose.
  await writeFile(baselineFile, current[0].replace(':70:TS2741', '(70,9): error TS2741'));
  assert.deepEqual((await touched.readSharedTypecheckBaseline(root, 'apps/ui', baselineFile)).locations, [current[0]]);
});

test('a shared baseline path resolving to neither repository nor legacy package source is invalid', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ui-invalid.locs'), 'apps/ui/sources/missing.ts:7:TS2322\n');
  await assert.rejects(touched.readSharedTypecheckBaseline(root, 'apps/ui', '.project/tmp/systemic-orch/ui-invalid.locs'), /invalid shared typecheck baseline/u);
});

test('missing baseline is unavailable, whereas an empty completed baseline is a real zero', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(touched.readSharedTypecheckBaseline(root, 'apps/ui', '.project/tmp/systemic-orch/ui-green.locs'), /baseline.*unavailable/i);
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ui-green.locs'), '');
  assert.deepEqual((await touched.readSharedTypecheckBaseline(root, 'apps/ui', '.project/tmp/systemic-orch/ui-green.locs')).locations, []);
});

test('touched typecheck keeps baseline comparison on the controller', async t => {
  const root = await mkdtemp(join(tmpdir(), 'touched-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    'typecheck:touched': 'node scripts/workspaces/typecheckTouched.mjs',
  } }));
  assert.equal(resolveRemoteCommandPolicy(['node', 'scripts/workspaces/typecheckTouched.mjs'],
    { repoRoot: root, cwd: root }).controllerDispatcher, '1');
  assert.equal(resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs'],
    { repoRoot: root, cwd: root }).controllerDispatcher, '0');
  assert.equal(await isSelfDispatchingPackageCommand(['pnpm', 'run', 'typecheck:touched'],
    { repoRoot: root, cwd: root }), true);
});

test('worker compiler transport preserves location-report mode', () => {
  const payload = renderNativeCommandPolicy().split('\n').find(line => line.startsWith('command_payload_environment_names='));
  assert.ok(payload.includes('HAPPIER_TYPECHECK_LOCATIONS_ONLY'));
});
