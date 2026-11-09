import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { createManagedChildLifecycle } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { renderMutagenProject, resolveMutagenSessionName } from './utils/dev_targets/mutagen_project.mjs';
import { resolveDevTargetMutagenRuntime } from './utils/dev_targets/mutagen_runtime.mjs';
import { INDEPENDENT_DEV_TARGET_SYNC_OWNER } from './utils/dev_targets/sync_project.mjs';

const stackRootDir = fileURLToPath(new URL('../', import.meta.url));
const repoRootDir = fileURLToPath(new URL('../../../', import.meta.url));

async function startMetroFixture({ statusDelayMs = 0 } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/status' && statusDelayMs > 0) {
      setTimeout(() => {
        response.statusCode = 200;
        response.end('packager-status:running');
      }, statusDelayMs);
      return;
    }
    response.statusCode = 200;
    response.end(request.url === '/status' ? 'packager-status:running' : '<div id="root"></div>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () => await new Promise(resolve => server.close(resolve)),
  };
}

test('source restart carries the borrowed UI origin through the real remote stack chain',
  { skip: process.platform === 'win32', timeout: 60_000 }, async (t) => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-borrowed-origin-chain-', registerCleanup: false });
    const metro = await startMetroFixture({ statusDelayMs: 100 });
    let child;
    let lifecycle;
    t.after(async () => {
      if (child?.exitCode === null && child.signalCode === null) await lifecycle.cleanupChild();
      lifecycle?.dispose();
      await metro.close();
      await fixture.cleanup();
    });

    const storageDir = fixture.path('stacks');
    const consumerStack = 'borrowed-origin-consumer';
    const producerStack = 'borrowed-origin-producer';
    const consumerDir = join(storageDir, consumerStack);
    const producerDir = join(storageDir, producerStack);
    const reloadPreparationCapturePath = fixture.path('reload-preparation-command.txt');
    const remoteCapturePath = fixture.path('remote-command.txt');
    const target = {
      name: 'fixture-target',
      platform: 'posix',
      ssh: 'fixture-target-ssh',
      repoDir: '/fixture/remote/repo',
      cliHomeDir: '/fixture/remote/home',
      remotePath: [dirname(process.execPath), '/usr/bin', '/bin'],
    };
    const config = {
      version: 3,
      targets: [target],
      runtimePlacement: {
        server: { mode: 'prefer-target', target: target.name, fallback: 'error' },
        daemon: { mode: 'prefer-target', target: target.name, fallback: 'local' },
        qa: { mode: 'local' },
      },
      commandExecution: { mode: 'local' },
    };

    const { binDir } = writeFakeBin({
      root: fixture.root,
      name: 'mutagen',
      content: `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'sync' && args[1] === 'monitor') setInterval(() => {}, 1000);
else if (args[0] === 'sync' && args[1] === 'list') {
  const name = args[2] && args[2] !== '--template' ? args[2] : ${JSON.stringify(resolveMutagenSessionName(target.name, repoRootDir))};
  const template = args[args.indexOf('--template') + 1] || '';
  if (template.includes('{{range .}}')) {
    process.stdout.write(name+'|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0|one-way-safe|one-way-safe\\n');
  } else {
    process.stdout.write(JSON.stringify([{name,identifier:name,paused:false,status:'watching',successfulCycles:1,conflicts:[],excludedConflicts:0,alpha:{connected:true,scanned:true,scanProblems:[],excludedScanProblems:0,transitionProblems:[],excludedTransitionProblems:0},beta:{connected:true,scanned:true,scanProblems:[],excludedScanProblems:0,transitionProblems:[],excludedTransitionProblems:0}}])+'\\n');
  }
}
`,
    });
    writeFakeBin({
      root: fixture.root,
      name: 'ssh',
      content: `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const command = args.at(-1) || '';
if (args.includes('-N')) { setInterval(() => {}, 1000); }
else if (command.includes('getconf _NPROCESSORS_ONLN')) {
  process.stdout.write('8 0.1 0.8 1000000 10 1 8000000 10000000 0 0 0 0 0 0 0 linux\\n8000000\\n');
}
else if (command.includes('HSTACK_QA_HOST=')) {
  process.stdout.write('HSTACK_QA_HOST={"platform":"linux","arch":"x64","remote":true}\\n');
} else if (command.includes('prepareSourceRuntimeReload.mjs')) {
  fs.writeFileSync(process.env.HSTACK_RELOAD_PREPARATION_CAPTURE, command);
  process.stdout.write('HSTACK_SOURCE_RELOAD_PREPARED\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', value => { if (value.includes('activate')) process.exit(0); });
} else if (command.includes('ensureEnvFileMutated') && command.includes(' stack start ')) {
  fs.writeFileSync(process.env.HSTACK_REMOTE_COMMAND_CAPTURE, command);
  process.stdout.write('HSTACK_SOURCE_START_SUPERSEDED\\n');
} else {
  process.exit(0);
}
`,
    });

    await Promise.all([
      mkdir(consumerDir, { recursive: true }),
      mkdir(producerDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(consumerDir, 'env'), [
        `HAPPIER_STACK_REPO_DIR=${repoRootDir}`,
        `HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK=${producerStack}`,
        `HAPPIER_STACK_EXPO_SOURCE_STACK=${producerStack}`,
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        'HAPPIER_STACK_AUTH_FLOW=1',
        `HAPPIER_STACK_SHARED_DB_SOURCE_STACK=${producerStack}`,
        'HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=/fixture/shared/env',
      ].join('\n') + '\n'),
      writeFile(join(consumerDir, 'dev-targets.json'), JSON.stringify(config)),
      writeFile(join(producerDir, 'dev-targets.json'), JSON.stringify(config)),
      writeFile(join(producerDir, 'stack.runtime.json'), JSON.stringify({
        startedAt: '2026-10-18T12:00:00.000Z',
        expo: { webPort: metro.port, mobilePort: metro.port, devClientEnabled: true },
        placement: { expo: 'remote' },
        remoteTargets: { remote: { status: 'running', services: { expo: true } } },
        processes: { expoPid: null },
      })),
    ]);

    const env = {
      ...process.env,
      HAPPIER_DEV_TARGET_EXECUTION: '',
      HAPPIER_HSTACK_EXECUTION: '',
      HAPPIER_HSTACK_DISPATCH_CONTROL: '',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: producerStack,
      HAPPIER_STACK_EXPO_METRO_STATUS_TIMEOUT_MS: '20',
      HSTACK_RELOAD_PREPARATION_CAPTURE: reloadPreparationCapturePath,
      HSTACK_REMOTE_COMMAND_CAPTURE: remoteCapturePath,
      PATH: `${binDir}:${process.env.PATH}`,
    };
    const mutagen = resolveDevTargetMutagenRuntime({ stackBaseDir: producerDir, sourceDir: repoRootDir, env });
    await Promise.all([
      mkdir(dirname(mutagen.projectFile), { recursive: true }),
      mkdir(mutagen.opensshDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(mutagen.projectFile, renderMutagenProject({
        sourceDir: repoRootDir,
        targets: [target],
        config,
        ownerId: INDEPENDENT_DEV_TARGET_SYNC_OWNER,
      })),
      writeFile(join(mutagen.opensshDir, 'config'), 'Host fixture-target-ssh\n  HostName fixture.invalid\n'),
    ]);

    // Keep the genuine wrapper in a managed child so the existing test timeout
    // also tears down its supervisor and SSH fixtures before removing inputs.
    child = spawnTestProcess(process.execPath, ['--input-type=module', '--eval', `
      import { runStackScriptWithStackEnv } from ${JSON.stringify(new URL('./stack/run_script_with_stack_env.mjs', import.meta.url).href)};
      await runStackScriptWithStackEnv(${JSON.stringify({
        rootDir: stackRootDir, stackName: consumerStack, scriptPath: 'run.mjs',
        args: ['--runtime=source', '--restart', '--no-browser'],
      })});
    `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    lifecycle = createManagedChildLifecycle(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    t.signal.addEventListener('abort', () => { void lifecycle.cleanupChild(); }, { once: true });
    const [code] = await once(child, 'exit');
    await lifecycle.finalizeChildExit();
    assert.equal(code, 0, output);

    const [reloadPreparationCommand, command] = await Promise.all([
      readFile(reloadPreparationCapturePath, 'utf8'),
      readFile(remoteCapturePath, 'utf8'),
    ]);
    const expectedOrigin = `http://happier-${consumerStack}.localhost:${metro.port}`;
    assert.match(reloadPreparationCommand,
      new RegExp(`HAPPIER_WEBAPP_URL=[^;\\n]*${expectedOrigin.replaceAll('.', '\\.')}`),
      'reload preparation must receive the wrapper-selected borrowed UI origin');
    assert.match(command, new RegExp(`HAPPIER_WEBAPP_URL=${expectedOrigin.replaceAll('.', '\\.')}`));
    assert.match(command, /HAPPIER_STACK_SERVER_PORT=/, 'captured Stack env must launch the remote server');
    assert.match(command, /HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH=1/, 'captured Stack env must launch the remote daemon');
    assert.doesNotMatch(command, /--no-server/);
    assert.doesNotMatch(command, /--no-daemon/);
  });
