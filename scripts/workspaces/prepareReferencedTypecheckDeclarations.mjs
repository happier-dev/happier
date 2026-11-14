import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { readWorkspaceBuildInputs, readWorkspaceComponentDependencyGraph } from './ensureWorkspacePackagesBuilt.mjs';
import { BuildInputDriftError, readBuildInputDependencies, readBuildInputIdentity, readTerminalBuildFailure, serializeTerminalBuildFailure,
  withBuildInputDependencies, withSingleTrailingBuildPass } from './buildInputConvergence.mjs';
import { resolveDependencyInstallRoot, waitForDependencyRefresh } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { runWorkspaceBuildAdmission, withWorkspaceBuildResources } from '../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';
import { resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';
import { requiresTypeScriptAdmission } from './resolveTypeScriptCliInvocation.mjs';
import { runCommand, exitWithCommandResult } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { collectInternalWorkspaceDependencyNames } from './workspacePackageDependencies.mjs';
import { callerHoldsWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { resolvePackageBuildOutputTargetMatches, resolvePackageDeclarationTarget } from './packageBuildOutputTargets.mjs';
import { createDistTypeScriptProjectConfig, readTypeScriptBuildInputFileNames } from './buildTypeScriptPackageDist.mjs';

async function workspaceDeclarationInputs(componentDir) {
  const repoDir = coerceHappyMonorepoRootFromPath(componentDir);
  const graph = await readWorkspaceComponentDependencyGraph(componentDir);
  if (!graph) return { ordered: [], repoDir };
  const packages = new Map();
  for (const name of graph.closure) {
    const dir = graph.packageDirsByName.get(name);
    if (!relative(repoDir, dir).replaceAll('\\', '/').startsWith('packages/')) continue;
    const configPath = resolve(dir, 'tsconfig.json');
    if (!existsSync(configPath)) continue;
    const source = readTypecheckProject(configPath);
    if (!source.parsed.options.outDir || !source.parsed.options.declaration) continue;
    const cacheRoot = resolve(repoDir, '.project/tmp/typecheck-declarations');
    const cache = resolve(cacheRoot, 'projects', relative(repoDir, dir));
    // Consumers resolve the producer's public package identity. Private output
    // redirects make native inferred declarations unnameable (TS2742/TS2883).
    const output = source.parsed.options.outDir;
    const manifest = graph.packageJsonByDir.get(dir);
    const exports = manifest.exports;
    const entries = Object.keys(exports ?? {}).some(key => key.startsWith('.'))
      ? Object.entries(exports) : [['.', exports ?? manifest.types]];
    const targets = [];
    for (const [, value] of entries) {
      const target = resolvePackageDeclarationTarget(value);
      if (!target) continue;
      const suffix = relative(source.parsed.options.outDir, resolve(dir, target));
      if (suffix.startsWith('..')) continue;
      const path = resolve(output, suffix);
      targets.push(path);
    }
    if (targets.length) {
      packages.set(name, { name, dir, configPath, source, cache, output, targets, manifest });
    }
  }
  const ordered = [];
  const visited = new Set();
  const visit = name => {
    if (visited.has(name) || !packages.has(name)) return;
    visited.add(name);
    const pkg = packages.get(name);
    for (const dependency of collectInternalWorkspaceDependencyNames(pkg.manifest, name,
      { workspacePackageNames: packages.keys() })) visit(dependency);
    ordered.push(pkg);
  };
  for (const name of packages.keys()) visit(name);
  return { ordered, repoDir };
}

async function declarationInputKey(pkg, dependencyKeys, env, dependencyIdentity) {
  const config = createDistTypeScriptProjectConfig({ projectPath: pkg.configPath, compilerOptions: {
    noEmit: false, declaration: true, emitDeclarationOnly: true, noCheck: true,
    incremental: true, declarationMap: false, sourceMap: false,
    outDir: pkg.output, tsBuildInfoFile: resolve(pkg.cache, 'incremental.tsbuildinfo'),
    typeRoots: ts.getEffectiveTypeRoots(pkg.source.parsed.options, { getCurrentDirectory: () => pkg.dir }),
  } });
  const compiler = resolveTypeScriptCliInvocation({ invocationKind: 'build', env });
  const sourceInputs = readWorkspaceBuildInputs(pkg.dir, {
    excludeGeneratedPluginManifest: true, excludeGeneratedPluginArtifacts: true,
  }).map(file => resolve(pkg.dir, file));
  const files = [...sourceInputs, ...pkg.source.parsed.fileNames, pkg.configPath, resolve(pkg.dir, 'package.json'),
    compiler.compilerPath, resolve(dirname(compiler.compilerPath), '../package.json')];
  for (let dir = pkg.dir; dir !== dirname(dir); dir = dirname(dir)) {
    for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) if (existsSync(resolve(dir, name))) files.push(resolve(dir, name));
  }
  const key = await readBuildInputIdentity({ sourceDir: pkg.dir, files: files.map(file => relative(pkg.dir, file)),
    options: ['native-input-declarations', config, pkg.source.parsed.options, dependencyKeys, dependencyIdentity] });
  return { key, config };
}

/** Dependency cycles of `packages` (strongly connected components), dependencies first,
 * members sorted by name. A consumer may enter a cycle at any member, so nothing about
 * a member's key may depend on which member the walk reached first. */
function declarationDependencyGroups(packages) {
  const names = new Set(packages.map(pkg => pkg.name));
  const manifests = new Map(packages.map(pkg => [pkg.name, pkg.manifest]));
  const dependencies = name => collectInternalWorkspaceDependencyNames(manifests.get(name), name, { workspacePackageNames: names });
  const index = new Map();
  const low = new Map();
  const stack = [];
  const groups = [];
  const connect = name => {
    index.set(name, index.size);
    low.set(name, index.get(name));
    stack.push(name);
    for (const dependency of dependencies(name)) {
      if (!index.has(dependency)) {
        connect(dependency);
        low.set(name, Math.min(low.get(name), low.get(dependency)));
      } else if (stack.includes(dependency)) low.set(name, Math.min(low.get(name), index.get(dependency)));
    }
    if (low.get(name) !== index.get(name)) return;
    const group = [];
    let member;
    do { member = stack.pop(); group.push(member); } while (member !== name);
    groups.push(group.sort());
  };
  for (const name of [...names].sort()) if (!index.has(name)) connect(name);
  return { groups, dependencies };
}

async function declarationInputKeys(ordered, env, dependencyIdentity) {
  const byName = new Map(ordered.map(pkg => [pkg.name, pkg]));
  const { groups, dependencies } = declarationDependencyGroups(ordered);
  const keys = new Map();
  for (const group of groups) {
    const own = [];
    for (const name of group) {
      const external = dependencies(name).filter(dependency => !group.includes(dependency)).map(dependency => keys.get(dependency).key);
      own.push([name, await declarationInputKey(byName.get(name), external, env, dependencyIdentity)]);
    }
    if (group.length === 1) {
      keys.set(group[0], own[0][1]);
      continue;
    }
    // Every member of a cycle depends on every other member's inputs.
    const cycle = createHash('sha256').update(JSON.stringify(own.map(([name, { key }]) => [name, key]))).digest('hex');
    for (const [name, { config }] of own) keys.set(name, { key: `cycle:${cycle}:${name}`, config });
  }
  return keys;
}

async function declarationOutputFiles(pkg) {
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.d\.[cm]?ts$/.test(path)) files.push(relative(pkg.output, path));
    }
  };
  await visit(pkg.output);
  return files;
}

