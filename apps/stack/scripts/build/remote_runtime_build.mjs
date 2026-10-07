import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCliBinaryArtifactSupportTargetUnavailableReason, getComponentArtifactBuildTargetUnavailableReason } from '../../../../packages/cli-common/componentArtifactTarget.mjs';
import { isGeneratedPluginArtifactPath } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCachedFileDigest } from '../utils/fs/cached_file_digest.mjs';
import { writeRuntimeAdmissionPhase } from '../utils/proc/service_memory.mjs';

const WORKER_ENTRY = 'apps/stack/scripts/build/remote_runtime_build.mjs';
const BUILD_ENV_KEYS = ['HAPPIER_CLI_BUN_EXTERNALS', 'HAPPIER_SERVER_BUN_EXTERNALS', 'HAPPIER_BUILD_DB_PROVIDERS', 'HAPPY_BUILD_DB_PROVIDERS', 'HAPPIER_SERVER_REQUIRE_IROH_NATIVE', 'HAPPIER_STACK_EXPO_CLEAR_CACHE'];

async function resolveWorkerCacheRepositories(stackBaseDir, worker, env) {
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const repositories = new Set([worker.repoDir]);
  for (const entry of await readdir(stackBaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('commands-')) continue;
    const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, entry.name, 'dev-targets.json'), env });
    for (const target of config.targets) if (target.name === worker.name && target.cliHomeDir === worker.cliHomeDir) repositories.add(target.repoDir);
  }
  return [...repositories];
}

function sourceFilePath(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.git') || normalized.includes('\0')) {
    throw new Error('[build] source transfer path must stay inside the checkout.');
  }
  return normalized;
}

