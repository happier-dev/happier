import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCliBinaryArtifactSupportTargetUnavailableReason, getComponentArtifactBuildTargetUnavailableReason } from '../../../../packages/cli-common/componentArtifactTarget.mjs';
import { isGeneratedPluginArtifactPath } from '../utils/fs/workspaceBuildInputs.mjs';

const WORKER_ENTRY = 'apps/stack/scripts/build/remote_runtime_build.mjs';
const BUILD_ENV_KEYS = ['HAPPIER_CLI_BUN_EXTERNALS', 'HAPPIER_SERVER_BUN_EXTERNALS', 'HAPPIER_BUILD_DB_PROVIDERS', 'HAPPY_BUILD_DB_PROVIDERS', 'HAPPIER_SERVER_REQUIRE_IROH_NATIVE', 'HAPPIER_STACK_EXPO_CLEAR_CACHE'];

export function resolveRuntimeBuildPlacement({ config, hostTarget, observedTarget, targetName, selection = { components: { daemon: true } } }) {
  const placement = config?.runtimePlacement?.build;
  if (placement?.mode !== 'prefer-target') return { target: null, reason: null };
  const target = config.targets.find(candidate => candidate.name === (targetName ?? placement.targets[0]));
  if (!target || target.platform !== 'posix') return { target: null, reason: 'build worker requires a POSIX target (WSL is supported)' };
  if (!observedTarget?.ok) return { target: null, reason: 'build worker is unavailable' };
  if (!observedTarget.runtimeTarget?.platform || !observedTarget.runtimeTarget?.arch) {
    return { target: null, reason: 'build worker execution target is unavailable' };
  }
  const reason = getComponentArtifactBuildTargetUnavailableReason({
    components: selection.components,
    target: { os: hostTarget.platform, arch: hostTarget.arch },
    platform: observedTarget.runtimeTarget.platform, arch: observedTarget.runtimeTarget.arch,
    commandProbe: () => observedTarget.supportTargetAdmitted === true,
  });
  if (reason) return { target: null, reason };
  if (observedTarget.admissionReady === false) return { target: null,
    reason: observedTarget.admissionReason || 'runtime-build admission capacity is unavailable now' };
  return { target, reason: null };
}

function sourceFilePath(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.git') || normalized.includes('\0')) {
    throw new Error('[build] source transfer path must stay inside the checkout.');
  }
  return normalized;
}

async function captureBuildSource({ rootDir, selection, env, directory }) {
  const { collectBuildSourceMetadata } = await import('./collect_build_source_metadata.mjs');
  const { collectRuntimeComponentSourceFingerprints, resolveRuntimeComponentSourcePaths } = await import('./runtime_artifact_identity.mjs');
  const { runCapture } = await import('../utils/proc/proc.mjs');
  const { runRuntimeArchiveCommand } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const { withSingleTrailingBuildPass, BuildInputDriftError } = await import('../../../../scripts/workspaces/buildInputConvergence.mjs');
  return await withSingleTrailingBuildPass({ run: async () => {
    const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
    const expectedInputEntries = {};
    const expectedInputs = await collectRuntimeComponentSourceFingerprints({ selection, sourceMetadata, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true, inputEntries: expectedInputEntries });
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
    const visitInput = async absolute => {
      const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return;
      sourcePaths.add(sourceFilePath(relative(sourceMetadata.repoDir, absolute)));
      if (info.isDirectory()) for (const name of await readdir(absolute)) await visitInput(join(absolute, name));
    };
    for (const component of ['web', 'server', 'daemon']) if (selection.components[component]) {
      for (const path of resolveRuntimeComponentSourcePaths({ component, sourceMetadata, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true })) await visitInput(path);
    }
    const files = [...sourcePaths].sort();
    const listPath = join(directory, 'source-files');
    await writeFile(listPath, files.join('\0') + '\0');
    const archivePath = join(directory, 'source.tar');
    await runRuntimeArchiveCommand(['-cf', archivePath, '--no-recursion', '--null', '-T', listPath], { cwd: sourceMetadata.repoDir, env });
    const after = await collectRuntimeComponentSourceFingerprints({ selection, sourceMetadata, includeRuntimeSupportInputs: true, excludeGeneratedPluginArtifacts: true });
    if (JSON.stringify(after) !== JSON.stringify(expectedInputs)) throw new BuildInputDriftError('[build] consumed inputs changed during source transfer capture.');
    return { sourceMetadata, expectedInputs, expectedInputEntries, files, archivePath };
  } });
}

