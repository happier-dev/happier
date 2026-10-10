import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  for (const relative of ['apps/stack/scripts/utils', 'apps/stack/scripts/provision', 'scripts/workspaces']) {
    await cp(join(source, relative), join(worker, relative), { recursive: true,
      filter: path => !path.endsWith('.test.mjs') });
  }
  const common = join(worker, 'packages/cli-common');
  await mkdir(common, { recursive: true });
  for (const entry of await readdir(join(source, 'packages/cli-common'), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'package.json' || /\.(?:mjs|cjs)$/.test(entry.name))) {
      await cp(join(source, 'packages/cli-common', entry.name), join(common, entry.name));
    }
  }
  await writeFile(join(worker, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(worker, 'yarn.lock'), '# cold worker fixture\n');
  for (const component of ['stack', 'ui', 'cli', 'server']) {
    const directory = join(worker, 'apps', component);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@fixture/${component}` }));
  }
  const installs = join(root, 'installs');
  const commands = join(root, 'ssh-commands');
  const { binDir } = writeFakeBin({ root, name: 'corepack', content:
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$QA_INSTALLS"\necho "fixture package service unavailable" >&2\nexit 86\n' });
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
  const result = spawnSync('/bin/bash', ['-c', command.replaceAll('bash -lc', 'bash -c')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
` });
  const target = { name: 'qa-cold', platform: 'posix', ssh: 'fixture-qa-cold', repoDir: worker,
    cliHomeDir: join(root, 'worker-home'), remotePath: [binDir, join(process.execPath, '..')] };
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, npm_execpath: '', NODE_PATH: '', NODE_OPTIONS: '',
    HAPPIER_STACK_HOME_DIR: join(root, 'stack-home'), HAPPIER_STACK_STACKS_DIR: join(root, 'stacks'),
    QA_INSTALLS: installs, QA_COMMANDS: commands };
  await assert.rejects(stat(join(worker, 'node_modules')), { code: 'ENOENT' });
  const result = await provisionQaDevTarget({ target, stackName: 'fixture', stackBaseDir: join(root, 'stack'), env });
  assert.equal(result.dependenciesReady, false);
  assert.match(result.dependencies.error, /dependency bootstrap.*1/i);
  assert.match(await readFile(installs, 'utf8'), /^yarn install .*--ignore-scripts/m);
  const dispatched = (await readFile(commands, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(!dispatched.some(command => command.includes('--qa-setup-worker')), 'failed admission must not start the dependency-consuming entrypoint');
});