async function declarationOutputKey(pkg) {
  return await readBuildInputIdentity({ sourceDir: pkg.output, files: await declarationOutputFiles(pkg) });
}

function expectedDeclarationOutputs(parsed) {
  return new Set(parsed.fileNames.flatMap(file => ts.getOutputFileNames(parsed, file, !ts.sys.useCaseSensitiveFileNames))
    .filter(file => /\.d\.[cm]?ts$/.test(file)).map(file => resolve(file)));
}

function declarationImplementationInputs(tsBuildInfoFile, inputRoot) {
  return readTypeScriptBuildInputFileNames(tsBuildInfoFile)
    .filter(file => typeof file === 'string' && /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
    .map(file => resolve(dirname(tsBuildInfoFile), file))
    .filter(file => {
      const path = relative(inputRoot, file);
      return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
    });
}

async function discardSpannedDeclarations(pending) {
  for (const { pkg } of pending) {
    // Publication owns declarations in this package's outDir. Preserve JavaScript,
    // build stamps and other package outputs when discarding this emitted pass.
    for (const file of await declarationOutputFiles(pkg)) await rm(resolve(pkg.output, file), { force: true });
    await rm(resolve(pkg.cache, 'incremental.tsbuildinfo'), { force: true });
    await rm(resolve(pkg.cache, 'inputs.json'), { force: true });
  }
}

async function declarationCacheCurrent(pkg, key) {
  try {
    const record = JSON.parse(readFileSync(resolve(pkg.cache, 'inputs.json'), 'utf8'));
    return record.key === key && Array.isArray(record.outputs)
      && record.outputs.every(file => existsSync(resolve(pkg.output, file)))
      && pkg.targets.every(target => resolvePackageBuildOutputTargetMatches({ packageDir: pkg.dir,
        outputDir: pkg.output, target }).length > 0)
      && existsSync(resolve(pkg.cache, 'incremental.tsbuildinfo'))
      // Package publication can replace canonical dist independently of this
      // emitter. Reuse the existing digest owner to detect changed/extra .d.ts.
      && record.outputKey === await declarationOutputKey(pkg);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function pruneObsoleteDeclarations(pkg, project, config) {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(project), undefined, project);
  // Root membership omits transitively imported implementation files. The
  // native emitter's completed input inventory is the output authority.
  parsed.fileNames = declarationImplementationInputs(resolve(pkg.cache, 'incremental.tsbuildinfo'), pkg.dir);
  const expected = expectedDeclarationOutputs(parsed);
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.d\.[cm]?ts$/.test(path) && !expected.has(path)) await rm(path);
    }
  };
  await visit(pkg.output);
  return [...expected].map(file => relative(pkg.output, file));
}

