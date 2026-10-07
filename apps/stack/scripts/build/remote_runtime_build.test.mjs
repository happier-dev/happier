import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeArtifactComponentsAtPlacement, withAdmittedRuntimeBuildPlacement, extractCapturedBuildSource, assertCapturedRuntimeInputs } from './remote_runtime_build.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs';
import { collectRuntimeComponentSourceFingerprints } from './runtime_artifact_identity.mjs';
import childProcess from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { captureBuildInputFiles } from '../../../../scripts/workspaces/buildInputConvergence.mjs';
import fsPromises from 'node:fs/promises';
import { installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { renderNativeExecutionProjection } from '../utils/dev_targets/native_execution_projection.mjs';

test('runtime publication resolves producer placement and admission before its target flight despite inherited execution markers', { skip: process.platform !== 'linux' }, async t => {
  for (const mode of ['local', 'prefer-target']) await t.test(mode, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-local-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await writeFile(join(stackBaseDir, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot: fixtureRepo }));
  await symlink(fileURLToPath(new URL('../utils/dev_targets/native_runtime_control.mjs', import.meta.url)),
    join(fixtureRepo, 'apps/stack/scripts/utils/dev_targets/native_runtime_control.mjs'));
  await symlink(fileURLToPath(new URL('../utils/dev_targets/native_sync_readiness.sh', import.meta.url)),
    join(fixtureRepo, 'apps/stack/scripts/utils/dev_targets/native_sync_readiness.sh'));
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
    run: async () => { enteredFlight = true; return { publicationFlight: 'joined' }; },
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
    assert.fail('local publication entered its target flight before runtime admission');
  })]);
  assert.equal(enteredFlight, false);
  await writeFile(memory, '28311552 31457280');
  assert.deepEqual(await publication, { publicationFlight: 'joined' });
  assert.equal(enteredFlight, true);
  const readinessLine = readinessOutput.split('\n').find(line => line.startsWith('HAPPIER_RUNTIME_BUILD_READY='));
  assert.equal(JSON.parse(readinessLine.slice('HAPPIER_RUNTIME_BUILD_READY='.length)).worker, 'local');
  if (mode === 'prefer-target') assert.match(await readFile(probes, 'utf8'), /probe/, 'canonical AUTO must probe the producer pool before its unavailable-only local fallback');
  else await assert.rejects(stat(probes), { code: 'ENOENT' }, 'explicit local authority must not probe the AUTO pool');
  });
});

test('source capture rereads only changed members once and admits continuing edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-selective-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const captureDir = join(root, 'capture');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'a.ts'), 'initial');
  await writeFile(join(sourceDir, 'z.ts'), 'unchanged');
  const counts = new Map();
  const realCopy = fsPromises.cp;
  const copy = t.mock.method(fsPromises, 'cp', async (source, target, options) => {
    await realCopy(source, target, options);
    const name = basename(source);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === 'a.ts') await writeFile(source, counts.get(name) === 1 ? 'trailing' : 'after trailing');
  });
  syncBuiltinESMExports();
  t.after(() => { copy.mock.restore(); syncBuiltinESMExports(); });
  const captured = await captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => ['a.ts', 'z.ts'] });
  assert.deepEqual(captured.rereadPaths, ['a.ts']);
  assert.equal(counts.get('a.ts'), 2);
  assert.equal(counts.get('z.ts'), 1);
  assert.equal(await readFile(join(captureDir, 'a.ts'), 'utf8'), 'trailing');
  assert.equal(await readFile(join(sourceDir, 'a.ts'), 'utf8'), 'after trailing');
});

