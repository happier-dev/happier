import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { packageNameOfSpecifier, readWorkspacePackages, SOURCE_CONDITION, workspaceSourceCompilerPaths } from '../../packages/cli-common/sourceRuntimeEntries.mjs';
import { typecheckCompilerOptions } from './resolveTypeScriptCliInvocation.mjs';
import { resolvePackageDeclarationTarget } from './packageBuildOutputTargets.mjs';

export function resolveTypecheckCacheDirectory(packageDir, cacheSuffix = '', purpose = 'tsc') {
  const repoRoot = coerceHappyMonorepoRootFromPath(packageDir);
  // Dependency generations replace package node_modules independently of an
  // admitted compilation. Its selected inputs and private outputs belong to
  // the existing workspace declaration cache, outside those installations.
  return repoRoot
    ? resolve(repoRoot, '.project/tmp/typecheck-declarations/projects', relative(repoRoot, packageDir), `${purpose}${cacheSuffix}`)
    : resolve(packageDir, `node_modules/.cache/tsc${cacheSuffix}`);
}

export async function readWorkspaceTypecheckSources(directory) {
  const repoRoot = coerceHappyMonorepoRootFromPath(directory);
  const packages = repoRoot ? await readWorkspacePackages(repoRoot) : new Map();
  const declarationPaths = {};
  for (const [name, { root, manifest }] of packages) {
    const exports = manifest.exports;
    const entries = Object.keys(exports ?? {}).some(key => key.startsWith('.'))
      ? Object.entries(exports) : [['.', exports ?? manifest.types]];
    for (const [key, value] of entries) {
      const target = resolvePackageDeclarationTarget(value);
      if (target) declarationPaths[key === '.' ? name : name + key.slice(1)] = [resolve(root, target)];
    }
  }
  return { repoRoot, packageNames: new Set(packages.keys()), paths: workspaceSourceCompilerPaths(packages),
    declarationPaths, packageRoots: new Map([...packages].map(([name, { root }]) => [name, root])) };
}

function workspaceDeclarationPaths(options, configPath, sources) {
  const base = options.baseUrl ?? options.pathsBasePath ?? dirname(configPath);
  const declarationTargets = new Set(Object.values(sources.declarationPaths ?? {}).flat());
  const declarationHost = {
    // The manifest owns declaration routes even before publication creates dist.
    fileExists: file => declarationTargets.has(resolve(file)),
    readFile: () => undefined,
  };
  return Object.fromEntries(Object.entries(options.paths ?? {})
    .filter(([name, targets]) => {
      if (!sources.packageNames.has(packageNameOfSpecifier(name)) || !targets.length) return false;
      if (targets.every(target => resolvePackageDeclarationTarget(target))) return true;
      const specifiers = Object.keys(sources.paths).filter(specifier => !specifier.includes('*') && matchesPath(specifier, name));
      return specifiers.length > 0 && specifiers.every(specifier => {
        const resolved = ts.resolveModuleName(specifier, configPath,
          { ...options, paths: { [name]: targets } }, declarationHost).resolvedModule;
        return resolved && resolvePackageDeclarationTarget(resolved.resolvedFileName);
      });
    })
    .map(([name, targets]) => [name, targets.map(target => resolve(base, target))]));
}

function matchesPath(name, pattern) {
  const wildcard = pattern.indexOf('*');
  return wildcard < 0 ? name === pattern
    : name.startsWith(pattern.slice(0, wildcard)) && name.endsWith(pattern.slice(wildcard + 1));
}

