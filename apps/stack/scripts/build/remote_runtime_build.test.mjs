import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntimeArtifactComponentsAtPlacement, withAdmittedRuntimeBuildPlacement } from './remote_runtime_build.mjs';
import { installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { renderNativeExecutionProjection } from '../utils/dev_targets/native_execution_projection.mjs';

async function initializeRepo(repo) {
  for (const app of ['cli', 'ui', 'server']) {
    await mkdir(join(repo, 'apps', app), { recursive: true });
    await writeFile(join(repo, 'apps', app, 'package.json'), JSON.stringify({ name: '@fixture/' + app }));
  }
  await writeFile(join(repo, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
}

test('synced mirror runtime build dispatches requested components without uploading source and never replays failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-mirror-dispatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackBaseDir = join(root, 'stack');
  await mkdir(stackBaseDir);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/worker' }],
    runtimePlacement: { build: { mode: 'prefer-target', targets: ['worker'] } },
  }));
  const requestPath = join(root, 'received-request.json');
  let dispatched = 0;
  const transfers = [];
  await assert.rejects(buildRuntimeArtifactComponentsAtPlacement({ rootDir: root, stackBaseDir,
    selection: { components: { server: true } }, target: { platform: process.platform, arch: process.arch },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: root }, transport: {
      spawnController: () => {
        dispatched++;
        return spawn(process.execPath, ['--input-type=module', '-e', `
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const input = createInterface({input:process.stdin});
console.log('HAPPIER_RUNTIME_BUILD_READY='+JSON.stringify({worker:'worker',runtimeTarget:{platform:process.platform,arch:process.arch}}));
input.once('line', async line => { await writeFile(${JSON.stringify(requestPath)}, line); process.exit(23); });
input.once('close', () => process.exit(0));
`], { stdio: ['pipe', 'pipe', 'pipe'] });
      },
      transfer: async request => transfers.push(request),
      runCommand: async () => ({ code: 0 }),
    },
  }), /exit 23.*no local replay/);
  assert.equal(dispatched, 1);
  assert.deepEqual(transfers, []);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  assert.deepEqual(request.selection.components, { server: true });
  assert.equal(request.files, undefined);
  assert.equal(request.captureDir, undefined);
  assert.equal(request.requestPath, undefined);
});