test('source capture preserves captured fingerprints after later producer edits and fails archive errors immediately', async (t) => {
  for (const mode of ['consumed-edited-twice', 'archive-failure']) {
    await t.test(mode, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'runtime-capture-drift-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const repoDir = join(root, 'repo');
      const stackBaseDir = join(root, 'stack');
      await mkdir(join(repoDir, 'apps/server/sources'), { recursive: true });
      await mkdir(stackBaseDir);
      await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
      await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name: '@happier-dev/server' }));
      await writeFile(join(repoDir, 'apps/server/sources/index.ts'), 'server source');
      // Git captures these too, even though the selected server fingerprint
      // does not consume them (the original incident removed UI sources).
      await mkdir(join(repoDir, 'notes'));
      const removed = 'notes/vanished.txt';
      const retained = 'notes/retained.txt';
      await writeFile(join(repoDir, removed), 'vanished source');
      await writeFile(join(repoDir, retained), 'retained source');
      await symlink('absent-target', join(repoDir, 'notes/dangling-link'));
      execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
      const target = { name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/worker' };
      await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [target],
        runtimePlacement: { build: { mode: 'prefer-target', targets: ['worker'] } } }));
      let captures = 0;
      let uploaded = false;
      // Intercept only the OS archive process. Fingerprinting, inventory and
      // convergence stay real, and tar itself observes the captured tree.
      const realSpawn = childProcess.spawn;
      const archiveSpawn = t.mock.method(childProcess, 'spawn', (command, args, options) => {
        if (command === 'tar' && args.includes('-T')) {
          captures++;
          if (mode.startsWith('consumed-edited')) {
            writeFileSync(join(repoDir, 'apps/server/sources/index.ts'), 'changed consumed source pass ' + captures);
          } else if (mode === 'archive-failure') {
            args = [...args];
            args[1] = join(root, 'missing-parent/source.tar');
          }
        }
        return realSpawn(command, args, options);
      });
      syncBuiltinESMExports();
      t.after(() => { archiveSpawn.mock.restore(); syncBuiltinESMExports(); });
      const options = {
        rootDir: join(repoDir, 'apps/stack'), stackBaseDir, selection: { components: { server: true } },
        env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
        transport: {
          // Real child process standing in for worker admission, with no build.
          spawnController: () => realSpawn(process.execPath, ['-e',
            'console.log("HAPPIER_RUNTIME_BUILD_READY=" + JSON.stringify({worker:"worker",runtimeTarget:{platform:process.platform,arch:process.arch}})); process.stdin.once("data",()=>process.exit(23)); process.stdin.once("end",()=>process.exit(0));',
          ], { stdio: ['pipe', 'pipe', 'pipe'] }),
          runCommand: async () => ({ code: 0 }),
          transfer: async ({ localPath, remotePath }) => {
            if (remotePath.endsWith('source.tar')) {
              uploaded = true;
              const extracted = join(root, 'extracted');
              await mkdir(extracted);
              execFileSync('tar', ['-xf', localPath, '-C', extracted]);
              assert.equal(await readFile(join(extracted, retained), 'utf8'), 'retained source');
              assert.equal(await readFile(join(extracted, removed), 'utf8'), 'vanished source');
              assert.equal(await readFile(join(extracted, 'apps/server/sources/index.ts'), 'utf8'), 'server source', 'edits after capture cannot alter the captured bytes');
            } else {
              const request = JSON.parse(await readFile(localPath, 'utf8'));
              assert.ok(request.files.includes(removed));
              const fingerprints = await collectRuntimeComponentSourceFingerprints({ selection: request.selection,
                sourceMetadata: { ...request.sourceMetadata, repoDir: join(root, 'extracted') }, identityRepoDir: repoDir,
                includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true });
              assert.deepEqual(fingerprints, request.expectedInputs);
            }
          },
        },
      };
      if (mode.startsWith('consumed-edited')) {
        await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), /exit 23.*no local replay/);
        assert.equal(uploaded, true, 'post-capture edits must reach transfer with the captured fingerprint');
        assert.equal(captures, 1, 'post-capture edits never restart capture');
      } else {
        await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), error =>
          /runtime archive operation failed/.test(error.message));
        assert.equal(uploaded, false);
        assert.equal(captures, 1, 'archive failure without missing inputs is not retried');
      }
    });
  }
});

