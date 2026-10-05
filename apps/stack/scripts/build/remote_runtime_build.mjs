import { lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKER_ENTRY = 'apps/stack/scripts/build/remote_runtime_build.mjs';
const BUILD_ENV_KEYS = ['HAPPIER_CLI_BUN_EXTERNALS', 'HAPPIER_SERVER_BUN_EXTERNALS', 'HAPPIER_BUILD_DB_PROVIDERS', 'HAPPY_BUILD_DB_PROVIDERS', 'HAPPIER_SERVER_REQUIRE_IROH_NATIVE', 'HAPPIER_STACK_EXPO_CLEAR_CACHE'];

export function resolveRuntimeBuildPlacement({ config, hostTarget, observedTarget }) {
  const placement = config?.runtimePlacement?.build;
  if (placement?.mode !== 'prefer-target') return { target: null, reason: null };
  const target = config.targets.find(candidate => candidate.name === placement.target);
  if (!target || target.platform !== 'posix') return { target: null, reason: 'build worker requires a POSIX target (WSL is supported)' };
  if (!observedTarget?.ok) return { target: null, reason: 'build worker is unavailable' };
  if (observedTarget.runtimeTarget?.platform !== hostTarget.platform || observedTarget.runtimeTarget?.arch !== hostTarget.arch) {
    return { target: null, reason: `build worker target does not match ${hostTarget.platform}/${hostTarget.arch}` };
  }
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
  const { isDevRuntimeReloadIgnoredPath } = await import('../utils/dev/watchSignature.mjs');
  const { runCapture } = await import('../utils/proc/proc.mjs');
  const { runRuntimeArchiveCommand } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const { withSingleTrailingBuildPass, BuildInputDriftError } = await import('../../../../scripts/workspaces/buildInputConvergence.mjs');
  return await withSingleTrailingBuildPass({ run: async () => {
    const sourceMetadata = await collectBuildSourceMetadata({ rootDir, env });
    const expectedInputs = await collectRuntimeComponentSourceFingerprints({ selection, sourceMetadata });
    const listed = await runCapture('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: sourceMetadata.repoDir });
    const sourcePaths = new Set();
    for (const raw of new Set(listed.split('\0').filter(Boolean))) {
      const path = sourceFilePath(raw);
      const info = await lstat(join(sourceMetadata.repoDir, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info?.isFile() || info?.isSymbolicLink()) sourcePaths.add(path);
    }
    // Git excludes some generated compiler inputs. Capture the canonical
    // component input closure too, including empty-directory membership.
    const visitInput = async absolute => {
      if (isDevRuntimeReloadIgnoredPath(absolute)) return;
      const info = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) return;
      sourcePaths.add(sourceFilePath(relative(sourceMetadata.repoDir, absolute)));
      if (info.isDirectory()) for (const name of await readdir(absolute)) await visitInput(join(absolute, name));
    };
    for (const component of ['web', 'server', 'daemon']) if (selection.components[component]) {
      for (const path of resolveRuntimeComponentSourcePaths({ component, sourceMetadata })) await visitInput(path);
    }
    const files = [...sourcePaths].sort();
    const listPath = join(directory, 'source-files');
    await writeFile(listPath, files.join('\0') + '\0');
    const archivePath = join(directory, 'source.tar');
    await runRuntimeArchiveCommand(['-cf', archivePath, '--no-recursion', '--null', '-T', listPath], { cwd: sourceMetadata.repoDir, env });
    const after = await collectRuntimeComponentSourceFingerprints({ selection, sourceMetadata });
    if (JSON.stringify(after) !== JSON.stringify(expectedInputs)) throw new BuildInputDriftError('[build] consumed inputs changed during source transfer capture.');
    return { sourceMetadata, expectedInputs, files, archivePath };
  } });
}

export async function buildRuntimeArtifactComponentsAtPlacement({ rootDir, stackBaseDir, selection, env, retentionPolicy, buildLocal, transport = {} }) {
  const { loadDevTargetsConfig } = await import('../utils/dev_targets/config.mjs');
  const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json'), env });
  const configured = config.runtimePlacement?.build;
  if (configured?.mode !== 'prefer-target') return await buildLocal({ rootDir, stackBaseDir, selection, env, retentionPolicy });
  const target = config.targets.find(candidate => candidate.name === configured.target);
  const { runDevTargetsDoctor } = await import('../utils/dev_targets/doctor.mjs');
  const { runDevTargetCommand, syncDevTarget } = await import('../utils/dev_targets/executor.mjs');
  const { transferRuntimeFile, runRuntimeArchiveCommand, importRuntimeArtifactClosure } = await import('../utils/dev_targets/runtime_artifact_transfer.mjs');
  const runCommand = transport.runCommand ?? runDevTargetCommand;
  const transfer = transport.transfer ?? transferRuntimeFile;
  const fallback = async reason => {
    process.stderr.write(`[build] ${configured.target}: local runtime build fallback: ${reason}.\n`);
    const result = await buildLocal({ rootDir, stackBaseDir, selection, env, retentionPolicy });
    return { ...result, buildPlacement: { mode: 'local', fallbackFrom: configured.target, reason } };
  };
  let resolved;
  let preflightError = null;
  try {
    const doctor = await runDevTargetsDoctor({ targets: target ? [target] : [], env }, transport.doctorDependencies);
    resolved = resolveRuntimeBuildPlacement({ config, hostTarget: { platform: process.platform, arch: process.arch }, observedTarget: doctor.targets[0] });
    if (resolved.target) await syncDevTarget({ target, stackBaseDir, env }, transport.syncDependencies);
  } catch (error) {
    preflightError = error instanceof Error ? error.message : String(error);
  }
  if (preflightError || !resolved?.target) return await fallback(preflightError || resolved.reason);
  const directory = await mkdtemp(join(tmpdir(), 'happier-runtime-build-'));
  // This workspace is outside the continuously synchronized source replica.
  const workspaceDir = posix.join(target.cliHomeDir.replaceAll('\\', '/'), 'runtime-build', String(stackBaseDir).replaceAll('\\', '/').split('/').at(-1));
  const command = async commandArgs => await runCommand({ target, stackBaseDir, commandArgs, syncAlreadyVerified: true, dependencyAdmission: 'skip', workspacePreparation: 'skip', provenance: 'skip', env });
  try {
    const captured = await captureBuildSource({ rootDir, selection, env, directory });
    const { WORKSPACE_BUILD_MODE_ENV } = await import('../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
    const requestPath = join(directory, 'request.json');
    const request = { ...captured, archivePath: undefined, selection, workspaceDir,
      target: { platform: process.platform, arch: process.arch },
      // Apply the component owner's existing runtime policy to bootstrap too,
      // rather than introducing a strict preparation phase before QA admission.
      env: { ...Object.fromEntries(BUILD_ENV_KEYS.filter(key => env[key] != null).map(key => [key, env[key]])), [WORKSPACE_BUILD_MODE_ENV]: 'qa-runtime' },
    };
    await writeFile(requestPath, JSON.stringify(request));
    let preparationError = null;
    try {
      const prepared = await command(['node', '-e', 'require("node:fs").mkdirSync(process.argv[1],{recursive:true})', workspaceDir]);
      if (prepared.code !== 0) throw new Error(`workspace preflight exited ${prepared.code}`);
      await transfer({ target, direction: 'upload', localPath: captured.archivePath, remotePath: posix.join(workspaceDir, 'source.tar') });
      await transfer({ target, direction: 'upload', localPath: requestPath, remotePath: posix.join(workspaceDir, 'request.json') });
    } catch (error) {
      preparationError = error instanceof Error ? error.message : String(error);
    }
    if (preparationError) return await fallback(preparationError);
    process.stderr.write(`[build] runtime preparation and compilation on ${target.name}: ${workspaceDir}/repo (${request.target.platform}/${request.target.arch}).\n`);
    const built = await command(['node', WORKER_ENTRY, `--worker-request=${posix.join(workspaceDir, 'request.json')}`]);
    // A started command's failure is authoritative. Never replay compilation on
    // the VM after a compile failure or a lost result connection.
    if (built.code !== 0) throw new Error(`[build] ${target.name} runtime build failed (exit ${built.code}); no local replay.`);
    const artifactArchive = join(directory, 'artifacts.tar');
    await transfer({ target, direction: 'download', localPath: artifactArchive, remotePath: posix.join(workspaceDir, 'artifacts.tar') });
    const importedStore = join(directory, 'store');
    await mkdir(importedStore);
    await runRuntimeArchiveCommand(['-xf', artifactArchive, '-C', importedStore], { env });
    const result = JSON.parse(await readFile(join(importedStore, 'result.json'), 'utf8'));
    const artifacts = await importRuntimeArtifactClosure({ sourceStackBaseDir: importedStore, stackBaseDir, artifacts: result.artifacts, target: request.target });
    return { ...result, artifacts, buildPlacement: { mode: 'target', target: target.name, workspaceDir } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executeWorkerRequest(requestPath) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  if (request.target.platform !== process.platform || request.target.arch !== process.arch) throw new Error('[build] runtime worker does not match the requested artifact target.');
  const workspaceDir = resolve(request.workspaceDir);
  const repoDir = join(workspaceDir, 'repo');
  const sourceFilesPath = join(workspaceDir, 'source-files.json');
  const files = request.files.map(sourceFilePath);
  const nextFiles = new Set(files);
  const previousFiles = JSON.parse(await readFile(sourceFilesPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; }));
  await mkdir(repoDir, { recursive: true });
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
  const extraction = spawnSync('tar', ['-xf', join(workspaceDir, 'source.tar'), '-C', repoDir], { stdio: 'inherit' });
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0) throw new Error('[build] worker source extraction failed.');
  await writeFile(sourceFilesPath, JSON.stringify(files));
  // Check transfer inputs before install/prebuild generators legitimately
  // update derived inputs. This is the existing source identity owner; only the
  // subsequent build process loads and executes the captured checkout graph.
  const { collectRuntimeComponentSourceFingerprints } = await import('./runtime_artifact_identity.mjs');
  const extractedInputs = await collectRuntimeComponentSourceFingerprints({
    selection: request.selection, sourceMetadata: { ...request.sourceMetadata, repoDir }, identityRepoDir: request.sourceMetadata.repoDir,
  });
  if (JSON.stringify(extractedInputs) !== JSON.stringify(request.expectedInputs)) throw new Error('[build] captured worker inputs differ from the admitted producer inputs.');
  // Load the captured owner, rather than the moving mirror's module graph.
  const child = spawnSync(process.execPath, [join(repoDir, WORKER_ENTRY), `--build-captured=${requestPath}`], {
    cwd: repoDir, stdio: 'inherit', env: { ...process.env, ...request.env,
      HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_RUNTIME_IDENTITY_REPO_DIR: request.sourceMetadata.repoDir,
      HAPPIER_STACK_PM_CACHE_BASE_DIR: join(workspaceDir, 'cache'),
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`[build] captured runtime build exited ${child.status}.`);
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
    selection: request.selection, env: process.env,
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
