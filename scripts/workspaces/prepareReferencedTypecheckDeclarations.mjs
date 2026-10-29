import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { readReferencedUiTypecheckProjects, readTypecheckAmbientModules, readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { readWorkspaceBuildInputs, readWorkspaceComponentDependencyGraph } from './ensureWorkspacePackagesBuilt.mjs';
import { readBuildInputIdentity } from './buildInputConvergence.mjs';
import { runWorkspaceBuildAdmission, withWorkspaceBuildResources } from '../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';
import { resolveRemoteCommandPolicy } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';
import { requiresTypeScriptAdmission } from './resolveTypeScriptCliInvocation.mjs';
import { runCommand, exitWithCommandResult } from '../../apps/stack/scripts/utils/proc/proc.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { collectInternalWorkspaceDependencyNames } from './workspacePackageDependencies.mjs';
import { callerHoldsWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';
import { callerHoldsDependencyConsumption } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
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

async function declarationInputKey(pkg, dependencyKeys, env) {
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
    options: ['native-input-declarations', config, pkg.source.parsed.options, dependencyKeys] });
  return { key, config };
}

async function declarationOutputKey(pkg) {
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
  return await readBuildInputIdentity({ sourceDir: pkg.output, files });
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
  parsed.fileNames = readTypeScriptBuildInputFileNames(resolve(pkg.cache, 'incremental.tsbuildinfo'))
    .filter(file => typeof file === 'string' && /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file))
    .map(file => resolve(pkg.cache, file))
    .filter(file => {
      const path = relative(pkg.dir, file);
      return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
    });
  const expected = new Set(parsed.fileNames.flatMap(file => ts.getOutputFileNames(parsed, file, !ts.sys.useCaseSensitiveFileNames))
    .filter(file => /\.d\.[cm]?ts$/.test(file)).map(file => resolve(file)));
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
 * Existing package publication locks and dependency custody are acquired jointly
 * within the consumer's compilation envelope; warm consumers start no emitter
 * or package build. Publication custody ends before the consumer starts.
 */
export async function prepareWorkspaceTypecheckDeclarations(componentDir, {
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
    if (!callerHoldsDependencyConsumption(env) || locks.some(({ path }) =>
      !values.some(value => callerHoldsWorkspaceBundleLock(path, value)))) {
      throw new Error('Declaration preparation requires inherited package publication and dependency custody');
    }
  }
  const keys = new Map();
  const stale = [];
  const pending = [];
  for (const pkg of ordered) {
    const dependencies = collectInternalWorkspaceDependencyNames(pkg.manifest, pkg.name,
      { workspacePackageNames: keys.keys() }).map(name => keys.get(name));
    const { key, config } = await declarationInputKey(pkg, dependencies, env);
    keys.set(pkg.name, key);
    if (await declarationCacheCurrent(pkg, key)) continue;
    stale.push(pkg.name);
    if (!underLock) continue;
    await mkdir(pkg.cache, { recursive: true });
    const project = resolve(pkg.cache, 'tsconfig.json');
    await writeJsonAtomic(project, config);
    pending.push({ pkg, project, key, config });
  }
  if (pending.length) {
    // The input-key cache already selects only invalidated packages. Force
    // those projects so changed external declarations cannot be hidden by a
    // solution builder's root-file timestamp shortcut.
    const args = ['--build', ...pending.map(({ project }) => project), '--singleThreaded', '--force'];
    const invocation = resolveTypeScriptCliInvocation({ args, workspaceDir: repoDir, env,
      invocationKind: 'build', admissionClass });
    if (env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS === '1') process.stderr.write(`[typecheck-declarations] starting ${JSON.stringify({ at: new Date().toISOString(), declarations: pending.length })}\n`);
    const result = await runCommand(invocation.command, [...invocation.argsPrefix, ...args], { cwd: repoDir, env, signal, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) throw Object.assign(new Error('Dependency declaration emission failed'), { exitCode: result.status, signal: result.signal });
    for (const { pkg, key, project, config } of pending) {
      const outputs = await pruneObsoleteDeclarations(pkg, project, config);
      await writeJsonAtomic(resolve(pkg.cache, 'inputs.json'), { key, outputs, outputKey: await declarationOutputKey(pkg) });
    }
  }
  if (stale.length && !underLock) {
    if (withinTypecheckAdmission) {
      return await withWorkspaceBuildResources({ locks, dependencyInstallDir: repoDir, env, signal,
        typecheckDeclarationPhase: true }, async acquiredEnv => await prepareWorkspaceTypecheckDeclarations(componentDir, {
          env: acquiredEnv, underLock: true, admissionClass, signal,
        }));
    }
    const workerArgs = [fileURLToPath(import.meta.url), '--workspace-declarations', componentDir];
    const measure = process.platform === 'linux' && env.HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS === '1';
    const result = await runPreparation({ command: measure ? '/usr/bin/time' : process.execPath,
      args: measure ? ['-v', process.execPath, ...workerArgs] : workerArgs,
      locks,
      admissionClass, admissionRequired: requiresTypeScriptAdmission({ env }),
      dependencyInstallDir: repoDir, repoDir, cwd: repoDir, env, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal || result.status !== 0) throw Object.assign(new Error('Dependency declaration preparation failed'), { exitCode: result.status, signal: result.signal });
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
      declarations: result.declarations.length, elapsedMs: Math.round(performance.now() - started), at: new Date().toISOString() })}\n`);
    process.stderr.write(`[typescript] starting ${JSON.stringify({ at: new Date().toISOString() })}\n`);
    exitWithCommandResult(await runCommand(command, args, { cwd: process.cwd(), env: process.env,
      signal: cancellation.signal, stdio: 'inherit', ownedProcessGroup: true }));
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
    process.stderr.write(`[typecheck-declarations] ${JSON.stringify({ emitted: result.declarations, elapsedMs: result.elapsedMs })}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    exitWithCommandResult({ error: error.exitCode === undefined ? error : undefined, status: error.exitCode, signal: error.signal });
  }
}