test('source capture retires removed children when a consumed directory becomes a file during the pass', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capture-membership-change-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const captureDir = join(root, 'capture');
  await mkdir(join(sourceDir, 'member'), { recursive: true });
  await writeFile(join(sourceDir, 'member/child'), 'initial');
  let replaced = false;
  const realCopy = fsPromises.cp;
  const copy = t.mock.method(fsPromises, 'cp', async (source, target, options) => {
    await realCopy(source, target, options);
    if (!replaced && source === join(sourceDir, 'member/child')) {
      replaced = true;
      await rm(join(sourceDir, 'member'), { recursive: true });
      await writeFile(join(sourceDir, 'member'), 'replacement');
    }
  });
  syncBuiltinESMExports();
  t.after(() => { copy.mock.restore(); syncBuiltinESMExports(); });
  let inventories = 0;
  const captured = await captureBuildInputFiles({ sourceDir, captureDir,
    readPaths: () => ++inventories === 1 ? ['member', 'member/child'] : ['member'] });
  assert.deepEqual(captured.files, ['member']);
  assert.equal(await readFile(join(captureDir, 'member'), 'utf8'), 'replacement');
  assert.equal(inventories, 2, 'membership gets one initial inventory and one trailing inventory');
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
    run: async () => { invoked = true; return { publicationFlight: 'joined' }; },
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
  assert.deepEqual(await publication, { publicationFlight: 'joined' });
  assert.equal(invoked, true);
  await assert.rejects(stat(acknowledged), { code: 'ENOENT' }, 'joining a completed flight must not start compilation');

  // A waiting server request can acquire a daemon demand after admission.
  // Revalidate the merged component contract before acknowledging the worker.
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
  await assert.rejects(stat(acknowledged), { code: 'ENOENT' }, 'incompatible merged demand cannot start compilation');
});