/** Derive canonical declarations without touching JavaScript or build stamps.
 * Existing package publication locks are acquired jointly
 * within the consumer's compilation envelope; warm consumers start no emitter
 * or package build. Publication custody ends before the consumer starts.
 */
export async function prepareWorkspaceTypecheckDeclarations(componentDir, options = {}) {
  await waitForDependencyRefresh({ installDir: resolveDependencyInstallRoot(componentDir), env: options.env, signal: options.signal });
  try {
    if (options.underLock) return await prepareWorkspaceTypecheckDeclarationsPass(componentDir, options);
    // A retry starts outside publication/admission scopes. Child emitters report
    // drift to this phase owner instead of starting a second convergence loop.
    return await withSingleTrailingBuildPass({ run: () => prepareWorkspaceTypecheckDeclarationsPass(componentDir, options) });
  } catch (error) {
    if (error.code !== 'TYPECHECK_DECLARATION_EMIT_FAILED') throw error;
    return { ok: false, failure: error.failure };
  }
}

async function prepareWorkspaceTypecheckDeclarationsPass(componentDir, {
  env = process.env, runPreparation = runWorkspaceBuildAdmission, underLock = false,
  withinTypecheckAdmission = false, signal,
  admissionClass = resolveRemoteCommandPolicy(['node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'],
    { cwd: componentDir, repoRoot: coerceHappyMonorepoRootFromPath(componentDir) ?? componentDir }).heavyClass,
} = {}) {
  const started = performance.now();
  const { ordered, repoDir } = await workspaceDeclarationInputs(componentDir);
  const locks = ordered.map(pkg => ({ path: resolveWorkspacePackageBuildLockPath(pkg.dir, pkg.manifest) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (underLock) {
    const leases = JSON.parse(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_LEASES || '[]');
    const values = [env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, ...leases];
    if (locks.some(({ path }) =>
      !values.some(value => callerHoldsWorkspaceBundleLock(path, value)))) {
      throw new Error('Declaration preparation requires inherited package publication custody');
    }
  }
  const pending = [];
  const prepare = async publication => {
    const dependencyState = publication?.state ?? await readBuildInputDependencies({ sourceDir: repoDir, env });
    const keys = await declarationInputKeys(ordered, env, dependencyState.identity);
    const stale = [];
    for (const pkg of ordered) {
      const { key, config } = keys.get(pkg.name);
      if (await declarationCacheCurrent(pkg, key)) continue;
      stale.push(pkg.name);
      if (!underLock) continue;
      await mkdir(pkg.cache, { recursive: true });
      const project = resolve(pkg.cache, 'tsconfig.json');
      await writeJsonAtomic(project, config);
      pending.push({ pkg, project, key, config });
    }
    if (pending.length) {
      // Force invalidated projects so changed external declarations cannot be
      // hidden by a solution builder's root-file timestamp shortcut.
      const args = ['--build', ...pending.map(({ project }) => project), '--singleThreaded', '--force'];
      const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: repoDir, env,
        invocationKind: 'build', admissionClass });
      if (env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS === '1') process.stderr.write(`[typecheck-declarations] starting ${JSON.stringify({ at: new Date().toISOString(), declarations: pending.length })}\n`);
      const result = await runCommand(invocation.command, [...invocation.argsPrefix, ...args], { cwd: repoDir, env, signal, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.signal) throw Object.assign(new Error('Dependency declaration emission interrupted'), { signal: result.signal });
      if (result.status !== 0) throw Object.assign(new Error('Dependency declaration emission failed'), {
        code: 'TYPECHECK_DECLARATION_EMIT_FAILED',
        failure: { step: 'declaration-emission', status: result.status, projects: pending.map(({ pkg }) => pkg.name) },
      });
      for (const { pkg, key, project, config } of pending) {
        const outputs = await pruneObsoleteDeclarations(pkg, project, config);
        const outputKey = await declarationOutputKey(pkg);
        await publication.assertCurrent();
        await writeJsonAtomic(resolve(pkg.cache, 'inputs.json'), { key, outputs, outputKey });
      }
    }
    return stale;
  };
  let stale;
  try {
    stale = underLock
      ? await withBuildInputDependencies({ sourceDir: repoDir, env, signal }, (_env, publication) => prepare(publication))
      : await prepare();
  } catch (error) {
    if (error instanceof BuildInputDriftError) await discardSpannedDeclarations(pending);
    throw error;
  }
  if (stale.length && !underLock) {
    if (withinTypecheckAdmission) {
      return await withWorkspaceBuildResources({ locks, env, signal,
        typecheckDeclarationPhase: true }, async acquiredEnv => await prepareWorkspaceTypecheckDeclarations(componentDir, {
          env: acquiredEnv, underLock: true, admissionClass, signal,
        }));
    }
    const resultDir = await mkdtemp(resolve(tmpdir(), 'happier-declaration-result-'));
    const resultPath = resolve(resultDir, 'result.json');
    try {
      const workerArgs = [fileURLToPath(import.meta.url), '--workspace-declarations', componentDir, resultPath];
      const measure = process.platform === 'linux' && env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS === '1';
      const result = await runPreparation({ command: measure ? '/usr/bin/time' : process.execPath,
        args: measure ? ['-v', process.execPath, ...workerArgs] : workerArgs,
        locks, admissionClass, admissionRequired: requiresTypeScriptAdmission({ env }),
        repoDir, cwd: repoDir, env, signal, stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.signal || result.status !== 0) {
        if (!result.signal) {
          const record = await readFile(resultPath, 'utf8').then(JSON.parse).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          const failure = readTerminalBuildFailure(record);
          if (failure) throw failure;
          if (record?.ok === false && record.failure?.step === 'declaration-emission') return record;
        }
        throw Object.assign(new Error('Dependency declaration preparation failed'), { exitCode: result.status, signal: result.signal });
      }
    } finally { await rm(resultDir, { recursive: true, force: true }); }
  }
  return { ok: true, built: [], declarations: stale, elapsedMs: Math.round(performance.now() - started) };
}

if (process.argv[2] === '--prepare-for-typecheck' && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [componentDir, admissionClass, delimiter, command, ...args] = process.argv.slice(3);
  if (delimiter !== '--' || !command) throw new Error('Invalid admitted typecheck invocation');
  const cancellation = new AbortController();
  let cancelledSignal;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    cancelledSignal ??= signal;
    cancellation.abort();
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const started = performance.now();
    process.stderr.write(`[typecheck-preparation] starting ${JSON.stringify({ component: componentDir,
      admissionClass, at: new Date().toISOString() })}\n`);
    const result = await prepareWorkspaceTypecheckDeclarations(resolve(componentDir), {
      admissionClass, withinTypecheckAdmission: true, signal: cancellation.signal,
    });
    cancellation.signal.throwIfAborted();
    process.stderr.write(`[typecheck-preparation] ${JSON.stringify({ component: componentDir, packageBuilds: 0,
      ...(result.ok ? { declarations: result.declarations.length } : { failure: result.failure }),
      elapsedMs: Math.round(performance.now() - started), at: new Date().toISOString() })}\n`);
    process.stderr.write(`[typescript] starting ${JSON.stringify({ at: new Date().toISOString() })}\n`);
    const checked = await runCommand(command, args, { cwd: process.cwd(), env: process.env,
      signal: cancellation.signal, stdio: 'inherit', ownedProcessGroup: true });
    exitWithCommandResult(!result.ok && checked.status === 0 ? { ...checked, status: result.failure.status } : checked);
  } catch (error) {
    if (!cancelledSignal) process.stderr.write(`[typecheck-preparation] failed ${error.stack ?? error}\n`);
    exitWithCommandResult({ error: !cancelledSignal && error.exitCode === undefined ? error : undefined,
      status: error.exitCode, signal: cancelledSignal ?? error.signal });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (process.argv[2] === '--workspace-declarations' && process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await prepareWorkspaceTypecheckDeclarations(resolve(process.argv[3]), { underLock: true });
    if (!result.ok) {
      if (process.argv[4]) await writeJsonAtomic(process.argv[4], result);
      exitWithCommandResult({ status: result.failure.status, signal: null });
    }
    process.stderr.write(`[typecheck-declarations] ${JSON.stringify({ emitted: result.declarations, elapsedMs: result.elapsedMs })}\n`);
  } catch (error) {
    const failure = serializeTerminalBuildFailure(error, { includeRetryableDrift: true });
    if (failure && process.argv[4]) await writeJsonAtomic(process.argv[4], failure);
    process.stderr.write(`${error.stack ?? error}\n`);
    exitWithCommandResult({ error: error.exitCode === undefined ? error : undefined, status: error.exitCode, signal: error.signal });
  }
}

export { prepareReferencedTypecheckDeclarations, orderTypecheckProjects } from './prepareTypecheckSourceReferences.mjs';