export async function buildRuntimeArtifactComponentsAtPlacement({ rootDir, stackBaseDir, selection, target: requestedTarget = { platform: process.platform, arch: process.arch }, env, retentionPolicy, buildLocal, transport = {} }) {
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json'), env });
  const configured = config.runtimePlacement?.build;
  if (configured?.mode !== 'prefer-target') return await buildLocal({ rootDir, stackBaseDir, selection, target: requestedTarget, env, retentionPolicy });
  const { runDevTargetsDoctor } = await import('../utils/dev_targets/doctor.mjs');
  const { runDevTargetCommand, syncDevTarget } = await import('../utils/dev_targets/executor.mjs');
  const { transferRuntimeFile, runRuntimeArchiveCommand, importRuntimeArtifactClosure, removeRemoteRuntimeTransferArchives } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const runCommand = transport.runCommand ?? runDevTargetCommand;
  const transfer = transport.transfer ?? transferRuntimeFile;
  const attempts = [];
  const fallback = async reason => {
    process.stderr.write('[build] no configured worker can admit this runtime build now; trying the configured local fallback (local admission may wait).\n');
    process.stderr.write(`[build] ${configured.targets.join(' → ')}: local runtime build fallback: ${reason}.\n`);
    const result = await buildLocal({ rootDir, stackBaseDir, selection, target: requestedTarget, env, retentionPolicy });
    return { ...result, buildPlacement: { mode: 'local', fallbackFrom: configured.targets.join(','), attempts, reason } };
  };
  const directory = await mkdtemp(join(tmpdir(), 'happier-runtime-build-'));
  let cleanupRemoteArchives;
  try {
    const { WORKSPACE_BUILD_MODE_ENV } = await import('../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
    let captured;
    let target;
    let workspaceDir;
    let command;
    let request;
    for (const targetName of configured.targets) {
      const candidate = config.targets.find(target => target.name === targetName);
      let reason;
      try {
        const doctor = await runDevTargetsDoctor({ targets: candidate ? [candidate] : [], env }, transport.doctorDependencies);
        const observedTarget = doctor.targets[0];
        if (selection.components.daemon && observedTarget?.ok
          && observedTarget.runtimeTarget?.platform === requestedTarget.platform
          && observedTarget.runtimeTarget?.arch !== requestedTarget.arch) {
          await syncDevTarget({ target: candidate, stackBaseDir, env }, transport.syncDependencies);
          const probe = await runCommand({ target: candidate, stackBaseDir, syncAlreadyVerified: true,
            dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env,
            commandArgs: ['node', '--input-type=module', '-e',
              'import { getCliBinaryArtifactSupportTargetUnavailableReason as reason } from "./packages/cli-common/componentArtifactTarget.mjs"; const result = reason({target:JSON.parse(process.argv[1])}); if(result) console.error(result); process.exit(result ? 1 : 0);',
              JSON.stringify({ os: requestedTarget.platform, arch: requestedTarget.arch })],
          });
          observedTarget.supportTargetAdmitted = probe.code === 0;
        }
        const resolved = resolveRuntimeBuildPlacement({ config, targetName, selection, hostTarget: requestedTarget, observedTarget });
        reason = resolved.reason;
        if (resolved.target) {
          await syncDevTarget({ target: candidate, stackBaseDir, env }, transport.syncDependencies);
          // Query the actual target-side admission owner, without starting an
          // outer validation job that could itself queue behind publication.
          const admission = await runCommand({ target: candidate, stackBaseDir, syncAlreadyVerified: true,
            dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env,
            commandArgs: ['node', '-e', 'const r=require("node:child_process").spawnSync(process.argv[1],process.argv.slice(2),{stdio:"inherit"}); if(r.error) throw r.error; process.exit(r.status ?? 1);',
              `${candidate.repoDir}/apps/stack/bin/hstack-exec`, '--heavyweight-admission-check', '--class=runtime-build', `--machine=${candidate.name}`],
          });
          observedTarget.admissionReady = admission.code === 0;
          observedTarget.admissionReason = String(admission.err || admission.stderr || 'runtime-build admission capacity is unavailable now').trim();
          reason = resolveRuntimeBuildPlacement({ config, targetName, selection, hostTarget: requestedTarget, observedTarget }).reason;
        }
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (reason) {
        attempts.push({ target: targetName, reason });
        process.stderr.write(`[build] ${targetName}: runtime build preflight skipped: ${reason}.\n`);
        continue;
      }
      captured ??= await captureBuildSource({ rootDir, selection, env, directory });
      // This workspace is outside the continuously synchronized source replica.
      workspaceDir = posix.join(candidate.cliHomeDir.replaceAll('\\', '/'), 'runtime-build', String(stackBaseDir).replaceAll('\\', '/').split('/').at(-1));
      command = async (commandArgs, admissionMode = 'wait') => await runCommand({ target: candidate, stackBaseDir, commandArgs, admissionMode, syncAlreadyVerified: true, dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env });
      const requestPath = join(directory, 'request.json');
      request = { ...captured, archivePath: undefined, selection, workspaceDir,
        target: requestedTarget,
        // Apply the component owner's existing runtime policy to bootstrap too,
        // rather than introducing a strict preparation phase before QA admission.
        env: { ...Object.fromEntries(BUILD_ENV_KEYS.filter(key => env[key] != null).map(key => [key, env[key]])), [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' },
      };
      await writeFile(requestPath, JSON.stringify(request));
      let preparationError = null;
      try {
        const prepared = await command(['node', '-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true})', workspaceDir]);
        if (prepared.code !== 0) throw new Error(`workspace preflight exited ${prepared.code}`);
        const cleanupCommand = command;
        const archivePaths = ['source.tar', 'artifacts.tar'].map(name => posix.join(workspaceDir, name));
        cleanupRemoteArchives = async () => {
          try {
            await removeRemoteRuntimeTransferArchives({ archivePaths, runCommand: cleanupCommand });
          } catch (error) {
            process.stderr.write(`[build] ${candidate.name}: transfer archive cleanup failed: ${error instanceof Error ? error.message : String(error)}.\n`);
          }
        };
        await transfer({ target: candidate, direction: 'upload', localPath: captured.archivePath, remotePath: posix.join(workspaceDir, 'source.tar') });
        await transfer({ target: candidate, direction: 'upload', localPath: requestPath, remotePath: posix.join(workspaceDir, 'request.json') });
      } catch (error) {
        preparationError = error instanceof Error ? error.message : String(error);
      }
      if (preparationError) {
        await cleanupRemoteArchives?.();
        cleanupRemoteArchives = undefined;
        attempts.push({ target: targetName, reason: preparationError });
        process.stderr.write(`[build] ${targetName}: runtime build preparation skipped: ${preparationError}.\n`);
        continue;
      }
      // The preflight is only an observation: another admitted job can consume
      // its headroom while source is captured/transferred. Attempt the same
      // owner without queuing, and retry placement only on its typed denial.
      await rm(captured.archivePath, { force: true });
      process.stderr.write(`[build] runtime preparation and compilation on ${candidate.name}: ${workspaceDir}/repo (${request.target.platform}/${request.target.arch}).\n`);
      const built = await command(['node', WORKER_ENTRY, `--worker-request=${posix.join(workspaceDir, 'request.json')}`], 'try');
      if (built.admissionUnavailable === true) {
        await cleanupRemoteArchives?.();
        cleanupRemoteArchives = undefined;
        captured = undefined;
        const reason = 'runtime-build admission capacity changed before dispatch';
        attempts.push({ target: targetName, reason });
        process.stderr.write(`[build] ${targetName}: runtime build preflight skipped: ${reason}.\n`);
        continue;
      }
      // A started command's failure is authoritative, including exit 75
      // without admission denial. Never replay compilation or a lost result.
      if (built.code !== 0) throw new Error(`[build] ${candidate.name} runtime build failed (exit ${built.code}); no local replay.`);
      target = candidate;
      break;
    }
    // No remaining target needs this capture. Do not hold a second source tree
    // on the producer while the worker compiles or local fallback runs.
    if (captured) await rm(captured.archivePath, { force: true });
    if (!target) return await fallback(attempts.map(attempt => `${attempt.target}: ${attempt.reason}`).join('; '));
    const artifactArchive = join(directory, 'artifacts.tar');
    await transfer({ target, direction: 'download', localPath: artifactArchive, remotePath: posix.join(workspaceDir, 'artifacts.tar') });
    const importedStore = join(directory, 'store');
    await mkdir(importedStore);
    await runRuntimeArchiveCommand(['-xf', artifactArchive, '-C', importedStore], { env });
    await rm(artifactArchive, { force: true });
    const result = JSON.parse(await readFile(join(importedStore, 'result.json'), 'utf8'));
    const artifacts = await importRuntimeArtifactClosure({ sourceStackBaseDir: importedStore, stackBaseDir, artifacts: result.artifacts, target: request.target });
    return { ...result, artifacts, buildPlacement: { mode: 'target', target: target.name, workspaceDir, attempts } };
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      await cleanupRemoteArchives?.();
    }
  }
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
  // Tar is a development transport, not a new runtime packaging format.
  const { spawnSync } = await import('node:child_process');
  const archivePath = join(workspaceDir, 'source.tar');
  try {
    const extraction = spawnSync('tar', ['-xf', archivePath, '-C', repoDir], { stdio: 'inherit' });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) throw new Error('[build] worker source extraction failed.');
  } finally {
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
  const repoDir = await extractCapturedBuildSource({ workspaceDir, files: request.files });
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
      HAPPIER_STACK_PM_CACHE_BASE_DIR: join(workspaceDir, 'cache'),
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`[build] captured runtime build exited ${child.status}.`);
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
  const { buildRuntimeArtifactComponents } = await import('./build_stack_artifacts.mjs');
  const store = join(request.workspaceDir, 'store');
  const result = await buildRuntimeArtifactComponents({ rootDir: join(repoDir, 'apps/stack'), stackBaseDir: store,
    selection: request.selection, env: process.env, target: request.target,
    collectBuildSourceMetadataImpl: async () => sourceMetadata,
  });
  // Keep immutable provenance from the producer; directories are execution
  // placement, not a second source authority.
  result.sourceMetadata = request.sourceMetadata;
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'result.json'), JSON.stringify(result));
  const { packRuntimeArtifactClosure } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  await packRuntimeArtifactClosure({ stackBaseDir: store, artifacts: result.artifacts, target: request.target, archivePath: join(request.workspaceDir, 'artifacts.tar'), env: process.env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const worker = process.argv.slice(2).find(arg => arg.startsWith('--worker-request='));
  const captured = process.argv.slice(2).find(arg => arg.startsWith('--build-captured='));
  if (worker) await executeWorkerRequest(worker.slice('--worker-request='.length));
  else if (captured) await buildCapturedRequest(captured.slice('--build-captured='.length));
  else throw new Error('[build] runtime build worker requires an admitted request.');
}