test('final artifacts import only on publication and private transfer staging is cleaned on success or download failure', async t => {
  for (const outcome of ['local', 'remote', 'download-failure', 'payload-failure']) await t.test(outcome, async t => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-final-transfer-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stackBaseDir = join(root, 'producer');
    const remoteDir = join(root, 'worker-final');
    await mkdir(stackBaseDir);
    const local = outcome === 'local';
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
      targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/worker' }],
      runtimePlacement: { build: { mode: local ? 'local' : 'prefer-target', targets: local ? [] : ['worker'] } },
    }));
    const requestPath = join(root, 'received-request.json');
    const target = { platform: process.platform, arch: process.arch };
    const transfers = [];
    let localArchive;
    const run = withAdmittedRuntimeBuildPlacement({ rootDir: root, stackBaseDir, target,
      selection: { components: { server: true } }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: root },
      run: async execution => {
        const result = await execution.buildComponents({ selection: { components: { server: true } } });
        await assert.rejects(stat(join(stackBaseDir, 'artifacts/server/server-code')), { code: 'ENOENT' });
        const artifacts = await result.publishArtifacts();
        assert.deepEqual(Object.keys(artifacts), ['server']);
        assert.equal(await readFile(join(artifacts.server.artifactDir, 'payload/happier-server'), 'utf8'), 'final server');
        return result.buildPlacement;
      },
      transport: {
        // Physical worker/emitter boundary. Real packing, closure validation,
        // import and final cleanup remain production owners.
        spawnController: (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { packRuntimeArtifactClosure } from ${JSON.stringify(new URL('../utils/dev_targets/runtime_artifact_transfer.mjs', import.meta.url).href)};
const input = createInterface({input:process.stdin});
console.log('HAPPIER_RUNTIME_BUILD_READY='+JSON.stringify({worker:${JSON.stringify(local ? 'local' : 'worker')},runtimeTarget:{platform:process.platform,arch:process.arch}}));
for await (const line of input) {
  const request = JSON.parse(line);
  await writeFile(${JSON.stringify(requestPath)}, line);
  const workspaceDir = request.outputDir ?? ${JSON.stringify(remoteDir)};
  const store = join(workspaceDir, 'store');
  const artifactDir = join(store, 'artifacts/server/server-code');
  await mkdir(join(artifactDir, 'payload'), {recursive:true});
  const manifest = {version:1,component:'server',artifactFingerprint:'server-code',sourceFingerprint:'source',payloadDir:'payload',entrypoint:'happier-server',target:request.target};
  await writeFile(join(artifactDir, 'payload/happier-server'), 'final server');
  await writeFile(join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  const result = {artifacts:{server:{artifactDir,manifest}}};
  if (request.archive) {
    await writeFile(join(store,'result.json'),JSON.stringify(result));
    await packRuntimeArtifactClosure({stackBaseDir:store,artifacts:result.artifacts,target:request.target,archivePath:join(workspaceDir,'artifacts.tar')});
  }
  console.log('HAPPIER_RUNTIME_BUILD_RESULT='+JSON.stringify({result,workspaceDir}));
  process.exit(${outcome === 'payload-failure' ? 75 : 0});
}
`], options),
        transfer: async transfer => {
          transfers.push(transfer.direction);
          localArchive = transfer.localPath;
          await cp(transfer.remotePath, transfer.localPath);
          if (outcome === 'download-failure') throw new Error('download ENOSPC');
        },
        runCommand: async ({ commandArgs }) => ({ code: spawnSync(process.execPath, commandArgs.slice(1)).status }),
      },
    });
    if (outcome === 'download-failure') await assert.rejects(run, /download ENOSPC/);
    else if (outcome === 'payload-failure') await assert.rejects(run, /exit 75.*no local replay/);
    else assert.deepEqual(await run, local ? { mode: 'local' } : { mode: 'target', target: 'worker', workspaceDir: '/mirror' });
    assert.deepEqual(transfers, local || outcome === 'payload-failure' ? [] : ['download']);
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    assert.deepEqual(request.selection.components, { server: true });
    await assert.rejects(stat(local ? request.outputDir : remoteDir), { code: 'ENOENT' });
    if (localArchive) await assert.rejects(stat(join(localArchive, '..')), { code: 'ENOENT' });
    await assert.rejects(stat(join(stackBaseDir, 'runtime/current.json')), { code: 'ENOENT' });
  });
});

test('runtime publication resolves explicit local placement and memory admission without a Git checkout', { skip: process.platform !== 'linux' }, async t => {
  for (const mode of ['local', 'prefer-target']) await t.test(mode, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-local-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepo(root);
  const stackBaseDir = join(root, 'stack');
  await mkdir(stackBaseDir);
  const config = { version: 3,
    targets: [{ name: 'remote-worker', platform: 'posix', ssh: 'not-a-local-worker', repoDir: '/mirror', cliHomeDir: '/remote' }],
    commandExecution: { mode: 'auto', targets: ['remote-worker'], fallback: 'local' },
    runtimePlacement: { build: { mode, ...(mode === 'prefer-target' ? { targets: ['remote-worker'] } : {}) } },
  };
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify(config));
  const fixture = await installNativeAdmissionFixture({ root });
  const fixtureRepo = join(root, 'native-owner');
  await symlink(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(fixtureRepo, 'node_modules'), 'dir');
  await mkdir(join(fixtureRepo, 'packages/cli-common'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)), join(fixtureRepo, 'packages/cli-common/registerSourceRuntime.mjs'));
  await writeFile(join(stackBaseDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot: fixtureRepo }));
  await symlink(fileURLToPath(new URL('../utils/dev_targets/native_runtime_control.mjs', import.meta.url)),
    join(fixtureRepo, 'apps/stack/scripts/utils/dev_targets/native_runtime_control.mjs'));
  const workerDir = join(fixtureRepo, 'apps/stack/scripts/build');
  await mkdir(workerDir, { recursive: true });
  const workerEntry = fileURLToPath(new URL('./remote_runtime_build.mjs', import.meta.url));
  await writeFile(join(workerDir, 'remote_runtime_build.mjs'),
    `process.argv[1] = ${JSON.stringify(workerEntry)}; await import(${JSON.stringify(new URL('./remote_runtime_build.mjs', import.meta.url).href)});\n`);
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  const probes = join(root, 'remote-probes');
  await writeFile(join(binDir, 'ssh'), '#!/bin/sh\nprintf "probe\\n" >> "$FIXTURE_PROBES"\nexit 255\n');
  await chmod(join(binDir, 'ssh'), 0o755);
  const memory = join(root, 'memory');
  await writeFile(memory, '15728640 31457280');
  await writeFile(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /bin/cat "$FIXTURE_MEMORY" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await chmod(join(binDir, 'awk'), 0o755);
  let waiting;
  const admissionWaiting = new Promise(resolve => { waiting = resolve; });
  let enteredFlight = false;
  let readinessOutput = '';
  const publication = withAdmittedRuntimeBuildPlacement({ rootDir: root, stackBaseDir,
    selection: { components: { server: true } }, target: { platform: process.platform, arch: process.arch },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_RUNTIME_BUILD_WORKER_NAME: 'remote-worker' },
    run: async () => { enteredFlight = true; return { admitted: true }; },
    transport: { spawnController: (_command, args, options) => {
      // Keep the real native queue, resource policy and admitted worker. Only
      // the physical worker's OS memory observation is isolated by the fixture.
      const child = spawn(fixture.launcher, args, { ...options, cwd: fixtureRepo,
        env: { ...options.env, PATH: binDir + ':' + process.env.PATH, FIXTURE_MEMORY: memory, FIXTURE_PROBES: probes,
          HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
          HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '' },
      });
      child.stdout.on('data', chunk => { readinessOutput += String(chunk); });
      child.stderr.on('data', chunk => { if (String(chunk).includes('waiting for heavyweight admission')) waiting(); });
      return child;
    } },
  });
  await Promise.race([admissionWaiting, publication.then(() => {
    assert.fail('local publication entered its publication before runtime admission');
  })]);
  assert.equal(enteredFlight, false);
  await writeFile(memory, '28311552 31457280');
  assert.deepEqual(await publication, { admitted: true });
  assert.equal(enteredFlight, true);
  const readinessLine = readinessOutput.split('\n').find(line => line.startsWith('HAPPIER_RUNTIME_BUILD_READY='));
  assert.equal(JSON.parse(readinessLine.slice('HAPPIER_RUNTIME_BUILD_READY='.length)).worker, 'local');
  if (mode === 'prefer-target') assert.match(await readFile(probes, 'utf8'), /probe/, 'canonical AUTO must probe the producer pool before its unavailable-only local fallback');
  else await assert.rejects(stat(probes), { code: 'ENOENT' }, 'explicit local authority must not probe the AUTO pool');
  });
});

test('explicit local runtime placement reuses its real admitted worker ancestor instead of queueing behind itself', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-nested-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await installNativeAdmissionFixture({ root });
  const repoDir = join(root, 'native-owner');
  await symlink(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(repoDir, 'node_modules'), 'dir');
  await mkdir(join(repoDir, 'packages/cli-common'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)), join(repoDir, 'packages/cli-common/registerSourceRuntime.mjs'));
  await symlink(fileURLToPath(new URL('../utils/dev_targets/native_runtime_control.mjs', import.meta.url)),
    join(repoDir, 'apps/stack/scripts/utils/dev_targets/native_runtime_control.mjs'));
  const stackBaseDir = join(root, 'stack');
  await mkdir(stackBaseDir);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [],
    runtimePlacement: { build: { mode: 'local' } },
  }));
  const workerDir = join(repoDir, 'apps/stack/scripts/build');
  await mkdir(workerDir, { recursive: true });
  const workerEntry = fileURLToPath(new URL('./remote_runtime_build.mjs', import.meta.url));
  await writeFile(join(workerDir, 'remote_runtime_build.mjs'),
    `process.argv[1] = ${JSON.stringify(workerEntry)}; await import(${JSON.stringify(new URL('./remote_runtime_build.mjs', import.meta.url).href)});\n`);
  const binDir = join(root, 'bin');
  await mkdir(binDir);
  const memory = join(root, 'memory');
  await writeFile(memory, '28311552 31457280');
  await writeFile(join(binDir, 'awk'), '#!/bin/sh\ncase "$*" in */proc/meminfo*) /bin/cat "$FIXTURE_MEMORY" ;; */proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;; *) exec /usr/bin/awk "$@" ;; esac\n');
  await chmod(join(binDir, 'awk'), 0o755);
  const parentEntry = join(root, 'parent.mjs');
  const imports = join(root, 'worker-imports');
  const importObserver = join(root, 'import-observer.mjs');
  await writeFile(importObserver, `
import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(join(root, 'import-loader.mjs')).href)}, import.meta.url);
`);
  await writeFile(join(root, 'import-loader.mjs'), `
import { appendFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
  if (url.includes('/packages/cli-common/dist/')) throw new Error('native worker consumed compiled workspace prerequisite: ' + url);
  if (url.includes('/packages/cli-common/src/')) appendFileSync(${JSON.stringify(imports)}, url + '\\n');
  return await nextLoad(url, context);
}
`);
  await writeFile(parentEntry, `
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { withAdmittedRuntimeBuildPlacement } from ${JSON.stringify(new URL('./remote_runtime_build.mjs', import.meta.url).href)};
await writeFile(${JSON.stringify(memory)}, '15728640 31457280');
const result = await withAdmittedRuntimeBuildPlacement({
  rootDir: ${JSON.stringify(repoDir)}, stackBaseDir: ${JSON.stringify(stackBaseDir)},
  selection: {components:{server:true}}, target: {platform:process.platform,arch:process.arch},
  transport: {spawnController: (command, args, options) => spawn(command, args.filter(arg => arg !== '--conditions=happier-source'), {...options, env: {...options.env, NODE_OPTIONS: '--import ' + ${JSON.stringify(pathToFileURL(importObserver).href)}}})},
  run: async execution => {
    // Exercise the real worker's build owner and source import closure without
    // manufacturing a compiler/native artifact workload in this admission test.
    const result = await execution.buildComponents({selection:{components:{}}});
    return {admitted:true, artifacts:await result.publishArtifacts(), commitSha:result.sourceMetadata.commitSha};
  },
});
console.log('INHERITED_ADMISSION=' + JSON.stringify(result));
`);
  // Isolate only the physical worker's memory/process-enumeration boundary.
  // The real shell admission creates/authenticates the ancestor envelope.
  const child = spawn(fixture.launcher, ['--heavyweight-admission', '--class=runtime-build', '--machine=placed-worker',
    '--', process.execPath, parentEntry], { cwd: repoDir, env: { ...process.env,
      PATH: binDir + ':' + process.env.PATH, FIXTURE_MEMORY: memory, HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_DEV_TARGET_EXECUTION: '1', HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
      HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: '', HAPPIER_HEAVYWEIGHT_ADMISSION_MACHINE: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const completion = new Promise(resolve => child.once('close', code => resolve(code)));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    // A fresh waiter is the deciding failure, not a test timeout. Stop only
    // this fixture's admitted ancestor; its native owner cancels descendants.
    if (stderr.includes('waiting for heavyweight admission')) child.kill('SIGTERM');
  });
  assert.equal(await completion, 0, stderr);
  assert.match(stdout, /INHERITED_ADMISSION={"admitted":true,"artifacts":{},"commitSha":"nogit"}/);
  assert.doesNotMatch(stderr, /waiting for heavyweight admission/);
  const observedImports = await readFile(imports, 'utf8');
  assert.match(observedImports, /\/src\/componentArtifacts\/index\.ts/);
  assert.match(observedImports, /\/src\/workspaces\/index\.ts/);
});

test('runtime placement waits for admitted READY before invoking publication and releases an unused worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackBaseDir = join(root, 'stack');
  await mkdir(stackBaseDir);
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/builds' }],
    runtimePlacement: { build: { mode: 'prefer-target', targets: ['worker'] } },
  }));
  const entry = join(root, 'controller.mjs');
  const gate = join(root, 'admit');
  const acknowledged = join(root, 'acknowledged');
  const consumerConfig = join(root, 'consumer-dev-targets.json');
  await writeFile(consumerConfig, JSON.stringify({ targets: [{ name: 'consumer-worker' }] }));
  await writeFile(entry, `
import { watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
await new Promise(resolve => {
  const watcher = watch(${JSON.stringify(root)}, async () => {
    if (await readFile(${JSON.stringify(gate)}).then(() => true, () => false)) { watcher.close(); resolve(); }
  });
  process.stderr.write('fixture admission waiting\\n');
});
const config = JSON.parse(await readFile(process.env.HAPPIER_EXEC_CONFIG_PATH, 'utf8'));
process.stdout.write('HAPPIER_RUNTIME_BUILD_READY='+JSON.stringify({worker:config.targets[0].name,runtimeTarget:{platform:process.platform,arch:process.arch}})+'\\n');
for await (const line of createInterface({input:process.stdin})) await writeFile(${JSON.stringify(acknowledged)}, line);
`);
  let waiting;
  const waitForWaiting = new Promise(resolve => { waiting = resolve; });
  let invoked = false;
  const publication = withAdmittedRuntimeBuildPlacement({ rootDir: root, stackBaseDir,
    selection: { components: { server: true } }, target: { platform: process.platform, arch: process.arch },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: root, HAPPIER_EXEC_CONFIG_PATH: consumerConfig },
    run: async () => { invoked = true; return { admitted: true }; },
    transport: { spawnController: (_command, _args, options) => {
      // This executable is the genuine controller/SSH boundary. Publication
      // and readiness orchestration remain the production implementation.
      const child = spawn(process.execPath, [entry], options);
      child.stderr.on('data', chunk => { if (String(chunk).includes('fixture admission waiting')) waiting(); });
      return child;
    } },
  });
  await Promise.race([waitForWaiting, publication.then(() => {
    throw new Error('publication completed before the controller admission wait');
  })]);
  assert.equal(invoked, false, 'publication cannot acquire its target lock while admission waits');
  await assert.rejects(stat(acknowledged), { code: 'ENOENT' });
  await writeFile(gate, 'ready');
  assert.deepEqual(await publication, { admitted: true });
  assert.equal(invoked, true);
  await assert.rejects(stat(acknowledged), { code: 'ENOENT' }, 'releasing an unused admission must not start compilation');

  // A waiting server request can acquire a daemon demand after admission.
  // Revalidate the requested component contract before acknowledging the worker.
  await rm(gate);
  const waitForMergedWaiting = new Promise(resolve => { waiting = resolve; });
  const merged = withAdmittedRuntimeBuildPlacement({ rootDir: root, stackBaseDir,
    selection: { components: { server: true } },
    target: { platform: process.platform === 'darwin' ? 'linux' : 'darwin', arch: process.arch },
    env: { ...process.env, HAPPIER_STACK_REPO_DIR: root },
    run: execution => execution.buildComponents({ selection: { components: { server: true, daemon: true } } }),
    transport: { spawnController: (_command, _args, options) => {
      const child = spawn(process.execPath, [entry], options);
      child.stderr.on('data', chunk => { if (String(chunk).includes('fixture admission waiting')) waiting(); });
      return child;
    } },
  });
  const rejected = assert.rejects(merged, /daemon.*matching host target/);
  await waitForMergedWaiting;
  await writeFile(gate, 'ready');
  await rejected;
  await assert.rejects(stat(acknowledged), { code: 'ENOENT' }, 'incompatible component request cannot start compilation');
});
