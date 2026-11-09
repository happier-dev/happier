import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveReleaseMetadataCi } from './classify-source-ci-paths.mjs';

test('metadata child reuses only a complete source baseline and keeps runtime/dependency edits on source gates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-metadata-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'CI fixture');
  git('config', 'user.email', 'ci@example.test');
  await mkdir(join(root, 'apps/ui/src-tauri'), { recursive: true });
  await writeFile(join(root, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/app', version: '0.3.0-rc.1', scripts: { build: 'build' } }));
  await writeFile(join(root, 'apps/ui/src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.3.0-rc.1', identifier: 'happier.test' }));
  const notes = '## Release 2026-11-01.1 - 2026-11-01\n\n<!-- happier-release-note-projections:v1\n' + JSON.stringify({ expo: { message: 'Approved update.' }, appStore: { whatsNew: 'Approved update.' }, playStore: { whatsNew: 'Approved update.' } }) + '\n-->\n\nApproved update.\n';
  await writeFile(join(root, 'apps/ui/CHANGELOG.md'), notes);
  git('add', '.'); git('commit', '-qm', 'baseline');
  const baseSha = git('rev-parse', 'HEAD');
  childProcess.execFileSync(process.execPath, [fileURLToPath(new URL('../pipeline/release/bump-version.mjs', import.meta.url)), '--component', 'app', '--bump', 'patch'], { cwd: root });
  await writeFile(join(root, 'apps/ui/CHANGELOG.md'), notes + '\nApproved correction.\n');
  git('add', '.'); git('commit', '-qm', 'materialize');
  const sourceSha = git('rev-parse', 'HEAD');
  const run = { id: 42, path: '.github/workflows/tests.yml', head_sha: baseSha, head_branch: 'v0.3', event: 'push', status: 'completed', conclusion: 'success', head_repository: { full_name: 'happier-dev/happier' } };
  const summary = { schemaVersion: 1, runId: '42', sourceSha: baseSha, failures: [], lanes: [
    { id: 'gate-prepare', result: 'success', outputs: { metadata_only: 'false', packages: '["ui"]', server_db_contract: 'false' } },
    { id: 'gate-unit', result: 'success' }, { id: 'gate-compiler', result: 'success' },
    { id: 'gate-build-artifacts', result: 'success' }, { id: 'server-db-contract', result: 'skipped' },
    { id: 'installers-smoke-windows', result: 'success' },
  ] };
  let response = summary;
  let available = true;
  const realSpawn = childProcess.spawnSync;
  // GitHub is external; Git, metadata comparison, notes projection and CI admission stay real.
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    if (command !== 'gh') return realSpawn(command, args, options);
    if (args[0] === 'api') return { status: 0, stdout: JSON.stringify(args[1].includes('workflows') ? { workflow_runs: available ? [run] : [] } : run) };
    writeFileSync(join(args[args.indexOf('--dir') + 1], 'ci-summary.json'), JSON.stringify(response));
    return { status: 0, stdout: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const input = { repoRoot: root, repository: 'happier-dev/happier', sourceBranch: 'v0.3', baseSha, sourceSha };
  assert.deepEqual(await resolveReleaseMetadataCi(input), { metadataOnly: true, baseSha, baseRunId: '42' });
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/usr/bin/env node\n' + `const fs = require('node:fs'); const args = process.argv.slice(2);\nif (args[0] === 'api') console.log(JSON.stringify(args[1].includes('workflows') ? { workflow_runs: [${JSON.stringify(run)}] } : ${JSON.stringify(run)}));\nelse fs.writeFileSync(args[args.indexOf('--dir') + 1] + '/ci-summary.json', ${JSON.stringify(JSON.stringify(summary))});\n`);
  await chmod(join(bin, 'gh'), 0o755);
  const output = join(root, 'github-output');
  const selected = childProcess.execFileSync(process.execPath, [fileURLToPath(new URL('./selectAffectedGatePackages.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', input: 'apps/ui/package.json\0apps/ui/CHANGELOG.md\0',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: input.repository, GITHUB_REF_NAME: 'v0.3', GITHUB_SHA: sourceSha, BASE_SHA: baseSha },
  });
  assert.equal(selected.trim(), '[]', 'the real selector must omit broad source unit jobs for admitted metadata');
  assert.match(await readFile(output, 'utf8'), /^metadata_only=true$/m);
  for (const changed of [
    { ...summary, sourceSha: sourceSha },
    { ...summary, lanes: summary.lanes.filter((lane) => lane.id !== 'gate-compiler') },
    { ...summary, lanes: summary.lanes.map((lane) => lane.id === 'gate-prepare' ? { ...lane, outputs: { ...lane.outputs, metadata_only: 'true' } } : lane) },
  ]) {
    response = changed;
    assert.equal((await resolveReleaseMetadataCi(input)).metadataOnly, false);
  }
  response = summary; available = false;
  assert.equal((await resolveReleaseMetadataCi(input)).metadataOnly, false);
  available = true;
  for (const [path, content] of [
    ['apps/ui/package.json', JSON.stringify({ name: '@happier-dev/app', version: '0.3.1', scripts: { build: 'different' } })],
    ['apps/ui/package.json', JSON.stringify({ name: '@happier-dev/app', version: '0.3.1', dependencies: { external: '2' }, scripts: { build: 'build' } })],
    ['apps/ui/src-tauri/tauri.conf.json', JSON.stringify({ version: '0.3.1', identifier: 'other.test' })],
    ['apps/ui/src-tauri/tauri.conf.json', JSON.stringify({ version: '9.9.9', identifier: 'happier.test' })],
    ['apps/ui/app.config.js', 'export default { runtimeVersion: "new" };'],
    ['apps/ui/changelog.json', '{}'],
  ]) {
    await writeFile(join(root, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/app', version: '0.3.1', scripts: { build: 'build' } }));
    await writeFile(join(root, 'apps/ui/src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.3.1', identifier: 'happier.test' }));
    await rm(join(root, 'apps/ui/app.config.js'), { force: true });
    await rm(join(root, 'apps/ui/changelog.json'), { force: true });
    await writeFile(join(root, path), content);
    git('add', 'apps/ui'); git('commit', '-qm', path);
    assert.equal((await resolveReleaseMetadataCi({ ...input, sourceSha: git('rev-parse', 'HEAD') })).metadataOnly, false);
  }
  assert.equal((await resolveReleaseMetadataCi({ ...input, baseSha: '0'.repeat(40) })).metadataOnly, false);
});
