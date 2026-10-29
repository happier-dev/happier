import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { readWorkspaceTypecheckDeclarationPaths } from './workspaceTypecheckDeclarationPaths.mjs';

export function readTypecheckProject(path) {
  const config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path), undefined, path);
  if (parsed.errors.length) throw new Error(`TypeScript project ${path}:\n` + ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => dirname(path), getNewLine: () => '\n',
  }));
  return { config: config.config, parsed };
}

/** The CLI test runner emits these UI references before its consumer projects.
 * Admission reads the same declared graph without enumerating source files. */
export function readReferencedUiTypecheckProjects(projects, cwd) {
  const references = new Set();
  for (const project of projects) {
    const authored = project.authoredProject ?? project.project;
    if (!authored || !basename(authored).startsWith('tsconfig.test')
      || basename(dirname(resolve(cwd, authored))) !== 'cli') continue;
    const configPath = resolve(cwd, project.project);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    for (const reference of config.config.references ?? []) {
      const path = resolve(dirname(configPath), reference.path);
      if (basename(path) === 'tsconfig.source.json' && basename(dirname(path)) === 'ui') references.add(path);
    }
  }
  return [...references];
}

export function resolveTypecheckPrimaryTypeReferences({ configPath, parsed }) {
  const names = parsed.options.types ?? ts.getAutomaticTypeDirectiveNames(parsed.options, ts.sys);
  return new Map(names.map(name => [name,
    ts.resolveTypeReferenceDirective(name, configPath, parsed.options, ts.sys).resolvedTypeReferenceDirective]));
}

function readSourceText(file) {
  try { return readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
}

function sharedDeclaration(file, readSource) {
  if (!file.endsWith('.d.ts')) return false;
  return contributesAmbientTypes(file, readSource);
}

function readAmbientSource(file, readSource = readSourceText) {
  if (!/\.[cm]?tsx?$/.test(file)) return;
  const text = readSource(file);
  if (text === undefined) return;
  if (!/\.d\.[cm]?ts$/.test(file) && !text.includes('declare')) return;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function contributesAmbientTypes(file, readSource) {
  const source = readAmbientSource(file, readSource);
  if (!source) return false;
  return (source.isDeclarationFile && !ts.isExternalModule(source)) || source.statements.some(statement =>
    ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name)
      || Boolean(statement.flags & ts.NodeFlags.GlobalAugmentation)));
}

export function readTypecheckAmbientModules(file) {
  const source = readAmbientSource(file);
  const namespaces = [];
  const modules = [];
  const moduleDefinitions = [];
  let hasOtherGlobals = false;
  if (!source) return { namespaces, modules, moduleDefinitions, hasOtherGlobals };
  const external = ts.isExternalModule(source);
  const declarations = source.statements.flatMap(statement => {
    if (ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation) {
      return statement.body && ts.isModuleBlock(statement.body) ? [...statement.body.statements] : [];
    }
    return !external || (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) ? [statement] : [];
  });
  for (const declaration of declarations) {
    if (ts.isModuleDeclaration(declaration)) {
      (ts.isStringLiteral(declaration.name) ? modules : namespaces).push(declaration.name.text);
      if (!external && ts.isStringLiteral(declaration.name)) moduleDefinitions.push(declaration.name.text);
    } else if (!ts.isEmptyStatement(declaration)) hasOtherGlobals = true;
  }
  return { namespaces, modules, moduleDefinitions, hasOtherGlobals };
}

/** Derive source cycles, their dependency-ordered prerequisites, the source
 * remainder, and caller-selected test programs from the current graph.
 * TypeScript 5 is used only as a compiler API; checking stays with native TS7.
 */