export function sourceTypecheckCompilerOptions(options, configPath, sources, { declarations: useDeclarations = false } = {}) {
  if (!sources.repoRoot) return {};
  const originalCache = resolve(dirname(configPath), 'node_modules/.cache');
  const cache = dirname(resolveTypecheckCacheDirectory(dirname(configPath)));
  const outputs = Object.fromEntries(['outDir', 'tsBuildInfoFile'].flatMap(key => {
    if (!options[key]) return [];
    const path = relative(originalCache, options[key]);
    return [[key, !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\')
      ? resolve(cache, path) : options[key]]];
  }));
  const base = options.baseUrl ?? options.pathsBasePath ?? dirname(configPath);
  const declarations = workspaceDeclarationPaths(options, configPath, sources);
  const configRelative = relative(sources.repoRoot, configPath);
  const repositoryProject = !isAbsolute(configRelative) && configRelative !== '..'
    && !configRelative.startsWith('../') && !configRelative.startsWith('..\\');
  const paths = { ...sources.paths };
  if (useDeclarations) {
    for (const [name, targets] of Object.entries(sources.declarationPaths ?? {})) {
      const root = sources.packageRoots.get(packageNameOfSpecifier(name));
      const ownerRelative = relative(root, configPath);
      // Self imports belong to this check, even if its previous dist is stale.
      if (isAbsolute(ownerRelative) || ownerRelative === '..' || ownerRelative.startsWith('../') || ownerRelative.startsWith('..\\')) {
        paths[name] = targets;
      }
    }
  }
  return {
    ...outputs,
    // Generated config placement must not choose a different ambient environment.
    typeRoots: ts.getEffectiveTypeRoots({ ...options, configFilePath: configPath }, ts.sys),
    customConditions: useDeclarations ? (options.customConditions ?? []).filter(condition => condition !== SOURCE_CONDITION)
      : [...new Set([...(options.customConditions ?? []), SOURCE_CONDITION])],
    paths: {
      ...Object.fromEntries(Object.entries(options.paths ?? {})
        .filter(([name]) => !sources.packageNames.has(packageNameOfSpecifier(name)))
        .map(([name, targets]) => [name, targets.map(target => resolve(base, target))])),
      ...Object.fromEntries(Object.entries(paths)
        .filter(([name]) => (options.paths?.[name] && !declarations[name])
          || !Object.keys(declarations).some(pattern => matchesPath(name, pattern)))),
      ...declarations,
    },
    // A generated incremental config otherwise infers its cache directory as
    // the root. Repository source checks include implementations across packages;
    // external scratch consumers without a root retain compiler inference.
    // Package builds keep their authored output boundary.
    ...(options.noEmit && (options.rootDir || repositoryProject) ? { rootDir: sources.repoRoot } : {}),
  };
}

/** Referenced source projects retain their compiler-owned declaration graph.
 * Other consumers use public package declarations prepared by the existing
 * publication owner. Authored identity remains available for diagnostics. */
export async function prepareWorkspaceSourceTypecheckProjects(projects, cwd) {
  const sources = await readWorkspaceTypecheckSources(cwd);
  if (!sources.repoRoot) return [];
  const failures = [];
  const preparedDeclarations = new Set();
  const preparedProjects = new Map();
  for (const project of projects) {
    const options = typecheckCompilerOptions(project.args, cwd);
    if (!options?.configFilePath) continue;
    const original = options.configFilePath;
    const useDeclarations = options.disableSourceOfProjectReferenceRedirect !== true;
    if ((useDeclarations && Object.keys(sources.declarationPaths).length)
      || Object.keys(workspaceDeclarationPaths(options, original, sources)).length) {
      const componentDir = dirname(resolve(cwd, project.authoredProject ?? original));
      if (!preparedDeclarations.has(componentDir)) {
        // Declaration consumers share publication/currentness rather than
        // silently accepting an earlier producer's output.
        const { prepareWorkspaceTypecheckDeclarations } = await import('./prepareReferencedTypecheckDeclarations.mjs');
        const result = await prepareWorkspaceTypecheckDeclarations(componentDir);
        if (!result.ok) failures.push({ component: componentDir, ...result.failure });
        preparedDeclarations.add(componentDir);
      }
    }
    const authored = ts.readConfigFile(original, ts.sys.readFile);
    if (authored.error) throw new Error(ts.flattenDiagnosticMessageText(authored.error.messageText, '\n'));
    const cache = /^tsc(?:\.tsrs)?$/u.test(basename(dirname(original)))
      || (project.authoredProject && original !== resolve(cwd, project.authoredProject))
      ? dirname(original) : resolveTypecheckCacheDirectory(dirname(original));
    const target = resolve(cache, `source-${basename(original)}`);
    preparedProjects.set(original, { target, config: {
      extends: original,
      compilerOptions: sourceTypecheckCompilerOptions(options, original, sources, { declarations: useDeclarations }),
      // Project references are not inherited through extends.
      references: (authored.config.references ?? []).map(reference => ({ ...reference,
        path: resolve(dirname(original), reference.path) })),
    } });
    let replaced = false;
    project.args = project.args.map((arg, index) => {
      if (['--project', '-p'].includes(project.args[index - 1])) { replaced = true; return target; }
      if (arg.startsWith('--project=')) { replaced = true; return `--project=${target}`; }
      return arg;
    });
    if (!replaced) project.args.push('--project', target);
    project.project = target;
  }
  for (const { target, config } of preparedProjects.values()) {
    await writeJsonAtomic(target, { ...config,
      references: config.references.map(reference => ({ ...reference,
        path: preparedProjects.get(reference.path)?.target ?? reference.path })),
    });
  }
  return failures;
}
