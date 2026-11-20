import { mkdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { coerceHappyMonorepoRootFromPath } from '../../apps/stack/scripts/utils/paths/paths.mjs';
import { readReferencedUiTypecheckProjects, readTypecheckAmbientModules, readTypecheckProject } from './deriveTypecheckProjects.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { resolveTypecheckCacheDirectory } from './workspaceSourceTypecheck.mjs';

export function orderTypecheckProjects(projects, cwd = process.cwd()) {
  const byPath = new Map(projects.map(project => [resolve(cwd, project.project), project]));
  const visited = new Set();
  const active = [];
  const ordered = [];
  const visit = project => {
    if (visited.has(project)) return;
    if (active.includes(project)) {
      // Name every project in the loop with its authored owner: the code alone
      // leaves the caller nothing to attribute the edge to.
      const cycle = [...active.slice(active.indexOf(project)), project].map(member => {
        const generated = relative(cwd, resolve(cwd, member.project));
        const authored = member.authoredProject && relative(cwd, resolve(cwd, member.authoredProject));
        return authored && authored !== generated ? `${generated} (${authored})` : generated;
      });
      throw Object.assign(new Error(`TypeScript project reference cycle: ${cycle.join(' -> ')}`),
        { code: 'TYPECHECK_REFERENCE_CYCLE', cycle });
    }
    active.push(project);
    const path = resolve(cwd, project.project);
    for (const reference of readTypecheckProject(path).config.references ?? []) {
      const dependency = byPath.get(resolve(dirname(path), reference.path));
      if (dependency) visit(dependency);
    }
    active.pop();
    visited.add(project);
    ordered.push(project);
  };
  for (const project of projects) visit(project);
  return ordered;
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
  if (!consumers.length && !inventory?.foreignProjects?.length) return [];
  const workspaceRoot = coerceHappyMonorepoRootFromPath(cwd);
  const publicWorkspacePaths = Object.assign({}, ...consumers.map(consumer => {
    const configPath = resolve(cwd, consumer.project);
    return Object.fromEntries(Object.entries(absoluteTypecheckPaths(readTypecheckProject(configPath), configPath))
      .filter(([name]) => name.startsWith('@happier-dev/')));
  }));
  const producers = [];
  const redirects = new Map();
  const ambientInputs = new Map();
  const ambientDependencies = new Map();
  const ambientModules = new Map();
  const modulesFor = file => {
    if (!ambientModules.has(file)) ambientModules.set(file, readTypecheckAmbientModules(file));
    return ambientModules.get(file);
  };
  const groups = inventory ? [{ inventory, projects }] : [];
  const preparedOwners = new Set(inventory ? [inventory.baseline.configPath] : []);
  for (const referencePath of readReferencedUiTypecheckProjects(consumers, cwd)) {
    const uiDir = dirname(referencePath);
    const uiProjects = ['foundation', 'core', 'source'].map(name => {
      const project = resolve(uiDir, `tsconfig.${name}.json`);
      const args = ['--singleThreaded', '--project', project];
      return { project, authoredProject: project, args, authoredArgs: args };
    });
    const { prepareUiTypecheckProjects } = await import('../../apps/ui/scripts/deriveTypecheckProjects.mjs');
    const uiInventory = await prepareUiTypecheckProjects(uiProjects, cwd);
    groups.push({ inventory: uiInventory, projects: uiProjects });
    producers.push(...uiProjects);
    redirects.set(referencePath, uiProjects.at(-1).project);
    preparedOwners.add(resolve(uiDir, 'tsconfig.json'));
  }
  const foreignProjects = new Map();
  for (const group of groups) for (const foreign of group.inventory.foreignProjects) {
    const prior = foreignProjects.get(foreign.configPath);
    foreignProjects.set(foreign.configPath, prior ? { ...foreign,
      files: [...new Set([...prior.files, ...foreign.files])],
      references: [...prior.references, ...foreign.references],
      ambientInputs: [...new Set([...prior.ambientInputs, ...foreign.ambientInputs])],
      ambientDependencies: new Map([...prior.ambientDependencies ?? [], ...foreign.ambientDependencies ?? []]),
    } : foreign);
  }
  const memberships = new Map();
  for (const group of groups) {
    const files = new Map();
    for (const project of group.projects) {
      const { parsed } = readTypecheckProject(project.project);
      if (parsed.options.noEmit) continue;
      for (const file of parsed.fileNames) if (!files.has(file)) files.set(file, project.project);
    }
    memberships.set(group.inventory.baseline.configPath, files);
  }
  for (const foreign of foreignProjects.values()) {
    if (preparedOwners.has(foreign.configPath)) continue;
    const ownerDir = dirname(foreign.configPath);
    const { cacheSuffix } = resolveTypeScriptCliInvocation({
      args: ['-p', foreign.configPath, '--noEmit', 'false', '--emitDeclarationOnly'], workspaceDir: cwd,
    });
    const cache = resolveTypecheckCacheDirectory(ownerDir, cacheSuffix, 'consumer');
    const project = resolve(cache, 'tsconfig.consumer-declarations.json');
    const source = readTypecheckProject(foreign.configPath);
    // Retain producer strictness and explicit aliases. Host workspace defaults
    // also apply here: author examples may have old installed SDK/UI copies.
    // Absolute paths preserve each alias's authored base in the cache config.
    await mkdir(cache, { recursive: true });
    await writeJsonAtomic(project, {
      extends: foreign.configPath,
      compilerOptions: { composite: true, declaration: true, emitDeclarationOnly: true, noEmit: false,
        typeRoots: ts.getEffectiveTypeRoots(source.parsed.options, ts.sys),
        rootDir: workspaceRoot ?? resolve(ownerDir, '../..'), outDir: resolve(cache, 'consumer.declarations'),
        tsBuildInfoFile: resolve(cache, 'consumer.typecheck.tsbuildinfo'), disableSourceOfProjectReferenceRedirect: true,
        ...(Object.keys(publicWorkspacePaths).length ? {
          paths: { ...publicWorkspacePaths, ...absoluteTypecheckPaths(source, foreign.configPath) },
        } : {}) },
      files: foreign.files,
      include: [], exclude: [],
    });
    const args = ['--singleThreaded', '--project', project];
    producers.push({ project, authoredProject: foreign.configPath, args, authoredArgs: args });
    redirects.set(foreign.configPath, project);
    memberships.set(foreign.configPath, new Map(foreign.files.map(file => [file, project])));
    ambientInputs.set(foreign.configPath, foreign.ambientInputs ?? []);
    ambientDependencies.set(foreign.configPath, foreign.ambientDependencies ?? new Map());
    preparedOwners.add(foreign.configPath);
  }
  const referencePath = reference => memberships.get(reference.configPath)?.get(reference.file);
  const writeReferences = async (project, required) => {
    const { config, parsed } = readTypecheckProject(project);
    // An authored declaration is compiled as-is by its consumer; no producer
    // emits it. It needs a reference only when a producer program owns it (for
    // its imported implementations), as a UI testkit importing the CLI's
    // build-owned projector .d.mts does not.
    const owned = required.filter(reference => referencePath(reference) || !/\.d\.[cm]?ts$/u.test(reference.file));
    const paths = [...new Set(owned.map(referencePath))];
    if (paths.some(path => !path)) throw new Error(`Missing TypeScript declaration owner for ${owned.find(reference => !referencePath(reference)).file}`);
    const references = [...new Set([...(config.references ?? []).map(reference => resolve(dirname(project), reference.path)), ...paths])]
      .filter(path => path !== project).map(path => ({ path }));
    const importedJsx = paths.some(path => readTypecheckProject(path).parsed.fileNames.some(file => file.endsWith('.tsx')));
    // Native reference resolution still classifies the original .tsx specifier
    // before redirecting to its declaration. The consumer contains no producer
    // implementation; preserve enables that import without choosing its JSX ABI.
    const compilerOptions = importedJsx && parsed.options.jsx === undefined
      ? { ...config.compilerOptions, jsx: 'preserve' } : config.compilerOptions;
    await writeJsonAtomic(project, { ...config, compilerOptions, references });
  };
  for (const foreign of foreignProjects.values()) {
    if (memberships.has(foreign.configPath) && redirects.has(foreign.configPath)
      && !groups.some(group => group.inventory.baseline.configPath === foreign.configPath)) {
      await writeReferences(redirects.get(foreign.configPath), foreign.references);
    }
  }
  for (const group of groups) for (const [project, required] of group.inventory.sourceReferences ?? []) {
    await writeReferences(project, required);
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
    const primaryInputSet = new Set(primaryInputs);
    const primaryNamespaces = new Set(primaryInputs
      .flatMap(file => modulesFor(file).namespaces));
    const primaryModules = new Set(primaryInputs.flatMap(file => modulesFor(file).moduleDefinitions));
    const consumerAmbientInputs = [...requiredOwners].flatMap(owner => {
      const inputs = ambientInputs.get(owner) ?? [];
      const blocked = new Set(inputs.filter(file => {
        if (primaryInputSet.has(file)) return false;
        // Reached ambient modules/type namespaces form declaration contracts,
        // including external augmentations, but
        // never replace consumer-owned primary bindings or runtime globals.
        const contribution = modulesFor(file);
        return contribution.hasOtherGlobals
          || contribution.namespaces.some(name => primaryNamespaces.has(name))
          || contribution.moduleDefinitions.some(name => primaryModules.has(name));
      }));
      // Module-only declarations can import a platform barrel which brings its
      // globals back in. Propagate exclusions over the owner's existing graph
      // once, including cycles, rather than copying that indirect ingress.
      const importers = new Map();
      for (const [file, dependencies] of ambientDependencies.get(owner) ?? []) {
        for (const dependency of dependencies) {
          if (!importers.has(dependency)) importers.set(dependency, []);
          importers.get(dependency).push(file);
        }
      }
      for (const file of blocked) {
        for (const importer of importers.get(file) ?? []) blocked.add(importer);
      }
      return inputs.filter(file => {
        const contribution = modulesFor(file);
        return !blocked.has(file) && contribution.modules.length + contribution.namespaces.length > 0;
      });
    });
    const files = [...new Set([...parsed.fileNames, ...consumerAmbientInputs])];
    const target = configPath === authored ? resolve(resolveTypecheckCacheDirectory(dirname(authored)), basename(authored)) : configPath;
    if (!redirects.size) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeJsonAtomic(target, configPath === authored
      ? { extends: authored, compilerOptions: { typeRoots: ts.getEffectiveTypeRoots(parsed.options, ts.sys) },
        files, include: [], exclude: [], references }
      : { ...config, files, references });
    if (target !== configPath) {
      consumer.args = consumer.args.map((arg, index) => ['--project', '-p'].includes(consumer.args[index - 1])
        ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
      consumer.project = target;
    }
  }
  // A referenced implementation is emitted by its dependency, even when it
  // also appears in this project's roots. Advertising that root in two sibling
  // references makes native consumers look for a declaration never emitted by
  // the sibling. Keep its transitive reference as the single output owner.
  const implementations = new Map();
  for (const project of orderTypecheckProjects([...producers, ...projects], cwd)) {
    const path = resolve(cwd, project.project);
    const { config, parsed } = readTypecheckProject(path);
    const inherited = new Set();
    for (const reference of config.references ?? []) {
      for (const file of implementations.get(resolve(dirname(path), reference.path)) ?? []) inherited.add(file);
    }
    const own = parsed.fileNames.filter(file => /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file));
    if (!parsed.options.noEmit && own.some(file => inherited.has(file))) {
      await writeJsonAtomic(path, { ...config,
        files: parsed.fileNames.filter(file => !inherited.has(file)), include: [], exclude: [] });
    }
    implementations.set(path, new Set([...inherited, ...own]));
  }
  return producers;
}