function absoluteTypecheckPaths(project, configPath) {
  const base = project.parsed.options.baseUrl ?? project.parsed.options.pathsBasePath ?? dirname(configPath);
  return Object.fromEntries(Object.entries(project.parsed.options.paths ?? {})
    .map(([name, targets]) => [name, targets.map(target => resolve(base, target))]));
}

/** Native TS7 resolves redirected declarations at their producer source/options.
 * Prepare those strict references without rewriting declaration imports/globals.
 */
export async function prepareReferencedTypecheckDeclarations(projects, cwd, inventory) {
  const consumers = projects.filter(project => {
    const authored = project.authoredProject ?? project.project;
    return authored && basename(authored).startsWith('tsconfig.test') && basename(dirname(resolve(cwd, authored))) === 'cli';
  });
  if (!consumers.length) return [];
  const publicWorkspacePaths = Object.assign({}, ...consumers.map(consumer => {
    const configPath = resolve(cwd, consumer.project);
    return Object.fromEntries(Object.entries(absoluteTypecheckPaths(readTypecheckProject(configPath), configPath))
      .filter(([name]) => name.startsWith('@happier-dev/')));
  }));
  const producers = [];
  const redirects = new Map();
  const ambientInputs = new Map();
  const ambientModules = new Map();
  const modulesFor = file => {
    if (!ambientModules.has(file)) ambientModules.set(file, readTypecheckAmbientModules(file));
    return ambientModules.get(file);
  };
  const preparedOwners = new Set();
  for (const referencePath of readReferencedUiTypecheckProjects(consumers, cwd)) {
    const uiDir = dirname(referencePath);
    const uiProjects = ['foundation', 'core', 'source'].map(name => {
      const project = resolve(uiDir, `tsconfig.${name}.json`);
      const args = ['--singleThreaded', '--project', project];
      return { project, authoredProject: project, args, authoredArgs: args };
    });
    const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
    await prepareUiTypecheckProjects(uiProjects, cwd);
    producers.push(...uiProjects);
    redirects.set(referencePath, uiProjects.at(-1).project);
    preparedOwners.add(resolve(uiDir, 'tsconfig.json'));
  }
  for (const foreign of inventory?.foreignProjects ?? []) {
    if (preparedOwners.has(foreign.configPath)) continue;
    const ownerDir = dirname(foreign.configPath);
    const { cacheSuffix } = resolveTypeScriptCliInvocation({
      args: ['-p', foreign.configPath, '--noEmit', 'false', '--emitDeclarationOnly'], workspaceDir: cwd,
    });
    const cache = resolve(ownerDir, `node_modules/.cache/tsc${cacheSuffix}`);
    const project = resolve(cache, 'tsconfig.consumer-declarations.json');
    const source = readTypecheckProject(foreign.configPath);
    // Retain producer strictness and explicit aliases. Host workspace defaults
    // also apply here: author examples may have old installed SDK/UI copies.
    // Absolute paths preserve each alias's authored base in the cache config.
    await mkdir(cache, { recursive: true });
    await writeJsonAtomic(project, {
      extends: foreign.configPath,
      compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, noEmit: false,
        rootDir: resolve(ownerDir, '../..'), outDir: resolve(cache, 'consumer.declarations'),
        tsBuildInfoFile: resolve(cache, 'consumer.typecheck.tsbuildinfo'), disableSourceOfProjectReferenceRedirect: true,
        ...(Object.keys(publicWorkspacePaths).length ? {
          paths: { ...publicWorkspacePaths, ...absoluteTypecheckPaths(source, foreign.configPath) },
        } : {}) },
      files: foreign.files,
      include: [], exclude: [],
    });
    const args = ['--singleThreaded', '--project', project];
    producers.push({ project, authoredProject: project, args, authoredArgs: args });
    redirects.set(foreign.configPath, project);
    ambientInputs.set(foreign.configPath, foreign.ambientInputs ?? []);
    preparedOwners.add(foreign.configPath);
  }
  for (const consumer of consumers) {
    const configPath = resolve(cwd, consumer.project);
    const { config, parsed } = readTypecheckProject(configPath);
    const authored = resolve(cwd, consumer.authoredProject ?? consumer.project);
    const references = (config.references ?? []).map(reference => {
      const path = resolve(dirname(configPath), reference.path);
      return { ...reference, path: redirects.get(path) ?? path };
    });
    const roots = new Set(parsed.fileNames);
    const requiredOwners = new Set([...(inventory?.testContexts ?? [])].filter(([file]) => roots.has(file))
      .flatMap(([, context]) => context.owners.map(owner => owner.configPath)));
    for (const owner of requiredOwners) {
      const path = redirects.get(owner);
      if (path && !references.some(reference => reference.path === path)) references.push({ path });
    }
    const primaryInputs = inventory?.consumerPrimaryAmbientInputs?.get(authored) ?? [];
    const primaryNamespaces = new Set(primaryInputs
      .flatMap(file => modulesFor(file).namespaces));
    const primaryModules = new Set(primaryInputs.flatMap(file => modulesFor(file).moduleDefinitions));
    const consumerAmbientInputs = [...requiredOwners].flatMap(owner => {
      return (ambientInputs.get(owner) ?? []).filter(file => {
        // Reached ambient modules/type namespaces form declaration contracts,
        // including external augmentations, but
        // never replace consumer-owned primary bindings or runtime globals.
        const contribution = modulesFor(file);
        return !contribution.hasOtherGlobals
          && !contribution.namespaces.some(name => primaryNamespaces.has(name))
          && !contribution.moduleDefinitions.some(name => primaryModules.has(name))
          && contribution.modules.length + contribution.namespaces.length > 0;
      });
    });
    const files = [...new Set([...parsed.fileNames, ...consumerAmbientInputs])];
    const target = configPath === authored ? resolve(dirname(authored), 'node_modules/.cache/tsc', basename(authored)) : configPath;
    if (!redirects.size) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeJsonAtomic(target, configPath === authored
      ? { extends: authored, files, include: [], exclude: [], references }
      : { ...config, files, references });
    if (target !== configPath) {
      consumer.args = consumer.args.map((arg, index) => ['--project', '-p'].includes(consumer.args[index - 1])
        ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
      consumer.project = target;
    }
  }
  return producers;
}

