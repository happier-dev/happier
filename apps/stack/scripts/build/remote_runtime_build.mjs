import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCliBinaryArtifactSupportTargetUnavailableReason, getComponentArtifactBuildTargetUnavailableReason } from '../../../../packages/cli-common/componentArtifactTarget.mjs';
import { WORKSPACE_BUILD_MODE_ENV } from '../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { writeRuntimeAdmissionPhase } from '../utils/proc/service_memory.mjs';

const WORKER_ENTRY = 'apps/stack/scripts/build/remote_runtime_build.mjs';
const BUILD_ENV_KEYS = ['HAPPIER_CLI_BUN_EXTERNALS', 'HAPPIER_SERVER_BUN_EXTERNALS', 'HAPPIER_BUILD_DB_PROVIDERS', 'HAPPY_BUILD_DB_PROVIDERS', 'HAPPIER_SERVER_REQUIRE_IROH_NATIVE', 'HAPPIER_STACK_EXPO_CLEAR_CACHE'];

/** Native AUTO owns mirror synchronization, worker capability and admission. */
export async function withAdmittedRuntimeBuildPlacement({
  rootDir, stackBaseDir, selection, target = { platform: process.platform, arch: process.arch },
  env = process.env, run, transport = {},
}) {
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json'), env });
  const forceLocal = config.runtimePlacement?.build?.mode !== 'prefer-target';
  const { getRepoDir } = await import('../utils/paths/paths.mjs');
  const repoDir = getRepoDir(rootDir, env);
  const spawnController = transport.spawnController ?? (await import('node:child_process')).spawn;
  const child = spawnController(join(repoDir, 'apps/stack/bin/hstack-exec'), [
    '--runtime-build-target=' + target.platform + '-' + target.arch,
    '--runtime-build-components=' + Object.keys(selection.components).filter(key => selection.components[key] === true).join(','),
    '--control-stdin', ...(forceLocal ? ['--local', '--allow-local-compilation'] : []),
    '--', 'node', '--conditions=happier-source', '--import', './packages/cli-common/registerSourceRuntime.mjs', WORKER_ENTRY, '--worker-request=stdin', '--artifact-target=' + target.platform + '-' + target.arch,
  ], { cwd: repoDir, env: { ...env, HAPPIER_EXEC_CONFIG_PATH: join(stackBaseDir, 'dev-targets.json'),
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_RUNTIME_BUILD_WORKER_NAME: forceLocal ? 'local' : '',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // Cancellation may close the control channel first.
  let ready;
  let rejectReady;
  const readiness = new Promise((resolveReady, reject) => { ready = resolveReady; rejectReady = reject; });
  const completion = new Promise((resolveCompletion, reject) => {
    child.once('error', error => { rejectReady(error); reject(error); });
    child.once('close', (code, signal) => {
      rejectReady(new Error('[build] runtime worker exited before admission (exit ' + code + ', signal ' + signal + ').'));
      resolveCompletion({ code, signal });
    });
  });
  completion.catch(() => {});
  let workerResult;
  let resultError;
  const { createInterface } = await import('node:readline');
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', line => {
    if (line.startsWith('HAPPIER_RUNTIME_BUILD_RESULT=')) {
      try { workerResult = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_RESULT='.length)); }
      catch (error) { resultError = error; }
      return;
    }
    if (!line.startsWith('HAPPIER_RUNTIME_BUILD_READY=')) { process.stdout.write(line + '\n'); return; }
    try {
      const value = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_READY='.length));
      if (typeof value.worker !== 'string' || !value.runtimeTarget?.platform || !value.runtimeTarget?.arch) {
        throw new Error('[build] invalid admitted runtime worker.');
      }
      ready(value);
    } catch (error) { rejectReady(error); }
  });
  child.stderr.pipe(process.stderr, { end: false });
  let directory;
  let remoteCleanup;
  let dispatched = false;
  try {
    const admitted = await readiness;
    const local = admitted.worker === 'local';
    const worker = local ? null : config.targets.find(candidate => candidate.name === admitted.worker);
    if (!local && !worker) throw new Error('[build] admitted runtime worker is not in the configured pool.');
    return await run({ buildComponents: async options => {
      if (dispatched) throw new Error('[build] admitted runtime compilation cannot be replayed.');
      const reason = getComponentArtifactBuildTargetUnavailableReason({
        components: options.selection.components, target: { os: target.platform, arch: target.arch },
        platform: admitted.runtimeTarget.platform, arch: admitted.runtimeTarget.arch,
        commandProbe: () => admitted.supportTargetAdmitted === true,
      });
      if (reason) throw new Error(reason);
      directory = await mkdtemp(join(tmpdir(), 'happier-runtime-build-'));
      const request = { selection: options.selection, target,
        env: { ...Object.fromEntries(BUILD_ENV_KEYS.filter(key => env[key] != null).map(key => [key, env[key]])),
          [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' },
        ...(local ? { outputDir: directory } : { archive: true }),
      };
      dispatched = true;
      child.stdin.write(JSON.stringify(request) + '\n');
      const built = await completion;
      if (!local && typeof workerResult?.workspaceDir === 'string') {
        const { runDevTargetCommand } = await import('../utils/dev_targets/executor.mjs');
        remoteCleanup = async () => {
          const result = await (transport.runCommand ?? runDevTargetCommand)({
            target: worker, stackBaseDir,
            commandArgs: ['node', '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', workerResult.workspaceDir],
            syncAlreadyVerified: true, dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env,
          });
          if (result.code !== 0) throw new Error('exit ' + result.code);
        };
      }
      if (built.code !== 0) throw new Error('[build] ' + admitted.worker + ' runtime build failed (exit ' + built.code + '); no local replay.');
      if (resultError) throw resultError;
      if (!workerResult?.result || typeof workerResult.workspaceDir !== 'string') {
        throw new Error('[build] runtime worker returned no final artifacts.');
      }
      const sourceStackBaseDir = join(directory, 'store');
      if (!local) {
        const { transferRuntimeFile, runRuntimeArchiveCommand } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
        const archivePath = join(directory, 'artifacts.tar');
        await (transport.transfer ?? transferRuntimeFile)({ target: worker, direction: 'download',
          localPath: archivePath, remotePath: posix.join(workerResult.workspaceDir, 'artifacts.tar') });
        await mkdir(sourceStackBaseDir);
        await runRuntimeArchiveCommand(['-xf', archivePath, '-C', sourceStackBaseDir], { env });
        // The validated archive owns the transported result and closure.
        workerResult.result = JSON.parse(await readFile(join(sourceStackBaseDir, 'result.json'), 'utf8'));
      }
      const { importRuntimeArtifactClosure } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
      return { ...workerResult.result,
        buildPlacement: local ? { mode: 'local' } : { mode: 'target', target: worker.name, workspaceDir: worker.repoDir },
        // Parent invokes this inside the existing short publication lock. The
        // private store stays alive until the admitted run callback completes.
        publishArtifacts: () => importRuntimeArtifactClosure({ sourceStackBaseDir, stackBaseDir,
          artifacts: workerResult.result.artifacts, target }),
      };
    } });
  } finally {
    child.stdin.end();
    await completion;
    stdout.close();
    await remoteCleanup?.().catch(error => process.stderr.write('[build] final artifact staging cleanup failed: ' + error.message + '.\n'));
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export async function buildRuntimeArtifactComponentsAtPlacement(options) {
  return await withAdmittedRuntimeBuildPlacement({ ...options, run: async execution => {
    const { publishArtifacts, ...result } = await execution.buildComponents(options);
    return { ...result, artifacts: await publishArtifacts() };
  } });
}

async function executeWorkerRequest(request) {
  const reason = getComponentArtifactBuildTargetUnavailableReason({
    components: request.selection.components, target: { os: request.target.platform, arch: request.target.arch },
  });
  if (reason) throw new Error(reason);
  const repoDir = process.cwd();
  const workspaceDir = request.outputDir ?? await mkdtemp(join(tmpdir(), 'happier-runtime-build-'));
  const store = join(workspaceDir, 'store');
  let succeeded = false;
  try {
    const { buildRuntimeArtifactComponents } = await import('./build_stack_artifacts.mjs');
    const result = await buildRuntimeArtifactComponents({ rootDir: join(repoDir, 'apps/stack'),
      stackBaseDir: store, selection: request.selection, target: request.target,
      env: { ...process.env, ...request.env, HAPPIER_STACK_REPO_DIR: repoDir },
    });
    if (request.archive) {
      await mkdir(store, { recursive: true });
      await writeFile(join(store, 'result.json'), JSON.stringify(result));
      const { packRuntimeArtifactClosure } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
      await packRuntimeArtifactClosure({ stackBaseDir: store, artifacts: result.artifacts, target: request.target,
        archivePath: join(workspaceDir, 'artifacts.tar'), env: process.env });
    }
    process.stdout.write('HAPPIER_RUNTIME_BUILD_RESULT=' + JSON.stringify({ result, workspaceDir }) + '\n');
    succeeded = true;
  } finally {
    // Successful final staging belongs to the controller until import finishes.
    if (!succeeded) await rm(workspaceDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--worker-request=stdin')) throw new Error('[build] runtime build worker requires an admitted request.');
  const { createInterface } = await import('node:readline');
  const targetArg = process.argv.slice(2).find(arg => arg.startsWith('--artifact-target='));
  const [platform, arch] = String(targetArg?.slice('--artifact-target='.length) ?? '').split('-');
  if (!platform || !arch) throw new Error('[build] runtime control requires an artifact target.');
  const input = createInterface({ input: process.stdin });
  const request = new Promise((resolveRequest, reject) => {
    input.once('line', line => {
      try { resolveRequest(JSON.parse(line)); } catch (error) { reject(error); }
    });
    input.once('close', () => resolveRequest(null));
  });
  writeRuntimeAdmissionPhase('awaiting-runtime-request');
  process.stdout.write('HAPPIER_RUNTIME_BUILD_READY=' + JSON.stringify({
    worker: process.env.HAPPIER_RUNTIME_BUILD_WORKER_NAME,
    runtimeTarget: { platform: process.platform, arch: process.arch },
    supportTargetAdmitted: !getCliBinaryArtifactSupportTargetUnavailableReason({ target: { os: platform, arch } }),
  }) + '\n');
  const admitted = await request;
  input.close();
  if (admitted) {
    writeRuntimeAdmissionPhase('building-runtime');
    await executeWorkerRequest(admitted);
  }
}