test('reused captured workspace reconciles authored sources while preserving generated plugin artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-membership-'));
  try {
    const source = join(root, 'source');
    const workspaceDir = join(root, 'worker');
    const repo = join(workspaceDir, 'repo');
    const chunks = 'packages/example/.happier-plugin/.happier-chunks';
    for (const dir of [source, repo]) {
      await mkdir(join(dir, chunks), { recursive: true });
      await mkdir(join(dir, 'apps/cli/src'), { recursive: true });
      await writeFile(join(dir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', bundledDependencies: ['@happier-dev/example'], dependencies: { '@happier-dev/example': '0.0.0' } }));
      await writeFile(join(dir, 'packages/example/package.json'), JSON.stringify({ name: '@happier-dev/example', files: ['.happier-plugin'] }));
      await writeFile(join(dir, chunks, 'current.js'), 'current');
    }
    await writeFile(join(repo, chunks, 'previous-worker-build.js'), 'obsolete');
    await writeFile(join(repo, chunks, 'current.js'), 'worker generated bytes');
    await writeFile(join(repo, 'apps/cli/src/obsolete.ts'), 'obsolete source');
    const hosted = 'packages/example/.happier-plugin/ui/hosted-web';
    for (const dir of [source, repo]) {
      await mkdir(join(dir, hosted), { recursive: true });
      await writeFile(join(dir, hosted, 'index.html'), 'authored web');
    }
    await writeFile(join(repo, hosted, 'obsolete.html'), 'obsolete authored web');
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'node_modules/keep'), 'installed dependencies');
    const files = ['apps/cli/src', 'apps/cli/package.json', 'packages/example/package.json', hosted, `${hosted}/index.html`];
    // Upgrade a workspace whose previous inventory still captured generated output.
    await writeFile(join(workspaceDir, 'source-files.json'), JSON.stringify([...files, 'packages/example/.happier-plugin', chunks, `${chunks}/current.js`]));
    execFileSync('tar', ['-cf', join(workspaceDir, 'source.tar'), '--no-recursion', '-C', source, ...files]);
    await extractCapturedBuildSource({ workspaceDir, files });
    await assert.rejects(stat(join(workspaceDir, 'source.tar')), { code: 'ENOENT' });
    const selection = { components: { daemon: true } };
    const options = { selection, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true };
    const expected = await collectRuntimeComponentSourceFingerprints({ ...options, sourceMetadata: { repoDir: source } });
    assert.deepEqual(await collectRuntimeComponentSourceFingerprints({ ...options, sourceMetadata: { repoDir: repo }, identityRepoDir: source }), expected);
    assert.notDeepEqual(await collectRuntimeComponentSourceFingerprints({ ...options, excludeGeneratedPluginArtifacts: false, sourceMetadata: { repoDir: repo }, identityRepoDir: source }),
      await collectRuntimeComponentSourceFingerprints({ ...options, excludeGeneratedPluginArtifacts: false, sourceMetadata: { repoDir: source } }),
      'full shipped integrity continues observing differing generated output bytes');
    assert.equal(await readFile(join(repo, chunks, 'current.js'), 'utf8'), 'worker generated bytes');
    assert.equal(await readFile(join(repo, chunks, 'previous-worker-build.js'), 'utf8'), 'obsolete');
    await assert.rejects(stat(join(repo, 'apps/cli/src/obsolete.ts')), { code: 'ENOENT' });
    await assert.rejects(stat(join(repo, hosted, 'obsolete.html')), { code: 'ENOENT' });
    assert.equal(await readFile(join(repo, 'node_modules/keep'), 'utf8'), 'installed dependencies');
    // Output-only parent membership must also stay invisible without hosted inputs.
    await rm(join(source, 'packages/example/.happier-plugin'), { recursive: true });
    await rm(join(repo, hosted), { recursive: true });
    assert.deepEqual(await collectRuntimeComponentSourceFingerprints({ ...options, sourceMetadata: { repoDir: repo }, identityRepoDir: source }),
      await collectRuntimeComponentSourceFingerprints({ ...options, sourceMetadata: { repoDir: source } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed source extraction releases the transport archive without removing the retained workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-extraction-cleanup-'));
  try {
    await mkdir(join(root, 'repo'), { recursive: true });
    await writeFile(join(root, 'repo/retained-output'), 'keep');
    await writeFile(join(root, 'source.tar'), 'incomplete archive');
    await assert.rejects(extractCapturedBuildSource({ workspaceDir: root, files: [] }), /source extraction failed/);
    await assert.rejects(stat(join(root, 'source.tar')), { code: 'ENOENT' });
    assert.equal(await readFile(join(root, 'repo/retained-output'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture rejection identifies changed input keys through the real fingerprint owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-diagnostics-'));
  try {
    await mkdir(join(root, 'apps/cli/src'), { recursive: true });
    await writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli' }));
    const file = join(root, 'apps/cli/src/index.ts');
    await writeFile(file, 'before');
    const expectedInputEntries = {};
    const options = { selection: { components: { daemon: true } }, sourceMetadata: { repoDir: root }, includeRuntimeSupportInputs: true };
    const expectedInputs = await collectRuntimeComponentSourceFingerprints({ ...options, inputEntries: expectedInputEntries });
    await writeFile(file, 'after');
    const extractedInputEntries = {};
    const extractedInputs = await collectRuntimeComponentSourceFingerprints({ ...options, inputEntries: extractedInputEntries });
    assert.throws(() => assertCapturedRuntimeInputs({ expectedInputs, extractedInputs, expectedInputEntries, extractedInputEntries }), /daemon:apps\/cli\/src\/index\.ts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('worker entry admits a foreign server target through the same support policy and rejects a foreign daemon', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-worker-target-'));
  try {
    const requestPath = join(root, 'request.json');
    const request = {
      target: { platform: process.platform === 'darwin' ? 'linux' : 'darwin', arch: 'arm64' },
      selection: { components: { server: true } },
      workspaceDir: join(root, 'worker'),
      files: [],
    };
    await writeFile(requestPath, JSON.stringify(request));
    const entry = fileURLToPath(new URL('./remote_runtime_build.mjs', import.meta.url));
    // Execute the real worker entry. Missing transport data is the boundary
    // failure after admission; no captured builders or internal policy are mocked.
    const server = spawnSync(process.execPath, [entry, `--worker-request=${requestPath}`], { encoding: 'utf8' });
    assert.equal(server.status, 1);
    assert.match(server.stderr, /worker source extraction failed/);
    assert.doesNotMatch(server.stderr, /matching host target/);
    await writeFile(requestPath, JSON.stringify({ ...request, selection: { components: { server: true, daemon: true } } }));
    const daemon = spawnSync(process.execPath, [entry, `--worker-request=${requestPath}`], { encoding: 'utf8' });
    assert.equal(daemon.status, 1);
    assert.match(daemon.stderr, /daemon.*matching host target/);
    assert.doesNotMatch(daemon.stderr, /worker source extraction failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('admitted source transfer stays independent of later producer edits and a dispatched failure is never replayed locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-source-'));
  try {
    const repoDir = join(root, 'repo');
    const stackBaseDir = join(root, 'producer');
    await mkdir(join(repoDir, 'apps/server/sources'), { recursive: true });
    await mkdir(stackBaseDir);
    for (const name of ['cli', 'ui', 'server']) {
      await mkdir(join(repoDir, 'apps', name), { recursive: true });
      await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}` }));
    }
    await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
    await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name: '@happier-dev/server', dependencies: { '@happier-dev/example': '0.0.0' } }));
    await mkdir(join(repoDir, 'packages/example'), { recursive: true });
    await writeFile(join(repoDir, 'packages/example/package.json'), JSON.stringify({ name: '@happier-dev/example', files: ['native'] }));
    await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', dependencies: { '@happier-dev/example': '0.0.0' }, bundledDependencies: ['@happier-dev/example'] }));
    await mkdir(join(repoDir, 'packages/example/native/empty'), { recursive: true });
    await writeFile(join(repoDir, 'packages/example/native/addon.node'), Buffer.from([0, 255, 10, 128]));
    await symlink('addon.node', join(repoDir, 'packages/example/native/current.node'));
    const plugin = 'packages/example/.happier-plugin';
    await mkdir(join(repoDir, plugin, '.happier-chunks'), { recursive: true });
    await mkdir(join(repoDir, plugin, 'ui/hosted-web'), { recursive: true });
    await writeFile(join(repoDir, plugin, 'plugin.json'), '{"generated":true}');
    await writeFile(join(repoDir, plugin, '.happier-chunks/current.js'), 'producer generated chunk');
    await writeFile(join(repoDir, plugin, 'ui/hosted-web/index.html'), 'authored hosted web');
    const fixture = 'apps/server/testkit/fixtures/.happier-plugin/plugin.json';
    await mkdir(join(repoDir, 'apps/server/testkit/fixtures/.happier-plugin'), { recursive: true });
    await writeFile(join(repoDir, fixture), '{"authoredFixture":true}');
    await writeFile(join(repoDir, 'packages/example/tsconfig.json'), JSON.stringify({ extends: './tsconfig.tests.json' }));
    await writeFile(join(repoDir, 'packages/example/tsconfig.tests.json'), JSON.stringify({ compilerOptions: { strict: true } }));
    const input = join(repoDir, 'apps/server/sources/index.ts');
    await writeFile(input, 'captured input');
    await writeFile(join(repoDir, '.gitignore'), 'apps/server/sources/generated.ts\npackages/example/tsconfig.tests.json\npackages/example/native/\n');
    await writeFile(join(repoDir, 'apps/server/sources/generated.ts'), 'consumed generated input');
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    const target = { name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/worker' };
    const offline = { ...target, name: 'offline', ssh: 'offline' };
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [offline, target], runtimePlacement: { build: { mode: 'prefer-target', targets: ['offline', 'worker'] } } }));
    const archive = join(root, 'source.tar');
    let request;
    let producerArchive;
    let outcome = 'build-failure';
    const remoteWorkspace = join(root, 'remote');
    await mkdir(remoteWorkspace);
    const requestedTarget = { platform: process.platform, arch: process.arch === 'x64' ? 'arm64' : 'x64' };
    const controllerEntry = join(root, 'controller.mjs');
    const archivePointer = join(root, 'producer-archive-path');
    await writeFile(controllerEntry, `
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
process.stdout.write('HAPPIER_RUNTIME_BUILD_READY='+JSON.stringify({worker:'worker',runtimeTarget:{platform:process.platform,arch:process.arch}})+'\\n');
for await (const line of createInterface({input:process.stdin})) {
  const acknowledgment = JSON.parse(line);
  assert.ok(acknowledgment.requestPath.endsWith('/request.json'));
  const producerArchive = await readFile(${JSON.stringify(archivePointer)}, 'utf8');
  await assert.rejects(stat(producerArchive), {code:'ENOENT'}, 'producer archive remains live after ACK');
  await writeFile(join(${JSON.stringify(remoteWorkspace)}, 'result.json'), JSON.stringify({artifacts:{}}));
  const archived = spawnSync('tar', ['-cf', join(${JSON.stringify(remoteWorkspace)}, 'artifacts.tar'), '-C', ${JSON.stringify(remoteWorkspace)}, 'result.json']);
  assert.equal(archived.status, 0);
  await writeFile(${JSON.stringify(input)}, 'newer producer input');
  process.exit(['build-failure','cleanup-failure'].includes(process.env.FIXTURE_OUTCOME) ? 23 : process.env.FIXTURE_OUTCOME === 'payload-75' ? 75 : 0);
}
`);
    const options = { rootDir: join(repoDir, 'apps/stack'), stackBaseDir, target: requestedTarget, selection: { components: { server: true } }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
      transport: {
        spawnController: (_command, _args, spawnOptions) => spawn(process.execPath, [controllerEntry], {
          ...spawnOptions, env: { ...spawnOptions.env, FIXTURE_OUTCOME: outcome },
        }),
        transfer: async ({ direction, localPath, remotePath }) => {
          if (direction === 'download') {
            await writeFile(localPath, await readFile(join(remoteWorkspace, 'artifacts.tar')));
            if (outcome === 'download-failure') throw new Error('download ENOSPC');
          } else if (remotePath.endsWith('source.tar')) {
            producerArchive = localPath;
            await writeFile(archivePointer, producerArchive);
            await writeFile(archive, await readFile(localPath));
            await writeFile(join(remoteWorkspace, 'source.tar'), await readFile(localPath));
            if (outcome === 'upload-failure') throw new Error('upload disconnected');
          } else {
            request = JSON.parse(await readFile(localPath, 'utf8'));
            await writeFile(join(remoteWorkspace, 'request.json'), JSON.stringify(request));
          }
        },
        runCommand: async ({ commandArgs, target: dispatchedTarget }) => {
          assert.equal(dispatchedTarget.name, 'worker');
          // Execute the actual OS cleanup command at the network boundary.
          if (commandArgs[2]?.includes('rmSync')) {
            if (outcome === 'cleanup-failure') return { code: 17 };
            const args = commandArgs.map(arg => arg.startsWith(request.workspaceDir + '/')
              ? join(remoteWorkspace, arg.slice(request.workspaceDir.length + 1)) : arg);
            return { code: spawnSync(process.execPath, args.slice(1)).status };
          }
          return { code: 0 };
        },
      },
    };
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), /exit 23.*no local replay/);
    for (const name of ['source.tar', 'artifacts.tar']) await assert.rejects(stat(join(remoteWorkspace, name)), { code: 'ENOENT' });
    await assert.rejects(stat(producerArchive), { code: 'ENOENT' });
    assert.equal(await readFile(input, 'utf8'), 'newer producer input');
    const captured = join(root, 'captured');
    await mkdir(captured);
    execFileSync('tar', ['-xf', archive, '-C', captured]);
    assert.equal(await readFile(join(captured, fixture), 'utf8'), '{"authoredFixture":true}');
    await assert.rejects(stat(join(captured, plugin, 'plugin.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(captured, plugin, '.happier-chunks/current.js')), { code: 'ENOENT' });
    assert.equal(await readFile(join(captured, plugin, 'ui/hosted-web/index.html'), 'utf8'), 'authored hosted web');
    assert.ok(!request.files.includes(plugin));
    assert.ok(!request.files.includes(`${plugin}/ui`));
    assert.equal(await readFile(join(captured, 'apps/server/sources/index.ts'), 'utf8'), 'captured input');
    assert.equal(await readFile(join(captured, 'apps/server/sources/generated.ts'), 'utf8'), 'consumed generated input');
    assert.deepEqual(JSON.parse(await readFile(join(captured, 'packages/example/tsconfig.tests.json'), 'utf8')), { compilerOptions: { strict: true } });
    assert.deepEqual(await readFile(join(captured, 'packages/example/native/addon.node')), Buffer.from([0, 255, 10, 128]));
    assert.equal((await stat(join(captured, 'packages/example/native/empty'))).isDirectory(), true);
    assert.deepEqual(await collectRuntimeComponentSourceFingerprints({
      selection: options.selection,
      sourceMetadata: { ...request.sourceMetadata, repoDir: captured },
      identityRepoDir: repoDir,
      includeRuntimeSupportInputs: true,
      excludeGeneratedPluginArtifacts: true,
    }), request.expectedInputs);
    await mkdir(join(captured, plugin, '.happier-chunks'), { recursive: true });
    await writeFile(join(captured, plugin, '.happier-chunks/worker.js'), 'different worker generated bytes');
    const fingerprint = () => collectRuntimeComponentSourceFingerprints({ selection: options.selection,
      sourceMetadata: { ...request.sourceMetadata, repoDir: captured }, identityRepoDir: repoDir,
      includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true });
    assert.deepEqual(await fingerprint(), request.expectedInputs);
    await writeFile(join(captured, plugin, 'ui/hosted-web/index.html'), 'changed authored hosted web');
    assert.notDeepEqual(await fingerprint(), request.expectedInputs);
    await writeFile(join(captured, plugin, 'ui/hosted-web/index.html'), 'authored hosted web');
    await writeFile(join(captured, 'packages/example/native/addon.node'), Buffer.from([1, 255, 10, 128]));
    assert.notDeepEqual(await fingerprint(), request.expectedInputs);
    await writeFile(join(captured, 'packages/example/native/addon.node'), Buffer.from([0, 255, 10, 128]));
    await rm(join(captured, 'packages/example/native/current.node'));
    await symlink('other.node', join(captured, 'packages/example/native/current.node'));
    assert.notDeepEqual(await collectRuntimeComponentSourceFingerprints({
      selection: options.selection,
      sourceMetadata: { ...request.sourceMetadata, repoDir: captured },
      identityRepoDir: repoDir,
      includeRuntimeSupportInputs: true,
      excludeGeneratedPluginArtifacts: true,
    }), request.expectedInputs);
    assert.ok(request.expectedInputs.server);
    assert.equal(request.env[WORKSPACE_BUILD_MODE_ENV], 'qa-runtime');
    assert.deepEqual(request.target, requestedTarget);
    assert.notEqual(request.workspaceDir + '/repo', target.repoDir);
    outcome = 'download-failure';
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), /download ENOSPC/);
    for (const name of ['source.tar', 'artifacts.tar']) await assert.rejects(stat(join(remoteWorkspace, name)), { code: 'ENOENT' });
    await assert.rejects(stat(join(producerArchive, '..')), { code: 'ENOENT' });
    outcome = 'cleanup-failure';
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options), /exit 23.*no local replay/);
    await assert.rejects(stat(join(producerArchive, '..')), { code: 'ENOENT' });
    outcome = 'upload-failure';
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement({ ...options, selection: { components: {} } }), /upload disconnected/);
    await assert.rejects(stat(join(remoteWorkspace, 'source.tar')), { code: 'ENOENT' });
    await assert.rejects(stat(join(producerArchive, '..')), { code: 'ENOENT' });
    outcome = 'success';
    const result = await buildRuntimeArtifactComponentsAtPlacement(options);
    assert.deepEqual(result.artifacts, {});
    const originalWorkspace = request.workspaceDir;
    await buildRuntimeArtifactComponentsAtPlacement({ ...options,
      target: { platform: requestedTarget.platform === 'darwin' ? 'linux' : 'darwin', arch: 'arm64' },
    });
    assert.notEqual(request.workspaceDir, originalWorkspace,
      'different target flights must not replace the same worker request, captured checkout, or artifact store');
    await buildRuntimeArtifactComponentsAtPlacement(options);
    assert.equal(request.workspaceDir, originalWorkspace, 'the same target reuses its incremental workspace');
    for (const name of ['source.tar', 'artifacts.tar']) await assert.rejects(stat(join(remoteWorkspace, name)), { code: 'ENOENT' });
    await assert.rejects(stat(join(producerArchive, '..')), { code: 'ENOENT' });
    outcome = 'payload-75';
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement({ ...options, selection: { components: {} } }), /exit 75.*no local replay/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local runtime source capture keeps post-capture producer edits out of the dispatched build', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-local-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stackBaseDir = join(root, 'stack');
  const repoDir = join(root, 'repo');
  await mkdir(stackBaseDir);
  await mkdir(join(repoDir, 'apps/server/sources'), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await writeFile(join(repoDir, 'apps/server/package.json'), JSON.stringify({ name: '@fixture/server' }));
  const input = join(repoDir, 'apps/server/sources/index.ts');
  await writeFile(input, 'captured');
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3, targets: [], runtimePlacement: { build: { mode: 'local' } } }));
  const observation = join(root, 'observation.json');
  await assert.rejects(buildRuntimeArtifactComponentsAtPlacement({ rootDir: join(repoDir, 'apps/stack'), stackBaseDir,
    selection: { components: { server: true } }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: repoDir },
    transport: { spawnController: () => spawn(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      console.log('HAPPIER_RUNTIME_BUILD_READY=' + JSON.stringify({ worker:'local', runtimeTarget:{platform:process.platform,arch:process.arch} }));
      process.stdin.once('data', line => {
        const request = JSON.parse(readFileSync(JSON.parse(String(line)).requestPath, 'utf8'));
        const source = join(request.localBuild.rootDir, '../../apps/server/sources/index.ts');
        const before = readFileSync(source, 'utf8');
        writeFileSync(${JSON.stringify(input)}, 'after capture');
        writeFileSync(${JSON.stringify(observation)}, JSON.stringify({before, after:readFileSync(source,'utf8'),rootDir:request.localBuild.rootDir}));
        process.exit(23);
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] }) },
  }), /exit 23.*no local replay/);
  const observed = JSON.parse(await readFile(observation, 'utf8'));
  assert.equal(observed.before, 'captured');
  assert.equal(observed.after, 'captured');
  assert.notEqual(observed.rootDir, join(repoDir, 'apps/stack'));
});

test('explicit local placement releases admission when source inventory fails without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-build-fallback-'));
  try {
    const stackBaseDir = join(root, 'stack');
    await mkdir(stackBaseDir);
    await writeFile(join(stackBaseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
      targets: [{ name: 'worker', platform: 'posix', ssh: 'worker', repoDir: '/mirror', cliHomeDir: '/builds' }],
      runtimePlacement: { build: { mode: 'local' } },
    }));
    const options = { rootDir: root, stackBaseDir, selection: { components: {} }, env: { ...process.env, HAPPIER_STACK_REPO_DIR: root },
      transport: { spawnController: (_command, args, options) => {
        assert.ok(args.includes('--local'), 'explicit local placement cannot enter the remote command pool');
        const entry = fileURLToPath(new URL('./remote_runtime_build.mjs', import.meta.url));
        return spawn(process.execPath, [entry, '--worker-request=stdin', `--artifact-target=${process.platform}-${process.arch}`], {
          ...options, env: { ...options.env, HAPPIER_RUNTIME_BUILD_WORKER_NAME: 'local' },
        });
      } },
    };
    // An invalid producer repository fails before dispatch, and the real
    // admitted worker exits when its unused control stream closes.
    await assert.rejects(buildRuntimeArtifactComponentsAtPlacement(options),
      error => error.code === 'EEXIT' && error.exitCode === 128);
  } finally { await rm(root, { recursive: true, force: true }); }
});