async function captureBuildSource({ rootDir, selection, captureSelection = selection, env, directory }) {
  const { collectBuildSourceMetadata } = await import('./collect_build_source_metadata.mjs');
  const { collectRuntimeComponentSourceFingerprints, createRuntimeComponentSourceIgnorePath, resolveRuntimeComponentSourcePaths } = await import('./runtime_artifact_identity.mjs');
  const { runCapture } = await import('../utils/proc/proc.mjs');
  const { runRuntimeArchiveCommand } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const { captureBuildInputFiles } = await import('../../../../scripts/workspaces/buildInputConvergence.mjs');
  const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
  const ignoreComponentInputs = Object.fromEntries(['web', 'server', 'daemon'].filter(component => captureSelection.components[component])
    .map(component => [component, createRuntimeComponentSourceIgnorePath({ component, sourceMetadata, excludeGeneratedPluginArtifacts: true })]));
  const readPaths = async () => {
    const listed = await runCapture('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: sourceMetadata.repoDir });
    const sourcePaths = new Set();
    for (const raw of new Set(listed.split('\0').filter(Boolean))) {
      const path = sourceFilePath(raw);
      if (isGeneratedPluginArtifactPath(path)) continue;
      const info = await lstat(join(sourceMetadata.repoDir, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isFile() || info?.isSymbolicLink()) sourcePaths.add(path);
    }
    // Git excludes some generated compiler inputs. Capture the canonical
    // component input closure too, including empty-directory membership.
    const visitInput = async (absolute, ignorePath) => {
      if (ignorePath?.(absolute)) return;
      const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return;
      sourcePaths.add(sourceFilePath(relative(sourceMetadata.repoDir, absolute)));
      if (info.isDirectory()) for (const name of await readdir(absolute)) await visitInput(join(absolute, name), ignorePath);
    };
    for (const component of ['web', 'server', 'daemon']) if (captureSelection.components[component]) {
      for (const path of resolveRuntimeComponentSourcePaths({ component, sourceMetadata, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true })) await visitInput(path, ignoreComponentInputs[component]);
    }
    return [...sourcePaths].sort();
  };
  const capturePath = join(directory, 'source');
  const { files, rereadPaths } = await captureBuildInputFiles({ sourceDir: sourceMetadata.repoDir, captureDir: capturePath, readPaths });
  // Runtime input descriptors resolve the CLI root physically. Use that same
  // root for the private capture so temporary-directory aliases retain the
  // producer's repository-relative labels after transfer.
  const captureDir = await realpath(capturePath);
  const expectedInputEntries = {};
  const expectedInputs = await collectRuntimeComponentSourceFingerprints({ selection,
    sourceMetadata: { ...sourceMetadata, repoDir: captureDir }, identityRepoDir: sourceMetadata.repoDir,
    includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true, inputEntries: expectedInputEntries });
  process.stderr.write(`[build] captured ${files.length} source members; trailing reads=${rereadPaths.length}.\n`);
  const listPath = join(directory, 'source-files');
  await writeFile(listPath, files.join('\0') + '\0');
  const archivePath = join(directory, 'source.tar');
  await runRuntimeArchiveCommand(['-cf', archivePath, '--no-recursion', '--null', '-T', listPath], { cwd: captureDir, env });
  return { sourceMetadata, expectedInputs, expectedInputEntries, files, archivePath, captureDir };
}

/** Native AUTO owns worker health, capability, pressure and waiting demand. */
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
    '--control-stdin', ...(forceLocal ? ['--local'] : []), '--', 'node', WORKER_ENTRY, '--worker-request=stdin',
    '--artifact-target=' + target.platform + '-' + target.arch,
  ], { cwd: repoDir, env: { ...env, HAPPIER_EXEC_CONFIG_PATH: join(stackBaseDir, 'dev-targets.json'),
    // This controller owns a new producer placement decision. An inherited
    // dispatcher marker is not that decision; admission ancestry stays intact.
    HAPPIER_DEV_TARGET_EXECUTION: '', HAPPIER_RUNTIME_BUILD_WORKER_NAME: forceLocal ? 'local' : '',
    HSTACK_EXEC_RUNTIME_SOURCE_UPLOAD: '1',
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // A terminal/canceled controller may close before ACK.
  let ready;
  let rejectReady;
  const readiness = new Promise((resolveReady, reject) => {
    rejectReady = reject;
    ready = resolveReady;
  });
  const completion = new Promise((resolveCompletion, reject) => {
    child.once('error', error => { rejectReady(error); reject(error); });
    child.once('close', (code, signal) => {
      rejectReady(new Error('[build] runtime worker exited before admission (exit ' + code + ', signal ' + signal + ').'));
      resolveCompletion({ code, signal });
    });
  });
  // Both waits are observed immediately; readiness may fail before compilation.
  completion.catch(() => {});
  let directory;
  let capture;
  let admittedWorker;
  const preparations = new Map();
  const incomingSources = [];
  const prepareSource = workerName => {
    if (preparations.has(workerName)) return preparations.get(workerName);
    const preparation = (async () => {
      const worker = workerName === 'local' ? null : config.targets.find(candidate => candidate.name === workerName);
      if (workerName !== 'local' && !worker) throw new Error('[build] source transfer worker is not in the configured pool.');
      capture ??= (async () => {
        process.stderr.write('[build] capturing source before runtime admission.\n');
        directory = await mkdtemp(join(tmpdir(), 'happier-runtime-build-'));
        // A target flight can merge another component demand after admission.
        // Capture its possible source closure now; fingerprint the actual
        // selected components from these same bytes when the flight runs.
        return await captureBuildSource({ rootDir, selection, captureSelection: { components: { web: true, server: true, daemon: true } }, env, directory });
      })();
      const captured = await capture;
      if (!worker) return { captured };
      const command = commandArgs => (transport.runCommand ?? runDevTargetCommand)({
        target: worker, stackBaseDir, commandArgs, syncAlreadyVerified: true,
        dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env,
      });
      const incoming = posix.join(worker.cliHomeDir.replaceAll('\\', '/'), 'runtime-build',
        String(stackBaseDir).replaceAll('\\', '/').split('/').at(-1), '.incoming-' + directory.split('/').at(-1));
      incomingSources.push({ incoming, command });
      const prepared = await command(['node', '-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true})', incoming]);
      if (prepared.code !== 0) throw new Error('[build] worker transfer preparation failed (exit ' + prepared.code + ').');
      process.stderr.write('[build] uploading captured source before runtime admission on ' + workerName + '.\n');
      await (transport.transfer ?? transferRuntimeFile)({ target: worker, direction: 'upload',
        localPath: captured.archivePath, remotePath: posix.join(incoming, 'source.tar') });
      return { captured, incoming };
    })();
    preparations.set(workerName, preparation);
    return preparation;
  };
  const { runDevTargetCommand } = await import('../utils/dev_targets/executor.mjs');
  const { transferRuntimeFile } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const { createInterface } = await import('node:readline');
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', line => {
    if (line.startsWith('HAPPIER_RUNTIME_BUILD_PREPARE=')) {
      try {
        const { worker } = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_PREPARE='.length));
        if (typeof worker !== 'string') throw new Error('[build] invalid source transfer worker.');
        void prepareSource(worker).then(() => child.stdin.write(JSON.stringify({ prepareWorker: worker }) + '\n'))
          .catch(error => {
            if (admittedWorker && admittedWorker !== worker) {
              process.stderr.write('[build] unused worker source transfer failed: ' + error.message + '.\n');
              return;
            }
            rejectReady(error); child.stdin.end();
          });
      } catch (error) { rejectReady(error); child.stdin.end(); }
      return;
    }
    if (!line.startsWith('HAPPIER_RUNTIME_BUILD_READY=')) {
      process.stdout.write(line + '\n');
      return;
    }
    try {
      const value = JSON.parse(line.slice('HAPPIER_RUNTIME_BUILD_READY='.length));
      if (typeof value.worker !== 'string' || !value.runtimeTarget?.platform || !value.runtimeTarget?.arch) {
        throw new Error('[build] invalid admitted runtime worker.');
      }
      admittedWorker = value.worker;
      ready(value);
    } catch (error) { rejectReady(error); }
  });
  child.stderr.pipe(process.stderr, { end: false });
  let dispatched = false;
  try {
    const admitted = await readiness;
    const local = admitted.worker === 'local';
    const worker = local ? null : config.targets.find(candidate => candidate.name === admitted.worker);
    if (!local && !worker) throw new Error('[build] admitted runtime worker is not in the configured pool.');
    return await run({ buildComponents: async options => {
      if (dispatched) throw new Error('[build] admitted runtime compilation cannot be replayed.');
      const reason = getComponentArtifactBuildTargetUnavailableReason({
        components: options.selection.components,
        target: { os: target.platform, arch: target.arch },
        platform: admitted.runtimeTarget.platform, arch: admitted.runtimeTarget.arch,
        commandProbe: () => admitted.supportTargetAdmitted === true,
      });
      if (reason) throw new Error(reason);
      let cleanup;
      try {
        const preparedSource = preparations.get(admitted.worker);
        if (!preparedSource) throw new Error('[build] worker admitted without prepared source.');
        const { captured, incoming } = await preparedSource;
        const { collectRuntimeComponentSourceFingerprints } = await import('./runtime_artifact_identity.mjs');
        const unchangedSelection = ['web', 'server', 'daemon'].every(component =>
          (options.selection.components[component] === true) === (selection.components[component] === true));
        const expectedInputEntries = unchangedSelection ? captured.expectedInputEntries : {};
        const expectedInputs = unchangedSelection ? captured.expectedInputs : await collectRuntimeComponentSourceFingerprints({ selection: options.selection,
          sourceMetadata: { ...captured.sourceMetadata, repoDir: captured.captureDir }, identityRepoDir: captured.sourceMetadata.repoDir,
          includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true, inputEntries: expectedInputEntries });
        const { WORKSPACE_BUILD_MODE_ENV } = await import('../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
        const buildEnv = { ...Object.fromEntries(BUILD_ENV_KEYS.filter(key => env[key] != null).map(key => [key, env[key]])),
          [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' };
        if (local) {
          const requestPath = join(directory, 'request.json');
          const resultPath = join(directory, 'result.json');
          await writeFile(requestPath, JSON.stringify({ ...captured, expectedInputs, expectedInputEntries, archivePath: undefined,
            selection: options.selection, target, workspaceDir: directory, env: buildEnv, localBuild: {
            rootDir: join(captured.captureDir, 'apps/stack'), stackBaseDir, selection: options.selection, target,
            retentionPolicy: options.retentionPolicy,
          }, resultPath }));
          dispatched = true;
          child.stdin.write(JSON.stringify({ requestPath }) + '\n');
          const built = await completion;
          if (built.code !== 0) throw new Error('[build] local runtime build failed (exit ' + built.code + '); no local replay.');
          const result = JSON.parse(await readFile(resultPath, 'utf8'));
          return { ...result, buildPlacement: { mode: 'local' } };
        }
        const { runDevTargetCommand } = await import('../utils/dev_targets/executor.mjs');
        const { transferRuntimeFile, runRuntimeArchiveCommand, importRuntimeArtifactClosure, removeRemoteRuntimeTransferArchives } =
          await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
        const workspaceDir = posix.join(worker.cliHomeDir.replaceAll('\\', '/'), 'runtime-build',
          String(stackBaseDir).replaceAll('\\', '/').split('/').at(-1), target.platform + '-' + target.arch);
        const command = commandArgs => (transport.runCommand ?? runDevTargetCommand)({
          target: worker, stackBaseDir, commandArgs, syncAlreadyVerified: true,
          dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env,
        });
        const transfer = async ({ direction, localPath, remotePath }) =>
          await (transport.transfer ?? transferRuntimeFile)({ target: worker, direction, localPath, remotePath });
        const prepared = await command(['node', '-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true})', workspaceDir]);
        if (prepared.code !== 0) throw new Error('[build] worker workspace preparation failed (exit ' + prepared.code + ').');
        const archivePaths = ['source.tar', 'artifacts.tar'].map(name => posix.join(workspaceDir, name));
        cleanup = async () => {
          await removeRemoteRuntimeTransferArchives({ archivePaths, runCommand: command });
        };
        const request = { ...captured, expectedInputs, expectedInputEntries, archivePath: undefined, captureDir: undefined, selection: options.selection, workspaceDir, target,
          cacheRepositoryDirectories: await resolveWorkerCacheRepositories(stackBaseDir, worker, env),
          env: { ...buildEnv,
            HAPPIER_STACK_PM_CACHE_BASE_DIR: posix.join(worker.cliHomeDir.replaceAll('\\', '/'), 'cache'),
            CARGO_TARGET_DIR: posix.join(worker.cliHomeDir.replaceAll('\\', '/'), 'cache', 'iroh-native-target'),
          },
        };
        const requestPath = join(directory, 'request.json');
        await writeFile(requestPath, JSON.stringify(request));
        const installed = await command(['node', '-e', 'require("node:fs").renameSync(process.argv[1],process.argv[2])',
          posix.join(incoming, 'source.tar'), posix.join(workspaceDir, 'source.tar')]);
        if (installed.code !== 0) throw new Error('[build] worker source handover failed (exit ' + installed.code + ').');
        await transfer({ direction: 'upload', localPath: requestPath, remotePath: posix.join(workspaceDir, 'request.json') });
        process.stderr.write('[build] runtime preparation and compilation on ' + admitted.worker + ': ' + workspaceDir + '/repo (' + target.platform + '/' + target.arch + ').\n');
        dispatched = true;
        child.stdin.write(JSON.stringify({ requestPath: posix.join(workspaceDir, 'request.json') }) + '\n');
        const built = await completion;
        if (built.code !== 0) throw new Error('[build] ' + admitted.worker + ' runtime build failed (exit ' + built.code + '); no local replay.');
        const artifactArchive = join(directory, 'artifacts.tar');
        await transfer({ direction: 'download', localPath: artifactArchive, remotePath: posix.join(workspaceDir, 'artifacts.tar') });
        const importedStore = join(directory, 'store');
        await mkdir(importedStore);
        await runRuntimeArchiveCommand(['-xf', artifactArchive, '-C', importedStore], { env });
        const result = JSON.parse(await readFile(join(importedStore, 'result.json'), 'utf8'));
        const artifacts = await importRuntimeArtifactClosure({ sourceStackBaseDir: importedStore, stackBaseDir, artifacts: result.artifacts, target });
        return { ...result, artifacts, buildPlacement: { mode: 'target', target: worker.name, workspaceDir } };
      } finally {
        await cleanup?.().catch(error => process.stderr.write('[build] transfer archive cleanup failed: ' + error.message + '.\n'));
      }
    } });
  } finally {
    child.stdin.end();
    await completion;
    stdout.close();
    await Promise.allSettled(preparations.values());
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const { incoming, command } of incomingSources) {
      await command(['node', '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', incoming])
        .then(result => { if (result.code !== 0) throw new Error('exit ' + result.code); })
        .catch(error => process.stderr.write('[build] incoming source cleanup failed: ' + error.message + '.\n'));
    }
  }
}

export async function buildRuntimeArtifactComponentsAtPlacement(options) {
  return await withAdmittedRuntimeBuildPlacement({ ...options,
    run: execution => execution.buildComponents(options),
  });
}

export async function extractCapturedBuildSource({ workspaceDir, files: rawFiles }) {
  const repoDir = join(workspaceDir, 'repo');
  const sourceFilesPath = join(workspaceDir, 'source-files.json');
  const files = rawFiles.map(sourceFilePath).filter(path => !isGeneratedPluginArtifactPath(path));
  const nextFiles = new Set(files);
  const nextDirectories = new Set();
  for (const file of files) {
    for (let parent = posix.dirname(file); parent !== '.'; parent = posix.dirname(parent)) nextDirectories.add(parent);
  }
  const previousFiles = JSON.parse(await readFile(sourceFilesPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; }))
    .map(sourceFilePath).filter(path => !isGeneratedPluginArtifactPath(path));
  await mkdir(repoDir, { recursive: true });
  // Captured directory membership is complete. Build generators can leave
  // additional files which were never in the previous captured inventory.
  // Prune only admitted source directories; installed dependencies and dist
  // outside that source closure remain available for the next build.
  for (const path of new Set([...previousFiles, ...files])) {
    const directory = join(repoDir, sourceFilePath(path));
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isDirectory()) continue;
    for (const name of await readdir(directory)) {
      const child = `${path}/${name}`;
      if (isGeneratedPluginArtifactPath(child)) continue;
      if (!nextFiles.has(child) && !nextDirectories.has(child)) {
        await rm(join(directory, name), { recursive: true, force: true });
      }
    }
  }
  for (const path of previousFiles.sort((a, b) => b.length - a.length)) if (!nextFiles.has(path)) {
    const removed = join(repoDir, sourceFilePath(path));
    const info = await lstat(removed).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isDirectory()) {
      await rmdir(removed).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
    } else await rm(removed, { force: true });
    // Empty removed source directories are consumed input membership too.
    for (let parent = dirname(removed); parent !== repoDir; parent = dirname(parent)) {
      try { await rmdir(parent); } catch (error) {
        if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) break;
        throw error;
      }
    }
  }
  // Extract transport bytes privately, then apply only changed source members.
  // Rewriting unchanged inputs invalidates TypeScript's filesystem observations
  // even when the package owner's content receipt remains current.
  const { spawnSync } = await import('node:child_process');
  const archivePath = join(workspaceDir, 'source.tar');
  const incoming = await mkdtemp(join(workspaceDir, 'source-delta-'));
  try {
    const extraction = spawnSync('tar', ['-xf', archivePath, '-C', incoming], { stdio: 'inherit' });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error('[build] worker source extraction failed.');
    for (const path of files) {
      const source = join(incoming, path);
      const destination = join(repoDir, path);
      const info = await lstat(source, { bigint: true });
      const existing = await lstat(destination, { bigint: true }).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (info.isDirectory() && existing?.isDirectory()) continue;
      if (info.isFile() && existing?.isFile() && info.size === existing.size
        && await readCachedFileDigest(source, info) === await readCachedFileDigest(destination, existing)) {
        if (info.mode !== existing.mode) await chmod(destination, Number(info.mode & 0o777n));
        continue;
      }
      if (info.isSymbolicLink() && existing?.isSymbolicLink() && await readlink(source) === await readlink(destination)) continue;
      if (existing) await rm(destination, { recursive: true, force: true });
      await mkdir(dirname(destination), { recursive: true });
      if (info.isDirectory()) await mkdir(destination, { mode: Number(info.mode & 0o777n) });
      else await cp(source, destination, { verbatimSymlinks: true, preserveTimestamps: true });
    }
  } finally {
    await rm(incoming, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
  await writeFile(sourceFilesPath, JSON.stringify(files));
  return repoDir;
}

async function executeWorkerRequest(requestPath) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const reason = getComponentArtifactBuildTargetUnavailableReason({
    components: request.selection.components,
    target: { os: request.target.platform, arch: request.target.arch },
  });
  if (reason) throw new Error(reason);
  const workspaceDir = resolve(request.workspaceDir);
  if (!request.localBuild && process.platform === 'linux') {
    const { pruneWorkerRuntimeStaging } = await import('../utils/dev_targets/worker_disk_budget.mjs');
    pruneWorkerRuntimeStaging({ runtimeBuildRoot: dirname(dirname(workspaceDir)),
      target: posix.basename(workspaceDir), workspaceDir });
  }
  const repoDir = request.localBuild ? request.captureDir
    : await extractCapturedBuildSource({ workspaceDir, files: request.files });
  // Check transfer inputs before install/prebuild generators legitimately
  // update derived inputs. This is the existing source identity owner; only the
  // subsequent build process loads and executes the captured checkout graph.
  const { collectRuntimeComponentSourceFingerprints } = await import('./runtime_artifact_identity.mjs');
  const extractedInputEntries = {};
  const extractedInputs = await collectRuntimeComponentSourceFingerprints({
    selection: request.selection, sourceMetadata: { ...request.sourceMetadata, repoDir }, identityRepoDir: request.sourceMetadata.repoDir, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true, inputEntries: extractedInputEntries,
  });
  assertCapturedRuntimeInputs({ expectedInputs: request.expectedInputs, extractedInputs, expectedInputEntries: request.expectedInputEntries, extractedInputEntries });
  // Load the captured owner, rather than the moving mirror's module graph.
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [join(repoDir, WORKER_ENTRY), `--build-captured=${requestPath}`], {
    cwd: repoDir, stdio: 'inherit', env: { ...process.env, ...request.env,
      HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: request.sourceMetadata.repoDir,
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`[build] captured runtime build exited ${child.status}.`);
  if (!request.localBuild && process.platform === 'linux') {
    const { pruneWorkerYarnCache } = await import('../utils/proc/package_manager_cache.mjs');
    pruneWorkerYarnCache({ cacheBaseDir: request.env.HAPPIER_STACK_PM_CACHE_BASE_DIR,
      repositoryDirectories: [...request.cacheRepositoryDirectories, repoDir],
      runtimeBuildRoot: dirname(dirname(workspaceDir)) });
  }
}

export function assertCapturedRuntimeInputs({ expectedInputs, extractedInputs, expectedInputEntries, extractedInputEntries }) {
  const components = [...new Set([...Object.keys(expectedInputs), ...Object.keys(extractedInputs)])]
    .filter(component => expectedInputs[component] !== extractedInputs[component]);
  if (!components.length) return;
  const keys = [];
  for (const component of components) {
    const expected = expectedInputEntries?.[component] ?? {};
    const actual = extractedInputEntries?.[component] ?? {};
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      if (expected[key] !== actual[key]) keys.push(`${component}:${key}`);
    }
  }
  // Bound diagnostic presentation only; every input still participates in
  // admission. Twenty path keys keep the process error readable.
  throw new Error(`[build] captured worker inputs differ from the admitted producer inputs: components=${components.join(',')}; differing keys (${keys.length}, first 20)=${JSON.stringify(keys.slice(0, 20))}.`);
}

