import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { provisionQaDevTarget } from './provision.mjs';

test('QA setup admits a fresh worker dependency graph before loading its entrypoint and preserves installation failure', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-qa-cold-worker-' });
  const worker = join(root, 'worker');
  const source = fileURLToPath(new URL('../../../../../', import.meta.url));
  // Relocate the actual authored bootstrap/worker import graph. No inherited
  // node_modules or compiled cli-common can make this fresh worker load.
  for (const relative of ['apps/stack/scripts/utils', 'apps/stack/scripts/provision', 'scripts/workspaces', 'scripts/ci']) {
    await cp(join(source, relative), join(worker, relative), { recursive: true,
      filter: path => !path.endsWith('.test.mjs') });
  }
  for (const relative of [
    'apps/cli/scripts/build-owned/bundledPluginMembership.ts',
    'apps/cli/scripts/buildPublication.mjs',
    'apps/stack/scripts/build/sourceWebExportArgs.mjs',
  ]) {
    await mkdir(dirname(join(worker, relative)), { recursive: true });
    await cp(join(source, relative), join(worker, relative));
  }
  const common = join(worker, 'packages/cli-common');
  await mkdir(common, { recursive: true });
  for (const entry of await readdir(join(source, 'packages/cli-common'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || /\.(?:mjs|cjs)$/.test(entry.name))) {
      await cp(join(source, 'packages/cli-common', entry.name), join(common, entry.name));
    }
  }
  const archiveBytes = 'fixture pnpm archive';
  const integrity = createHash('sha512').update(archiveBytes).digest('hex');
  await writeFile(join(worker, 'package.json'), JSON.stringify({
    private: true, packageManager: `pnpm@12.14.0+sha512.${integrity}`,
  }));
  await writeFile(join(worker, 'pnpm-lock.yaml'), '# cold worker fixture\n');
  await writeFile(join(worker, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const component of ['stack', 'ui', 'cli', 'server']) {
    const directory = join(worker, 'apps', component);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  const installs = join(root, 'installs');
  const bootstrapFailure = join(root, 'bootstrap-failure');
  const commands = join(root, 'ssh-commands');
  const { binDir } = writeFakeBin({ root, name: 'pnpm', content:
    '#!/bin/sh\nif [ "$1" = --version ]; then echo 12.14.0; exit 0; fi\nprintf "%s\\n" "$*" >> "$QA_INSTALLS"\necho "fixture package service unavailable" >&2\nexit 86\n' });
  // Package acquisition and installation are process boundaries. The real
  // setup owner verifies the archive integrity before reaching dependency install.
  writeFakeBin({ root, name: 'npm', content: `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'pack') {
  const filename = 'pnpm-12.14.0.tgz';
  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], filename), ${JSON.stringify(archiveBytes)});
  console.log(JSON.stringify([{ filename }]));
} else if (args.join(' ') !== 'install --global ' + args[2]) process.exit(79);
` });
  writeFakeBin({ root, name: 'mutagen', content: `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'sync' && args[1] === 'list') {
  if (args.at(-1) === '{{json .}}') console.log(JSON.stringify([{ name: args[2], paused: false,
    status: 'watching', successfulCycles: 1, alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true } }]));
  else console.log(args[2] + '|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0|WatchModePortable|WatchModePortable');
}
else if (!(args[0] === 'sync' && args[1] === 'flush')) process.exit(79);
` });
  // SSH and the package manager are system boundaries. Execute the complete
  // real bootstrap remotely; only unrelated disk/power probes return fixtures.
  writeFakeBin({ root, name: 'ssh', content: `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const command = process.argv.at(-1);
fs.appendFileSync(process.env.QA_COMMANDS, JSON.stringify(command) + '\\n');
if (command.includes('worker_disk_budget.mjs')) console.log(JSON.stringify({ admitted: true }));
else if (command.includes('linux_power_healthy')) console.log('__HAPPIER_WORKER_POWER__=' + JSON.stringify({ ok: true }));
else {
  // A real remote login inherits its configured remotePath. A local test
  // login shell would replace that PATH with the test runner's shell profile.
  const result = spawnSync('/bin/bash', ['-c', command.replaceAll('bash -lc', 'bash -c')], {
    encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) fs.writeFileSync(process.env.QA_BOOTSTRAP_FAILURE, result.stderr ?? '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
` });
  const target = { name: 'qa-cold', platform: 'posix', ssh: 'fixture-qa-cold', repoDir: worker,
    cliHomeDir: join(root, 'worker-home'), remotePath: [binDir, join(process.execPath, '..')] };
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, npm_execpath: '', NODE_PATH: '', NODE_OPTIONS: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '',
    HAPPIER_STACK_HOME_DIR: join(root, 'stack-home'), HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'),
    QA_INSTALLS: installs, QA_COMMANDS: commands, QA_BOOTSTRAP_FAILURE: bootstrapFailure };
  await assert.rejects(stat(join(worker, 'node_modules')), { code: 'ENOENT' });
  const result = await provisionQaDevTarget({ target, stackName: 'fixture', stackBaseDir: join(root, 'stack'), env });
  assert.equal(result.dependenciesReady, false);
  assert.match(result.dependencies.error, /dependency bootstrap.*1/i);
  assert.equal(await stat(installs).then(() => true, () => false), true,
    await readFile(bootstrapFailure, 'utf8').catch(() => 'dependency install was not reached'));
  assert.match(await readFile(installs, 'utf8'), /^install --prod=false --ignore-scripts --frozen-lockfile/m);
  const dispatched = (await readFile(commands, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!dispatched.some(command => command.includes('--qa-setup-worker')), 'failed admission must not start the dependency-consuming entrypoint');
});