export async function deriveTypecheckProjects(packageDir, { sourceNames, testNames, testProject = "test", testGroup = () => 0, testCompilerOptions = () => ({}), resolveSourceOwners = false, check = false, writeAuthored = false, declarationOverrides = new Map() } = {}) {
  const names = [...sourceNames, ...testNames];
  packageDir = resolve(packageDir);
  const workspaceDeclarationPaths = await readWorkspaceTypecheckDeclarationPaths(packageDir);
  const hasWorkspaceDeclarationPaths = Object.keys(workspaceDeclarationPaths).length > 0;
  const readProject = path => {
    const project = readTypecheckProject(path);
    if (hasWorkspaceDeclarationPaths) {
      project.parsed.options.paths = { ...workspaceDeclarationPaths, ...project.parsed.options.paths };
      project.parsed.options.pathsBasePath ??= dirname(path);
    }
    return project;
  };
  const original = readProject(resolve(packageDir, 'tsconfig.json'));
  const projects = names.map(name => readProject(resolve(packageDir, `tsconfig.${name}.json`)));
  const declarationRoot = file => resolve(declarationOverrides.get(resolve(file)) ?? file);
  // Finite preparation can own a generated declaration independently of a
  // live tool's output, including when that live output does not exist yet.
  const missingFiles = new Set();
  const readSource = file => {
    if (missingFiles.has(file)) return;
    const text = readSourceText(file);
    if (text === undefined) missingFiles.add(file);
    return text;
  };
  const originalRoots = new Set([...original.parsed.fileNames.map(declarationRoot), ...declarationOverrides.values()]);
  const shared = [...originalRoots].filter(file => sharedDeclaration(file, readSource));
  const sharedSet = new Set(shared);
  const testConfig = readProject(resolve(packageDir, `tsconfig.${testProject}.json`));
  const existingTests = new Set(testConfig.parsed.fileNames.map(declarationRoot).filter(file => existsSync(file)
    && !basename(file).includes('.composed.')));
  const testRoots = new Set([...existingTests, ...originalRoots].filter(file => !sharedSet.has(file) && existsSync(file)
    && (existingTests.has(file) || /\.(?:test|spec)\.tsx?$/.test(file)
      || file.replaceAll('\\', '/').includes('/__tests__/'))));
  const owned = new Set();
  const results = [];
  const path = file => relative(packageDir, file).replaceAll('\\', '/');
  const originalConfigPath = resolve(packageDir, 'tsconfig.json');
  const contexts = new Map([[originalConfigPath, { ...original, configPath: originalConfigPath }]]);
  const privateNamespace = context => context.parsed.options.paths?.['@/*']?.map(path => resolve(
    context.parsed.options.baseUrl ?? context.parsed.options.pathsBasePath ?? dirname(context.configPath), path));
  const originalNamespace = JSON.stringify(privateNamespace(contexts.get(originalConfigPath)));
  const originalLibraries = JSON.stringify(original.parsed.options.lib);
  const sourceContexts = new Map();
  const producerInputs = new Map();
  const sourceContext = file => {
    if (!resolveSourceOwners || file.endsWith('.json') || /[\\/]node_modules[\\/]/.test(file)) return contexts.get(originalConfigPath);
    if (!sourceContexts.has(file)) {
      // Private aliases and ambient libraries belong to their source producer.
      // Other package leaves retain their consuming-program resolution.
      // Never retry an unresolved import against another host's alias.
      const configPath = resolve(ts.findConfigFile(dirname(file), ts.sys.fileExists) ?? originalConfigPath);
      if (!contexts.has(configPath)) {
        try {
          const context = { ...readProject(configPath), configPath };
          context.ownsForeignPrivateNamespace = Boolean(privateNamespace(context)
            && JSON.stringify(privateNamespace(context)) !== originalNamespace);
          contexts.set(configPath, context);
        }
        catch (cause) { throw new Error(`Cannot resolve compiler owner of ${file}: ${cause.message}`, { cause }); }
      }
      const context = contexts.get(configPath);
      let owner = contexts.get(originalConfigPath);
      if (context.ownsForeignPrivateNamespace) owner = context;
      else if (JSON.stringify(context.parsed.options.lib) !== originalLibraries) {
        // A library environment owns its real program, including imported
        // implementations excluded as roots. Consumer-only test support is not
        // promoted merely because its nearest production config uses DOM.
        if (context.parsed.fileNames.includes(file)) owner = context;
        else {
          // Root membership is already known. Only excluded producer-private
          // leaves need a walk inside that producer, not through every
          // dependency's declarations and compiler environment.
          if (!producerInputs.has(configPath)) producerInputs.set(configPath,
            new Set(importClosure(context.parsed.fileNames,
              input => {
                const local = relative(dirname(configPath), input);
                return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
                  && !/[\\/]node_modules[\\/]/.test(local);
              }, context)));
          if (producerInputs.get(configPath).has(file)) owner = context;
        }
      }
      sourceContexts.set(file, owner);
    }
    return sourceContexts.get(file);
  };
  const moduleCaches = new Map();
  const moduleCache = context => {
    if (!moduleCaches.has(context.configPath)) moduleCaches.set(context.configPath,
      ts.createModuleResolutionCache(dirname(context.configPath), file => file, context.parsed.options));
    return moduleCaches.get(context.configPath);
  };
  const imports = new Map();
  const contextualImports = new Map();
  const primaryTypeReferences = new Map();
  const primaryTypes = context => {
    if (!primaryTypeReferences.has(context.configPath)) {
      primaryTypeReferences.set(context.configPath, resolveTypecheckPrimaryTypeReferences(context));
    }
    return primaryTypeReferences.get(context.configPath);
  };
  const authored = resolved => /\.(?:json|[cm]?tsx?)$/.test(resolved.resolvedFileName)
    || (original.parsed.options.allowJs && !resolved.isExternalLibraryImport
      && !/[\\/]node_modules[\\/]/.test(resolved.resolvedFileName)
      && /\.(?:[cm]?js|jsx)$/.test(resolved.resolvedFileName));
  const dependenciesFor = (file, context) => {
    if (!contextualImports.has(context.configPath)) contextualImports.set(context.configPath, new Map());
    const cache = contextualImports.get(context.configPath);
    if (!cache.has(file)) {
      const text = readSource(file);
      if (text === undefined) return;
      const info = ts.preProcessFile(text, true, true);
      const dependencies = info.importedFiles.flatMap(({ fileName }) => {
        const resolved = ts.resolveModuleName(fileName, file, context.parsed.options, ts.sys, moduleCache(context)).resolvedModule;
        return resolved && authored(resolved) ? [resolve(resolved.resolvedFileName)] : [];
      });
      for (const { fileName } of info.referencedFiles) dependencies.push(resolve(dirname(file), fileName));
      for (const { fileName } of info.typeReferenceDirectives) {
        // A program's primary type directive wins over a dependency's secondary
        // reference, just as in the canonical producer compiler environment.
        const primary = primaryTypes(context);
        const resolved = primary.has(fileName) ? primary.get(fileName)
          : ts.resolveTypeReferenceDirective(fileName, file, context.parsed.options, ts.sys).resolvedTypeReferenceDirective;
        if (resolved) dependencies.push(resolve(resolved.resolvedFileName));
      }
      cache.set(file, dependencies);
    }
    return cache.get(file);
  };
  const importClosure = (seeds, accepts = () => true, compilerContext) => {
    const found = new Set();
    const pending = [...seeds];
    while (pending.length) {
      const file = pending.pop();
      if (found.has(file) || !accepts(file)) continue;
      const dependencies = dependenciesFor(file, compilerContext ?? sourceContext(file));
      if (!dependencies) continue;
      found.add(file);
      if (!compilerContext) imports.set(file, dependencies);
      for (const dependency of dependencies) pending.push(dependency);
    }
    return [...found];
  };
  const sources = importClosure([...originalRoots].filter(file => !testRoots.has(file)));
  const implementations = new Set(sources.filter(file => !/\.d\.[cm]?ts$/.test(file)));
  // Iterative strongly-connected components avoid recursion limits on the UI
  // graph. Edges through authored declaration packages still join real cycles.
  const visited = new Set();
  const order = [];
  for (const root of sources) {
    if (visited.has(root)) continue;
    const stack = [[root, false]];
    while (stack.length) {
      const [file, finished] = stack.pop();
      if (finished) { order.push(file); continue; }
      if (visited.has(file)) continue;
      visited.add(file);
      stack.push([file, true]);
      for (const dependency of imports.get(file) ?? []) if (imports.has(dependency) && !visited.has(dependency)) stack.push([dependency, false]);
    }
  }
  const reverse = new Map();
  for (const [file, dependencies] of imports) for (const dependency of dependencies) {
    if (!reverse.has(dependency)) reverse.set(dependency, []);
    reverse.get(dependency).push(file);
  }
  visited.clear();
  const components = [];
  let core = [];
  let coreWeight = 0;
  for (const root of order.reverse()) {
    if (visited.has(root)) continue;
    const component = [];
    const pending = [root];
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      component.push(file);
      for (const parent of reverse.get(file) ?? []) pending.push(parent);
    }
    components.push(component);
    const weight = component.filter(file => implementations.has(file)).length;
    if (weight > coreWeight) { core = component; coreWeight = weight; }
  }
  const coreSet = new Set(core);
  const foundation = importClosure([...core, ...shared]).filter(file => !coreSet.has(file));
  const prerequisiteGroups = Array.from({ length: sourceNames.length - 2 }, () => []);
  const foundationSet = new Set(foundation);
  const prerequisiteComponents = components.slice().reverse().map(component => component.filter(file => foundationSet.has(file))).filter(component => component.length);
  const targetWeight = foundation.filter(file => implementations.has(file)).length / prerequisiteGroups.length;
  let prerequisiteGroup = 0;
  let assignedWeight = 0;
  for (const component of prerequisiteComponents) {
    for (const file of component) prerequisiteGroups[prerequisiteGroup].push(file);
    assignedWeight += component.filter(file => implementations.has(file)).length;
    if (assignedWeight >= targetWeight * (prerequisiteGroup + 1) && prerequisiteGroup < prerequisiteGroups.length - 1) prerequisiteGroup++;
  }
  const sourceGroups = [...prerequisiteGroups, core, sources];
  for (let index = 0; index < sourceNames.length; index++) {
    const project = projects[index];
    const seeds = sourceGroups[index];
    // Scan one file at a time, retaining edges rather than full compiler ASTs.
    // Resolution includes authored TS dependencies, reference directives, JSON.
    const closure = importClosure([...seeds, ...shared])
      .filter(file => !/\.d\.[cm]?ts$/.test(file) || originalRoots.has(file));
    const files = [...new Set([...seeds, ...closure])]
      .filter(file => (!/\.d\.[cm]?ts$/.test(file) || originalRoots.has(file)) && !sharedSet.has(file) && !owned.has(file)).sort();
    for (const file of files) owned.add(file);
    results.push({ ...project.config, files: [...files, ...shared].map(path).sort(), include: [], exclude: [] });
  }
  const foreignProjects = new Map();
  const testContexts = new Map();
  const consumerPrimaryAmbientInputs = new Map();
  const testOptionOverrides = [];
  const reachableOwners = new Map();
  if (resolveSourceOwners) {
    const dependencies = importClosure([...testRoots]);
    const parents = new Map();
    for (const [file, edges] of imports) for (const dependency of edges) {
      if (!parents.has(dependency)) parents.set(dependency, []);
      parents.get(dependency).push(file);
    }
    const ownerSeeds = new Map();
    const pending = [];
    const addOwner = (file, owner) => {
      if (!reachableOwners.has(file)) reachableOwners.set(file, new Set());
      if (reachableOwners.get(file).has(owner)) return;
      reachableOwners.get(file).add(owner);
      pending.push([file, owner]);
    };
    // Published declarations retain their ambient facts, but do not import
    // their package's build context into the consumer. Label implementations
    // once, then propagate exact reachability through the existing graph.
    for (const file of dependencies) {
      if (/\.d\.[cm]?ts$/.test(file)) continue;
      const owner = sourceContext(file);
      if (owner.configPath === originalConfigPath) continue;
      if (!ownerSeeds.has(owner)) ownerSeeds.set(owner, []);
      ownerSeeds.get(owner).push(file);
      addOwner(file, owner);
    }
    for (let index = 0; index < pending.length; index++) {
      const [file, owner] = pending[index];
      for (const parent of parents.get(file) ?? []) addOwner(parent, owner);
    }
    for (const [owner, seeds] of ownerSeeds) {
      // Preserve the producer's actual ambient environment, including .ts
      // global declarations and dependency augmentations imported by its roots.
      // Another host reached by a producer test does not own that environment.
      const acceptsOwnerInput = file => /[\\/]node_modules[\\/]/.test(file)
        || sourceContext(file).configPath === owner.configPath;
      const primaryInputs = [...primaryTypes(owner).values()].flatMap(reference => reference ? [resolve(reference.resolvedFileName)] : []);
      const producerAmbientInputs = importClosure([...owner.parsed.fileNames, ...primaryInputs], acceptsOwnerInput, owner).filter(file => contributesAmbientTypes(file, readSource));
      // Canonical authored ambient roots form the producer's type contract.
      // Dependency augmentations join that contract through reached inputs,
      // not through unrelated UI/test implementations in the whole program.
      const authoredAmbientRoots = owner.parsed.fileNames.filter(file =>
        !/[\\/]node_modules[\\/]/.test(file) && acceptsOwnerInput(file) && contributesAmbientTypes(file, readSource));
      const ambientInputs = importClosure([...seeds, ...authoredAmbientRoots, ...primaryInputs], acceptsOwnerInput, owner)
        .filter(file => contributesAmbientTypes(file, readSource));
      // Declaration facades can re-export implementations that no consumer
      // reaches directly. Include their closure before emitting a composite
      // producer, rather than appending unwalked roots during preparation.
      const declarationRoots = owner.parsed.fileNames.filter(file => /\.d\.[cm]?ts$/.test(file));
      foreignProjects.set(owner.configPath, {
        configPath: owner.configPath,
        ambientInputs,
        files: new Set([...producerAmbientInputs, ...importClosure([...seeds, ...producerAmbientInputs, ...declarationRoots])
          .filter(file => !/[\\/]node_modules[\\/]/.test(file))]),
      });
    }
  }
  for (const file of testRoots) testContexts.set(file, { file, owners: [...reachableOwners.get(file) ?? []] });
  for (let index = 0; index < testNames.length; index++) {
    // Source imports determine prerequisite ownership even for explicitly
    // test-listed files, such as a base config used by another Vitest config.
    const roots = [...testRoots].filter(file => !owned.has(file) && testGroup(path(file), testContexts.get(file)) === index);
    const config = projects[sourceNames.length + index].config;
    const consumer = {
      ...projects[sourceNames.length + index],
      configPath: resolve(packageDir, `tsconfig.${testNames[index]}.json`),
    };
    if (resolveSourceOwners) consumerPrimaryAmbientInputs.set(consumer.configPath,
      [...primaryTypes(consumer)].flatMap(([, reference]) => reference
        ? importClosure([resolve(reference.resolvedFileName)], () => true, consumer).filter(file => contributesAmbientTypes(file, readSource)) : []));
    const overrides = testCompilerOptions(roots.map(file => testContexts.get(file)), consumer);
    testOptionOverrides.push(overrides);
    results.push({ ...config, compilerOptions: { ...config.compilerOptions,
      ...overrides },
    files: [...roots, ...shared].map(path).sort(), include: [], exclude: [] });
  }
  // A missing read removes that input from this invocation's entire selection,
  // including seeds retained before dependency traversal observed the removal.
  for (const file of missingFiles) {
    originalRoots.delete(file);
    testContexts.delete(file);
  }
  for (const [configPath, files] of consumerPrimaryAmbientInputs) {
    consumerPrimaryAmbientInputs.set(configPath, files.filter(file => !missingFiles.has(file)));
  }
  for (const config of results) config.files = config.files.filter(file => !missingFiles.has(resolve(packageDir, file)));
  // Catch a stale selector or accidental test/source overlap before native
  // declaration emission; never silently omit an original implementation root.
  const memberships = results.map(config => new Set(config.files));
  for (const file of originalRoots) {
    const count = memberships.filter(files => files.has(path(file))).length;
    if (count !== (sharedSet.has(file) ? names.length : 1)) throw new Error(`TypeScript compiler ownership mismatch: ${path(file)} (${count})`);
  }
  // Explicit maintenance shares the same membership producer; public checks
  // only refresh the ignored compiler projections below.
  if (writeAuthored && !check) {
    for (let index = 0; index < names.length; index++) {
      await writeJsonAtomic(resolve(packageDir, `tsconfig.${names[index]}.json`), results[index]);
    }
    if (!names.includes(testProject)) await writeJsonAtomic(resolve(packageDir, `tsconfig.${testProject}.json`), {
      ...testConfig.config, files: [...testRoots, ...shared].filter(file => !missingFiles.has(file)).map(path).sort(), include: [], exclude: [],
    });
  }
  const changed = [];
  const { cacheSuffix } = resolveTypeScriptCliInvocation({
    args: ['-p', resolve(packageDir, `tsconfig.${names[0]}.json`)], workspaceDir: packageDir,
  });
  const outputDir = resolve(packageDir, `node_modules/.cache/tsc${cacheSuffix}`);
  const targets = names.map(name => resolve(outputDir, `tsconfig.${name}.json`));
  for (let index = 0; index < names.length; index++) {
    const target = targets[index];
    // Inherit authored options at their original path so relative aliases,
    // type roots and declaration outputs keep their existing meaning.
    const config = {
      extends: resolve(packageDir, `tsconfig.${names[index]}.json`),
      compilerOptions: {
        ...(index >= sourceNames.length ? testOptionOverrides[index - sourceNames.length] : {}),
        ...(hasWorkspaceDeclarationPaths ? {
          paths: Object.fromEntries(Object.entries(projects[index].parsed.options.paths).map(([name, targets]) => [name,
            targets.map(target => resolve(projects[index].parsed.options.baseUrl ?? projects[index].parsed.options.pathsBasePath, target))])),
        } : {}),
        ...(cacheSuffix && projects[index].parsed.options.outDir
          ? { outDir: `${projects[index].parsed.options.outDir}${cacheSuffix}` } : {}),
      },
      files: results[index].files.map(file => resolve(packageDir, file)),
      include: [], exclude: [],
      references: (projects[index].config.references ?? []).map(reference => {
        const authored = resolve(packageDir, reference.path);
        const sibling = names.findIndex(name => authored === resolve(packageDir, `tsconfig.${name}.json`));
        return { ...reference, path: sibling < 0 ? authored : targets[sibling] };
      }),
    };
    const text = JSON.stringify(config, null, 2) + '\n';
    if (existsSync(target) && readFileSync(target, 'utf8') === text) continue;
    changed.push(names[index]);
    if (!check) {
      mkdirSync(outputDir, { recursive: true });
      await writeJsonAtomic(target, config);
    }
  }
  if (check && changed.length) throw new Error(`TypeScript compiler partitions need regeneration: ${changed.join(', ')}`);
  const inventory = results.map((config, index) => ({ project: names[index], files: config.files.length, configPath: targets[index] }));
  // Coverage must observe the same editor roots that this invocation assigned.
  // Files created during graph traversal belong to the next invocation.
  inventory.baseline = { configPath: originalConfigPath, fileNames: [...originalRoots] };
  inventory.foreignProjects = [...foreignProjects.values()].map(project => ({ ...project,
    ambientInputs: project.ambientInputs.filter(file => !missingFiles.has(file)),
    files: [...project.files].filter(file => !missingFiles.has(file)).sort() }));
  inventory.testContexts = testContexts;
  inventory.consumerPrimaryAmbientInputs = consumerPrimaryAmbientInputs;
  return inventory;
}

export async function prepareDerivedTypecheckProjects(projects, cwd, { names, derive, beforeDerive } = {}) {
  const paths = projects.map(project => project.project && resolve(cwd, project.project));
  if (paths.length !== names.length || paths.some((path, index) => !path || basename(path) !== `tsconfig.${names[index]}.json`)) return;
  const packageDir = dirname(paths[0]);
  if (paths.some(path => dirname(path) !== packageDir) || !existsSync(resolve(packageDir, 'tsconfig.json'))) return;
  await beforeDerive?.(packageDir);
  const inventory = await derive(packageDir);
  for (let index = 0; index < projects.length; index++) {
    const project = projects[index];
    const target = inventory[index].configPath;
    if (project.args) project.args = project.args.map((arg, argIndex) => ['--project', '-p'].includes(project.args[argIndex - 1])
      ? target : arg.startsWith('--project=') ? `--project=${target}` : arg);
    project.project = target;
  }
  process.stderr.write(`[typescript] derived ${basename(packageDir)} partitions: ${inventory.map(({ project, files }) => `${project}=${files}`).join(', ')}\n`);
  return inventory;
}