async function buildCapturedRequest(requestPath) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const repoDir = process.cwd();
  const { bootstrapRemoteDependencies } = await import('../utils/dev_targets/remote_dependency_bootstrap.mjs');
  await bootstrapRemoteDependencies({ repoDir, componentRelativeDir: 'apps/stack' });
  const sourceMetadata = { ...request.sourceMetadata, repoDir };
  const { buildRuntimeArtifactComponents, retainBuiltRuntimeArtifacts } = await import('./build_stack_artifacts.mjs');
  const store = request.localBuild?.stackBaseDir ?? join(request.workspaceDir, 'store');
  const result = await buildRuntimeArtifactComponents({ rootDir: join(repoDir, 'apps/stack'), stackBaseDir: store,
    selection: request.selection, env: process.env, target: request.target,
    collectBuildSourceMetadataImpl: async () => sourceMetadata,
    ...(request.localBuild ? { retentionPolicy: request.localBuild.retentionPolicy } : {}),
  });
  // Keep immutable provenance from the producer; directories are execution
  // placement, not a second source authority.
  result.sourceMetadata = request.sourceMetadata;
  if (request.localBuild) {
    await writeFile(request.resultPath, JSON.stringify(result));
    return;
  }
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'result.json'), JSON.stringify(result));
  const { packRuntimeArtifactClosure } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  await packRuntimeArtifactClosure({ stackBaseDir: store, artifacts: result.artifacts, target: request.target, archivePath: join(request.workspaceDir, 'artifacts.tar'), env: process.env });
  // The worker constructs components without publishing a selected snapshot.
  // Apply the same retention graph after packing so its unselected store does
  // not retain every prior build indefinitely.
  const { resolveRuntimeRetentionPolicy } = await import('./runtime_retention.mjs');
  await retainBuiltRuntimeArtifacts({ stackBaseDir: store, artifacts: result.artifacts, target: request.target,
    env: process.env, retentionPolicy: resolveRuntimeRetentionPolicy({ env: process.env }),
    ...(process.platform === 'linux' ? { unusedArtifactProcRoot: '/proc' } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const worker = process.argv.slice(2).find(arg => arg.startsWith('--worker-request='));
  const captured = process.argv.slice(2).find(arg => arg.startsWith('--build-captured='));
  if (worker === '--worker-request=stdin') {
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
      if (typeof admitted.requestPath !== 'string' || !admitted.requestPath) throw new Error('[build] invalid runtime control request.');
      writeRuntimeAdmissionPhase('building-runtime');
      await executeWorkerRequest(admitted.requestPath);
    }
  }
  else if (worker) await executeWorkerRequest(worker.slice('--worker-request='.length));
  else if (captured) await buildCapturedRequest(captured.slice('--build-captured='.length));
  else throw new Error('[build] runtime build worker requires an admitted request.');
}
