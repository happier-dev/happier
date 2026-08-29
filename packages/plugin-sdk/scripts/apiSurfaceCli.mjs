import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { builtinModules } from 'node:module';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import {
  apiSurfaceEntrypointBrowserRuntimeTarget,
  apiSurfaceEntrypointBrowserSourceModule,
  createApiSurfaceGenerationPlan,
  projectApiSurfaceInventory,
  projectPublishedApiSurfaceInventory,
} from './apiSurface.mjs';
import {
  createPublicSurfaceProgram,
  declarationPackageMetadata,
} from './publicDeclarationReport.mjs';
import {
  assertInventoryMatchesPreparedDeclarationSurface,
  projectPreparedDeclarationSurface,
} from '../../../scripts/api-governance/emittedDeclarationSurface.mjs';
import { assertVendoredWorkspaceDeclarationsAreCurrent } from './vendoredWorkspaceDeclarations.mjs';
import { renderDeclarationDiffSample, summarizeDeclarationDiff } from '../../../scripts/api-governance/declarationDiff.mjs';
import { parseStructuredDeprecationTags } from '../../../scripts/api-governance/structuredDeprecation.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PACKAGE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const MATERIALIZED_PLAN_OUTPUTS = Object.freeze([
  'apiSurfaceInventory',
  'packageExports',
  'sourceBarrels',
  'authorApiMarkdown',
  'capabilityMatrix',
  'publicDeclarationReport',
]);
const PUBLIC_DECLARATION_REPORT_PATH = 'api-declarations.md';
const PUBLIC_DECLARATION_REPORT_TITLE = 'Plugin SDK public declaration report';
const API_SURFACE_MATERIALIZED_PLAN_OUTPUTS = Object.freeze([
  'apiSurfaceInventory',
  'packageExports',
  'sourceBarrels',
  'authorApiMarkdown',
]);
const IN_MEMORY_PLAN_OUTPUTS = Object.freeze([
  'authorDeclarationAssertions',
  'testkitAssertions',
]);
const NODE_BUILTIN_MODULES = new Set(
  builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]),
);
const RETIRED_PER_SYMBOL_POSTURE = /@(preview|experimental|stable|incubating)\b/u;
const PUBLISHER_OWNED_SINCE = /@since\b/u;

function readArgumentValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function assertPublicationOptions(options) {
  if (
    options.previousPublishedInventoryPath !== undefined
    && options.publishedVersion === undefined
  ) {
    throw new Error('--previous-published-inventory requires --published-version');
  }
}

export function parseApiSurfaceCliArgs(args, cwd = process.cwd()) {
  let packageRoot = DEFAULT_PACKAGE_ROOT;
  let write = false;
  let check = false;
  let json = false;
  let materializeSource = false;
  let publishedVersion;
  let previousPublishedInventoryPath;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--write') {
      write = true;
      continue;
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--materialize-source') {
      materializeSource = true;
      continue;
    }
    if (argument === '--package-root') {
      packageRoot = resolve(cwd, readArgumentValue(args, index, argument));
      index += 1;
      continue;
    }
    if (argument === '--published-version') {
      publishedVersion = readArgumentValue(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === '--previous-published-inventory') {
      previousPublishedInventoryPath = resolve(cwd, readArgumentValue(args, index, argument));
      index += 1;
      continue;
    }
    throw new Error(`Unknown Plugin SDK API surface argument: ${argument}`);
  }

  if (write && check) throw new Error('--write and --check are mutually exclusive');
  const parsed = Object.freeze({
    packageRoot,
    write,
    check,
    json,
    materializeSource,
    publishedVersion,
    previousPublishedInventoryPath,
  });
  assertPublicationOptions(parsed);
  return parsed;
}

function reportProgress(options, phase) {
  options.onProgress?.(phase);
}

export function renderCliSummary(report) {
  const summary = report.summary;
  // A drift exit that only prints counts leaves the reader to diff four
  // artifacts by hand, so name every file the run would rewrite.
  return [
    `api-surface ${report.mode}: ${report.status} (planned=${summary.plannedFiles} changed=${summary.changedFiles} written=${summary.writtenFiles})`,
    ...report.files
      .filter((file) => file.changed)
      .map((file) => `  ${file.written ? 'wrote' : 'drift'} ${file.owner} ${file.path}`),
    '',
  ].join('\n');
}

function isWithinPackageRoot(packageRoot, targetPath) {
  const fromRoot = relative(packageRoot, targetPath);
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

function relativeOutputPath(packageRoot, targetPath) {
  return relative(packageRoot, targetPath).split(sep).join('/');
}

async function readJson(path, label) {
  const target = await optionalLstat(path);
  if (!target) throw new Error(`${label} is missing at ${path}`);
  if (!target.isFile()) throw new Error(`${label} must be a regular file at ${path}`);

  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing at ${path}`);
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${error.message}`);
  }
}

function renderPackageJson(packageJson, packageExports) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    throw new Error('Plugin SDK package.json must contain an object');
  }
  return `${JSON.stringify({ ...packageJson, exports: packageExports }, null, 2)}\n`;
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readPreviousPublishedApiSurfaceInventory(options) {
  if (options.publishedVersion === undefined) return undefined;
  if (options.previousPublishedInventoryPath === undefined) return undefined;
  return readJson(
    options.previousPublishedInventoryPath,
    'previous published API surface inventory',
  );
}

/**
 * Every generated output lives beside an input this run already read: the
 * inventory, `package.json` and `API.md` sit at the package root, and each
 * barrel is the entrypoint module source preflight required to be a regular
 * file. A missing output parent is therefore unreachable, and the writer
 * creates no directories.
 */
async function preflightOutputParent(physicalPackageRoot, output) {
  const parentPath = dirname(output.absolutePath);
  const parent = await optionalLstat(parentPath);
  if (!parent) {
    throw new Error(`API surface output parent must be an existing directory: ${output.relativePath}`);
  }
  const physicalParent = await realpath(parentPath);
  if (!isWithinPackageRoot(physicalPackageRoot, physicalParent)) {
    throw new Error(`API surface output parent resolves outside package root: ${output.relativePath}`);
  }
  if (!(await lstat(physicalParent)).isDirectory()) {
    throw new Error(`API surface output parent must be an existing directory: ${output.relativePath}`);
  }
  return physicalParent;
}

async function preflightOutput(packageRoot, physicalPackageRoot, output) {
  if (!isWithinPackageRoot(packageRoot, output.absolutePath)) {
    throw new Error(`API surface output escapes package root: ${output.relativePath}`);
  }
  const physicalParent = await preflightOutputParent(physicalPackageRoot, output);
  const target = await optionalLstat(output.absolutePath);
  if (target && !target.isFile()) {
    throw new Error(`API surface output must be a regular file or absent: ${output.relativePath}`);
  }
  const physicalPath = target
    ? await realpath(output.absolutePath)
    : join(physicalParent, basename(output.absolutePath));
  if (!isWithinPackageRoot(physicalPackageRoot, physicalPath)) {
    throw new Error(`API surface output resolves outside package root: ${output.relativePath}`);
  }
  const currentContents = target ? await readFile(output.absolutePath, 'utf8') : null;
  return Object.freeze({
    ...output,
    physicalPath,
    originalContents: currentContents,
    changed: currentContents !== output.contents,
  });
}

function assertUniqueOutputDestinations(outputs) {
  const outputByFoldedPhysicalPath = new Map();
  for (const output of outputs) {
    const foldedPhysicalPath = output.physicalPath.toLowerCase();
    const existing = outputByFoldedPhysicalPath.get(foldedPhysicalPath);
    if (existing) {
      throw new Error(
        `API surface outputs ${existing.relativePath} and ${output.relativePath} resolve to the same package file`,
      );
    }
    outputByFoldedPhysicalPath.set(foldedPhysicalPath, output);
  }
}

async function preflightSourceModule(packageRoot, physicalPackageRoot, sourceModule) {
  const absolutePath = resolve(packageRoot, sourceModule);
  if (!isWithinPackageRoot(packageRoot, absolutePath)) {
    throw new Error(`API surface source module escapes package root: ${sourceModule}`);
  }
  const parentPath = dirname(absolutePath);
  const parent = await optionalLstat(parentPath);
  if (!parent) {
    throw new Error(`API surface source module parent must be an existing directory: ${sourceModule}`);
  }
  const physicalParent = await realpath(parentPath);
  if (!isWithinPackageRoot(physicalPackageRoot, physicalParent)) {
    throw new Error(`API surface source module parent resolves outside package root: ${sourceModule}`);
  }
  if (!(await lstat(physicalParent)).isDirectory()) {
    throw new Error(`API surface source module parent must be an existing directory: ${sourceModule}`);
  }
  const target = await optionalLstat(absolutePath);
  if (!target?.isFile()) {
    throw new Error(`API surface source module must be a regular file: ${sourceModule}`);
  }
  return Object.freeze({
    sourceModule,
    absolutePath,
    physicalPath: await realpath(absolutePath),
    contents: await readFile(absolutePath, 'utf8'),
    logicalRoot: packageRoot,
    physicalRoot: physicalPackageRoot,
  });
}

const SOURCE_MODULE_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

function sourceModuleCandidates(importerPath, moduleSpecifier) {
  const targetPath = resolve(dirname(importerPath), moduleSpecifier);
  const extension = extname(targetPath);
  const importerExtension = extname(importerPath);
  const importerIsJavaScript = ['.js', '.jsx', '.mjs', '.cjs'].includes(importerExtension);
  const stem = extension ? targetPath.slice(0, -extension.length) : targetPath;
  if (extension === '.js') {
    return importerIsJavaScript
      ? [targetPath, `${stem}.ts`, `${stem}.tsx`]
      : [`${stem}.ts`, `${stem}.tsx`, targetPath];
  }
  if (extension === '.jsx') {
    return importerIsJavaScript ? [targetPath, `${stem}.tsx`] : [`${stem}.tsx`, targetPath];
  }
  if (extension === '.mjs') {
    return importerIsJavaScript ? [targetPath, `${stem}.mts`] : [`${stem}.mts`, targetPath];
  }
  if (extension === '.cjs') {
    return importerIsJavaScript ? [targetPath, `${stem}.cts`] : [`${stem}.cts`, targetPath];
  }
  if (extension === '.json') return [targetPath];
  if (SOURCE_MODULE_EXTENSIONS.includes(extension)) return [targetPath];
  if (extension) return [];
  return [
    ...SOURCE_MODULE_EXTENSIONS.map((candidateExtension) => `${targetPath}${candidateExtension}`),
    ...SOURCE_MODULE_EXTENSIONS.map((candidateExtension) => (
      join(targetPath, `index${candidateExtension}`)
    )),
  ];
}

function importDeclarationHasRuntimeEdge(node) {
  const importClause = node.importClause;
  if (!importClause) return true;
  if (importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  const namedBindings = importClause.namedBindings;
  if (!namedBindings) return false;
  if (ts.isNamespaceImport(namedBindings)) return true;
  if (namedBindings.elements.length === 0) return true;
  return namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeEdge(node) {
  if (!node.moduleSpecifier || node.isTypeOnly) return false;
  const exportClause = node.exportClause;
  if (!exportClause || ts.isNamespaceExport(exportClause)) return true;
  if (exportClause.elements.length === 0) return true;
  return exportClause.elements.some((element) => !element.isTypeOnly);
}

function collectRuntimeModuleEdges(source) {
  const extension = extname(source.sourceModule);
  let scriptKind = ts.ScriptKind.TS;
  if (extension === '.tsx') scriptKind = ts.ScriptKind.TSX;
  else if (extension === '.jsx') scriptKind = ts.ScriptKind.JSX;
  else if (['.js', '.mjs', '.cjs'].includes(extension)) scriptKind = ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    source.sourceModule,
    source.contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const edges = new Map();
  const addEdge = (moduleSpecifier, resolutionCondition) => {
    const key = `${resolutionCondition}\0${moduleSpecifier}`;
    edges.set(key, Object.freeze({ moduleSpecifier, resolutionCondition }));
  };
  for (const statement of sourceFile.statements) {
    let moduleSpecifier;
    let resolutionCondition = 'import';
    if (ts.isImportDeclaration(statement) && importDeclarationHasRuntimeEdge(statement)) {
      moduleSpecifier = statement.moduleSpecifier;
    } else if (ts.isExportDeclaration(statement) && exportDeclarationHasRuntimeEdge(statement)) {
      moduleSpecifier = statement.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && !statement.isTypeOnly
      && ts.isExternalModuleReference(statement.moduleReference)
    ) {
      moduleSpecifier = statement.moduleReference.expression;
      resolutionCondition = 'require';
    }
    if (
      moduleSpecifier
      && ts.isStringLiteralLike(moduleSpecifier)
    ) {
      addEdge(moduleSpecifier.text, resolutionCondition);
    }
  }

  // The static realm contract covers declarations and string-literal import()/require() calls.
  // Computed runtime module identifiers require an evaluated artifact graph and are not guessed here.
  const collectRuntimeCalls = (node) => {
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )
    ) {
      addEdge(
        node.arguments[0].text,
        node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require',
      );
    }
    ts.forEachChild(node, collectRuntimeCalls);
  };
  ts.forEachChild(sourceFile, collectRuntimeCalls);
  return [...edges.values()];
}

function collectRelativeModuleSpecifiers(source) {
  const extension = extname(source.sourceModule);
  let scriptKind = ts.ScriptKind.TS;
  if (extension === '.tsx') scriptKind = ts.ScriptKind.TSX;
  else if (extension === '.jsx') scriptKind = ts.ScriptKind.JSX;
  else if (['.js', '.mjs', '.cjs'].includes(extension)) scriptKind = ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    source.sourceModule,
    source.contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    let moduleSpecifier;
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      moduleSpecifier = statement.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
    ) {
      moduleSpecifier = statement.moduleReference.expression;
    }
    if (
      moduleSpecifier
      && ts.isStringLiteralLike(moduleSpecifier)
      && (moduleSpecifier.text.startsWith('./') || moduleSpecifier.text.startsWith('../'))
    ) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}

async function resolveRelativeSourceEdge({
  importer,
  moduleSpecifier,
  packageRoot,
  physicalPackageRoot,
  generatedOutputByLogicalPath,
  generatedOutputByPhysicalPath,
}) {
  for (const candidatePath of sourceModuleCandidates(importer.absolutePath, moduleSpecifier)) {
    if (!isWithinPackageRoot(packageRoot, candidatePath)) {
      throw new Error(
        `API surface canonical source graph escapes package root from ${importer.sourceModule}: ${moduleSpecifier}`,
      );
    }
    const logicalOutput = generatedOutputByLogicalPath.get(candidatePath.toLowerCase());
    if (logicalOutput) return Object.freeze({ generatedOutput: logicalOutput });

    const target = await optionalLstat(candidatePath);
    if (!target) continue;
    const physicalPath = await realpath(candidatePath);
    if (!isWithinPackageRoot(physicalPackageRoot, physicalPath)) {
      throw new Error(
        `API surface canonical source graph resolves outside package root from ${importer.sourceModule}: ${moduleSpecifier}`,
      );
    }
    const physicalOutput = generatedOutputByPhysicalPath.get(physicalPath.toLowerCase());
    if (physicalOutput) return Object.freeze({ generatedOutput: physicalOutput });
    const physicalTarget = await lstat(physicalPath);
    if (!physicalTarget.isFile()) continue;
    return Object.freeze({
      source: Object.freeze({
        sourceModule: relativeOutputPath(packageRoot, candidatePath),
        absolutePath: candidatePath,
        physicalPath,
        contents: await readFile(candidatePath, 'utf8'),
      }),
    });
  }
  return null;
}

export async function collectCanonicalSourceGraph({
  roots,
  collectRelativeModuleSpecifiersImpl = collectRelativeModuleSpecifiers,
  resolveRelativeSourceEdgeImpl = resolveRelativeSourceEdge,
  ...resolutionOptions
}) {
  const graph = new Map();
  const queued = new Set();
  const pending = [];
  const enqueue = (source) => {
    const key = source.physicalPath.toLowerCase();
    if (queued.has(key)) return;
    queued.add(key);
    pending.push(source);
  };
  for (const root of roots) enqueue(root);

  while (pending.length > 0) {
    const current = pending.pop();
    const currentKey = current.physicalPath.toLowerCase();
    const edges = [];
    for (const moduleSpecifier of collectRelativeModuleSpecifiersImpl(current)) {
      const edge = await resolveRelativeSourceEdgeImpl({
        importer: current,
        moduleSpecifier,
        ...resolutionOptions,
      });
      if (!edge) continue;
      edges.push(edge);
      if (edge.source) enqueue(edge.source);
    }
    graph.set(currentKey, Object.freeze(edges));
  }

  return graph;
}

async function assertCanonicalSourcesDoNotReachGeneratedBarrels({
  inventory,
  sources,
  outputs,
  packageRoot,
  physicalPackageRoot,
}) {
  const generatedOutputs = outputs.filter((output) => output.owner === 'sourceBarrels');
  const generatedOutputByLogicalPath = new Map(
    generatedOutputs.map((output) => [output.absolutePath.toLowerCase(), output]),
  );
  const generatedOutputByPhysicalPath = new Map(
    generatedOutputs.map((output) => [output.physicalPath.toLowerCase(), output]),
  );
  const generatedOutputByRelativePath = new Map(
    generatedOutputs.map((output) => [output.relativePath, output]),
  );
  const entrypointBySpecifier = new Map(
    inventory.entrypoints.map((entrypoint) => [entrypoint.specifier, entrypoint]),
  );
  const sourceByModule = new Map(sources.map((source) => [source.sourceModule, source]));
  const checkedRoots = new Set();
  const sourceGraph = await collectCanonicalSourceGraph({
    roots: sources,
    packageRoot,
    physicalPackageRoot,
    generatedOutputByLogicalPath,
    generatedOutputByPhysicalPath,
  });

  for (const symbol of inventory.symbols) {
    const rootKey = `${symbol.specifier}\0${symbol.sourceModule}`;
    if (checkedRoots.has(rootKey)) continue;
    checkedRoots.add(rootKey);
    const root = sourceByModule.get(symbol.sourceModule);
    const entrypoint = entrypointBySpecifier.get(symbol.specifier);
    const generatedEntrypoint = entrypoint
      ? generatedOutputByRelativePath.get(entrypoint.sourceModule)
      : undefined;
    if (!root || !generatedEntrypoint) continue;

    const pending = [root.physicalPath.toLowerCase()];
    const visitedPhysicalPaths = new Set();
    while (pending.length > 0) {
      const physicalKey = pending.pop();
      if (visitedPhysicalPaths.has(physicalKey)) continue;
      visitedPhysicalPaths.add(physicalKey);
      for (const edge of sourceGraph.get(physicalKey) ?? []) {
        if (edge?.generatedOutput === generatedEntrypoint) {
          throw new Error(
            `API surface canonical source ${root.sourceModule} reaches its generated entrypoint barrel ${generatedEntrypoint.relativePath}`,
          );
        }
        if (edge?.source) pending.push(edge.source.physicalPath.toLowerCase());
      }
    }
  }
}

function packageNameFromBareSpecifier(moduleSpecifier) {
  if (
    moduleSpecifier.startsWith('.')
    || moduleSpecifier.startsWith('/')
    || moduleSpecifier.startsWith('#')
    || /^[a-z][a-z+.-]*:/u.test(moduleSpecifier)
  ) {
    return null;
  }
  if (moduleSpecifier.startsWith('@')) {
    const [scope, name] = moduleSpecifier.split('/');
    return scope && name ? `${scope}/${name}` : null;
  }
  return moduleSpecifier.split('/')[0] ?? null;
}

function packageExportKey(packageName, moduleSpecifier) {
  if (moduleSpecifier === packageName) return '.';
  if (moduleSpecifier.startsWith(`${packageName}/`)) {
    return `./${moduleSpecifier.slice(packageName.length + 1)}`;
  }
  return null;
}

function activeRuntimeExportConditions(realm, resolutionCondition) {
  const conditions = new Set([resolutionCondition, 'default']);
  if (realm === 'browser') conditions.add('browser');
  else if (realm === 'react-native') conditions.add('react-native');
  else conditions.add('node');
  return conditions;
}

function selectConditionalExportTarget(value, realm, resolutionCondition) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = selectConditionalExportTarget(candidate, realm, resolutionCondition);
      if (selected) return selected;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const activeConditions = activeRuntimeExportConditions(realm, resolutionCondition);
  for (const [condition, candidate] of Object.entries(value)) {
    if (!activeConditions.has(condition)) continue;
    const selected = selectConditionalExportTarget(candidate, realm, resolutionCondition);
    if (selected) return selected;
  }
  return null;
}

function packageRuntimeExportTarget(packageJson, exportKey, realm, resolutionCondition) {
  const packageExports = packageJson.exports;
  if (typeof packageExports === 'string' || Array.isArray(packageExports)) {
    return exportKey === '.'
      ? selectConditionalExportTarget(packageExports, realm, resolutionCondition)
      : null;
  }
  if (packageExports && typeof packageExports === 'object') {
    const hasSubpathKeys = Object.keys(packageExports).some((key) => key.startsWith('.'));
    const exportValue = hasSubpathKeys
      ? packageExports[exportKey]
      : exportKey === '.' ? packageExports : undefined;
    const selected = selectConditionalExportTarget(exportValue, realm, resolutionCondition);
    if (selected) return selected;
  }
  if (exportKey !== '.') return packageExports === undefined ? exportKey : null;
  const legacyTarget = typeof packageJson.module === 'string'
    ? packageJson.module
    : typeof packageJson.main === 'string'
      ? packageJson.main
      : null;
  if (!legacyTarget || isAbsolute(legacyTarget)) return null;
  return legacyTarget.startsWith('./') ? legacyTarget : `./${legacyTarget}`;
}

function runtimeSourceCandidates(packageRoot, runtimeTarget, { preferWorkspaceSource }) {
  if (typeof runtimeTarget !== 'string' || !runtimeTarget.startsWith('./')) return [];
  const targetPath = resolve(packageRoot, runtimeTarget);
  if (!isWithinPackageRoot(packageRoot, targetPath)) return [];
  const candidates = [];
  const packageRelativeTarget = relative(packageRoot, targetPath).split(sep).join('/');
  if (preferWorkspaceSource && packageRelativeTarget.startsWith('dist/')) {
    const sourceRelativeTarget = `src/${packageRelativeTarget.slice('dist/'.length)}`;
    candidates.push(...sourceModuleCandidates(
      join(packageRoot, '__api_surface_resolver__.ts'),
      `./${sourceRelativeTarget}`,
    ));
  }
  candidates.push(targetPath);
  candidates.push(...sourceModuleCandidates(
    join(packageRoot, '__api_surface_resolver__.ts'),
    runtimeTarget,
  ));
  return [...new Set(candidates)];
}

async function findWorkspaceContext(packageRoot) {
  let candidateRoot = packageRoot;
  while (true) {
    const packageJsonPath = join(candidateRoot, 'package.json');
    const packageJsonStat = await optionalLstat(packageJsonPath);
    if (packageJsonStat?.isFile()) {
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
        if (packageJson.workspaces) {
          const physicalRoot = await realpath(candidateRoot);
          return Object.freeze({
            physicalRoot,
          });
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Workspace package.json is not valid JSON at ${packageJsonPath}: ${error.message}`);
        }
        throw error;
      }
    }
    const parentRoot = dirname(candidateRoot);
    if (parentRoot === candidateRoot) return null;
    candidateRoot = parentRoot;
  }
}

async function readResolvedSourceModule({
  absolutePath,
  logicalRoot,
  physicalRoot,
  displayPrefix = '',
}) {
  if (!isWithinPackageRoot(logicalRoot, absolutePath)) return null;
  const target = await optionalLstat(absolutePath);
  if (!target) return null;
  const physicalPath = await realpath(absolutePath);
  if (!isWithinPackageRoot(physicalRoot, physicalPath)) {
    throw new Error(`API surface realm source resolves outside its runtime package: ${absolutePath}`);
  }
  const physicalTarget = await lstat(physicalPath);
  if (!physicalTarget.isFile()) return null;
  const localModule = relative(logicalRoot, absolutePath).split(sep).join('/');
  return Object.freeze({
    sourceModule: displayPrefix ? `${displayPrefix}/${localModule}` : localModule,
    absolutePath,
    physicalPath,
    contents: await readFile(absolutePath, 'utf8'),
    logicalRoot,
    physicalRoot,
  });
}

async function findRuntimePackage({
  dependencyName,
  importer,
  workspaceContext,
}) {
  let searchRoot = dirname(importer.absolutePath);
  while (true) {
    const logicalPackageRoot = join(searchRoot, 'node_modules', dependencyName);
    const packageEntry = await optionalLstat(logicalPackageRoot);
    if (packageEntry) {
      const physicalPackageRoot = await realpath(logicalPackageRoot);
      const physicalPackage = await lstat(physicalPackageRoot);
      if (!physicalPackage.isDirectory()) {
        throw new Error(`API surface runtime package must resolve to a directory: ${logicalPackageRoot}`);
      }
      const preferWorkspaceSource = Boolean(
        packageEntry.isSymbolicLink()
        && workspaceContext
        && isWithinPackageRoot(workspaceContext.physicalRoot, physicalPackageRoot),
      );
      return Object.freeze({
        physicalPackageRoot,
        preferWorkspaceSource,
      });
    }
    const parentRoot = dirname(searchRoot);
    if (parentRoot === searchRoot) return null;
    searchRoot = parentRoot;
  }
}

async function resolveBarePackageRuntimeSource({
  moduleSpecifier,
  realm,
  resolutionCondition,
  importer,
  workspaceContext,
}) {
  const dependencyName = packageNameFromBareSpecifier(moduleSpecifier);
  if (!dependencyName) {
    throw new Error(
      `API surface ${realm} value closure cannot classify runtime import ${moduleSpecifier} from ${importer.sourceModule}`,
    );
  }
  const exportKey = packageExportKey(dependencyName, moduleSpecifier);
  if (!exportKey) {
    throw new Error(
      `API surface ${realm} value closure cannot classify runtime package import ${moduleSpecifier}`,
    );
  }
  const runtimePackage = await findRuntimePackage({
    dependencyName,
    importer,
    workspaceContext,
  });
  if (!runtimePackage) {
    throw new Error(
      `API surface ${realm} value closure cannot resolve runtime package ${moduleSpecifier} from ${importer.sourceModule}`,
    );
  }
  const packageJsonPath = join(runtimePackage.physicalPackageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath, `API surface runtime package ${dependencyName}`);
  if (packageJson.name !== dependencyName) {
    throw new Error(
      `API surface runtime package ${dependencyName} resolves to package ${String(packageJson.name)}`,
    );
  }
  const runtimeTarget = packageRuntimeExportTarget(
    packageJson,
    exportKey,
    realm,
    resolutionCondition,
  );
  if (!runtimeTarget) {
    throw new Error(
      `API surface ${realm} value closure cannot resolve runtime package export ${moduleSpecifier}`,
    );
  }
  for (const candidatePath of runtimeSourceCandidates(
    runtimePackage.physicalPackageRoot,
    runtimeTarget,
    { preferWorkspaceSource: runtimePackage.preferWorkspaceSource },
  )) {
    const source = await readResolvedSourceModule({
      absolutePath: candidatePath,
      logicalRoot: runtimePackage.physicalPackageRoot,
      physicalRoot: runtimePackage.physicalPackageRoot,
      displayPrefix: dependencyName,
    });
    if (source) return source;
  }
  throw new Error(
    `API surface ${realm} value closure cannot resolve runtime package source ${moduleSpecifier} -> ${runtimeTarget}`,
  );
}

function realmCanReach(consumerRealm, dependencyRealm) {
  return dependencyRealm === 'any'
    || dependencyRealm === consumerRealm
    || (
      dependencyRealm === 'client'
      && (consumerRealm === 'browser' || consumerRealm === 'react-native')
    );
}

function publicationClosureRealms(realm) {
  if (realm === 'client') return ['browser', 'react-native'];
  if (realm === 'any') return ['browser', 'react-native', 'any'];
  return [realm];
}

async function resolveRealmRelativeEdge({
  importer,
  moduleSpecifier,
  generatedEntrypointByLogicalPath,
  generatedEntrypointByPhysicalPath,
}) {
  for (const candidatePath of sourceModuleCandidates(importer.absolutePath, moduleSpecifier)) {
    if (!isWithinPackageRoot(importer.logicalRoot, candidatePath)) {
      throw new Error(
        `API surface value closure escapes its package from ${importer.sourceModule}: ${moduleSpecifier}`,
      );
    }
    const logicalEntrypoint = generatedEntrypointByLogicalPath.get(candidatePath.toLowerCase());
    if (logicalEntrypoint) return Object.freeze({ entrypoint: logicalEntrypoint });
    const target = await optionalLstat(candidatePath);
    if (!target) continue;
    const physicalPath = await realpath(candidatePath);
    if (!isWithinPackageRoot(importer.physicalRoot, physicalPath)) {
      throw new Error(
        `API surface value closure resolves outside its package from ${importer.sourceModule}: ${moduleSpecifier}`,
      );
    }
    const physicalEntrypoint = generatedEntrypointByPhysicalPath.get(physicalPath.toLowerCase());
    if (physicalEntrypoint) return Object.freeze({ entrypoint: physicalEntrypoint });
    if (extname(candidatePath) === '.json') {
      const physicalTarget = await lstat(physicalPath);
      if (!physicalTarget.isFile()) continue;
      return Object.freeze({ dataLeaf: true });
    }
    const source = await readResolvedSourceModule({
      absolutePath: candidatePath,
      logicalRoot: importer.logicalRoot,
      physicalRoot: importer.physicalRoot,
      displayPrefix: importer.sourceModule.startsWith('@')
        ? importer.sourceModule.split('/').slice(0, 2).join('/')
        : '',
    });
    if (source) return Object.freeze({ source });
  }
  return null;
}

async function assertInventoryValueRealmClosures({
  inventory,
  packageJson,
  sources,
  outputs,
  packageRoot,
}) {
  const sourceByModule = new Map(sources.map((source) => [source.sourceModule, source]));
  const entrypointBySpecifier = new Map(
    inventory.entrypoints.map((entrypoint) => [entrypoint.specifier, entrypoint]),
  );
  const valueSymbolsBySpecifier = new Map(
    inventory.entrypoints.map((entrypoint) => [entrypoint.specifier, []]),
  );
  for (const symbol of inventory.symbols) {
    if (symbol.kind === 'value') valueSymbolsBySpecifier.get(symbol.specifier)?.push(symbol);
  }
  const generatedEntrypointByLogicalPath = new Map();
  const generatedEntrypointByPhysicalPath = new Map();
  for (const output of outputs) {
    if (output.owner !== 'sourceBarrels') continue;
    const entrypoint = inventory.entrypoints.find((candidate) => (
      candidate.sourceModule === output.relativePath
    ));
    if (!entrypoint) continue;
    generatedEntrypointByLogicalPath.set(output.absolutePath.toLowerCase(), entrypoint);
    generatedEntrypointByPhysicalPath.set(output.physicalPath.toLowerCase(), entrypoint);
  }
  const workspaceContext = await findWorkspaceContext(packageRoot);
  const currentPackageName = typeof packageJson.name === 'string' ? packageJson.name : null;
  const checkedRoots = new Set();
  const checkedPhysicalSourcesByRealm = new Map();

  for (const symbol of inventory.symbols) {
    if (symbol.kind !== 'value') continue;
    const entrypoint = entrypointBySpecifier.get(symbol.specifier);
    if (!entrypoint) continue;
    if (!realmCanReach(entrypoint.realm, symbol.realm)) {
      throw new Error(
        `API surface ${entrypoint.realm} entrypoint ${entrypoint.specifier} cannot publish ${symbol.realm} value ${symbol.exportName}`,
      );
    }
    const root = sourceByModule.get(symbol.sourceModule);
    if (!root) continue;
    const rootLabel = `${symbol.sourceModule}#${symbol.sourceExport}`;
    for (const closureRealm of publicationClosureRealms(entrypoint.realm)) {
      const rootKey = `${closureRealm}\0${symbol.sourceModule}`;
      if (checkedRoots.has(rootKey)) continue;
      checkedRoots.add(rootKey);
      const pending = [{ source: root, chain: [rootLabel] }];
      let checkedPhysicalSources = checkedPhysicalSourcesByRealm.get(closureRealm);
      if (!checkedPhysicalSources) {
        checkedPhysicalSources = new Set();
        checkedPhysicalSourcesByRealm.set(closureRealm, checkedPhysicalSources);
      }

      while (pending.length > 0) {
        const current = pending.pop();
        const physicalKey = current.source.physicalPath.toLowerCase();
        // Reachability and realm admissibility are properties of the physical
        // module graph, not of the public value that first reached it. Once a
        // module's outgoing edges have been admitted for one realm, traversing
        // that same subgraph again for every exported root adds no evidence.
        if (checkedPhysicalSources.has(physicalKey)) continue;
        checkedPhysicalSources.add(physicalKey);
        for (const { moduleSpecifier, resolutionCondition } of collectRuntimeModuleEdges(current.source)) {
          if (NODE_BUILTIN_MODULES.has(moduleSpecifier) || moduleSpecifier.startsWith('node:')) {
            if (closureRealm === 'browser' || closureRealm === 'react-native') {
              throw new Error(
                `API surface ${closureRealm} value closure ${rootLabel} reaches Node builtin ${moduleSpecifier} via ${[...current.chain, moduleSpecifier].join(' -> ')}`,
              );
            }
            continue;
          }

          let edge = null;
          if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
            edge = await resolveRealmRelativeEdge({
              importer: current.source,
              moduleSpecifier,
              generatedEntrypointByLogicalPath,
              generatedEntrypointByPhysicalPath,
            });
            if (!edge) {
              throw new Error(
                `API surface ${closureRealm} value closure ${rootLabel} cannot resolve relative import ${moduleSpecifier} from ${current.source.sourceModule}`,
              );
            }
          } else {
            const currentPackageExportKey = currentPackageName
              ? packageExportKey(currentPackageName, moduleSpecifier)
              : null;
            if (currentPackageExportKey) {
              const targetEntrypoint = entrypointBySpecifier.get(currentPackageExportKey);
              if (!targetEntrypoint) {
                throw new Error(
                  `API surface ${closureRealm} value closure ${rootLabel} reaches undeclared package entrypoint ${moduleSpecifier}`,
                );
              }
              edge = Object.freeze({ entrypoint: targetEntrypoint });
            } else {
              const packageSource = await resolveBarePackageRuntimeSource({
                moduleSpecifier,
                realm: closureRealm,
                resolutionCondition,
                importer: current.source,
                workspaceContext,
              });
              edge = Object.freeze({ source: packageSource });
            }
          }

          if (edge?.entrypoint) {
            if (!realmCanReach(closureRealm, edge.entrypoint.realm)) {
              throw new Error(
                `API surface ${closureRealm} value closure ${rootLabel} reaches incompatible ${edge.entrypoint.realm} entrypoint ${edge.entrypoint.specifier} via ${[...current.chain, moduleSpecifier].join(' -> ')}`,
              );
            }
            for (const targetSymbol of valueSymbolsBySpecifier.get(edge.entrypoint.specifier) ?? []) {
              const targetSource = sourceByModule.get(targetSymbol.sourceModule);
              if (targetSource) {
                pending.push({
                  source: targetSource,
                  chain: [...current.chain, `${edge.entrypoint.specifier}#${targetSymbol.sourceExport}`],
                });
              }
            }
          } else if (edge?.source) {
            pending.push({
              source: edge.source,
              chain: [...current.chain, `${moduleSpecifier} (${edge.source.sourceModule})`],
            });
          } else if (edge?.dataLeaf) {
            continue;
          }
        }
      }
    }
  }
}

function assertCanonicalSourcesAreNotGeneratedBarrels(sources, outputs) {
  const outputByFoldedPhysicalPath = new Map(
    outputs.map((output) => [output.physicalPath.toLowerCase(), output]),
  );
  for (const source of sources) {
    const output = outputByFoldedPhysicalPath.get(source.physicalPath.toLowerCase());
    if (output) {
      throw new Error(
        `API surface canonical source ${source.sourceModule} resolves to generated barrel ${output.relativePath}`,
      );
    }
  }
}

/**
 * Reads the realm every canonical declaration publishes. A realm cannot be
 * inferred from a signature, so it is declared in source next to the
 * declaration that owns it: `@moduleRealm <realm>` in the module's leading
 * comment sets the module default, and `@realm <realm>` on a declaration
 * overrides it.
 */
function declaredRealm(text, tag) {
  const match = new RegExp(`@${tag}\\s+([a-z-]+)`, 'u').exec(text);
  return match?.[1];
}

function moduleDeclaredRealm(source, sourceFile) {
  const leading = ts.getLeadingCommentRanges(source.contents, 0) ?? [];
  for (const range of leading) {
    const realm = declaredRealm(source.contents.slice(range.pos, range.end), 'moduleRealm');
    if (realm) return assertDeclaredRealm(realm, source.sourceModule);
  }
  // A module-wide realm may also sit on the file's own doc comment, which the
  // parser attaches to the first statement rather than to the source file.
  const [firstStatement] = sourceFile.statements;
  if (!firstStatement) return 'any';
  for (const doc of ts.getJSDocCommentsAndTags(firstStatement)) {
    const realm = declaredRealm(doc.getText(), 'moduleRealm');
    if (realm) return assertDeclaredRealm(realm, source.sourceModule);
  }
  return 'any';
}

function assertDeclaredRealm(realm, sourceModule) {
  if (!API_SURFACE_REALMS.has(realm)) {
    throw new Error(`API surface canonical source ${sourceModule} declares unknown realm ${realm}`);
  }
  return realm;
}

const API_SURFACE_REALMS = new Set(['any', 'browser', 'react-native', 'client', 'daemon', 'build']);

/**
 * Projects what every canonical source module exports — the export names, their
 * type/value kinds and their declared realms. This is the package-source input
 * the inventory is produced from; it is also the assertion that every published
 * symbol still exists in source.
 */
function projectCanonicalSourceExports(sources) {
  const exportsByModule = new Map();

  const hasExportModifier = (node) => node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;
  const addExport = (exportsByName, name, kinds, realm) => {
    const current = exportsByName.get(name) ?? { kinds: new Set(), realm };
    for (const kind of kinds) current.kinds.add(kind);
    exportsByName.set(name, current);
  };
  const collectBindingNames = (name, names) => {
    if (ts.isIdentifier(name)) {
      names.push(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, names);
    }
  };

  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.sourceModule,
      source.contents,
      ts.ScriptTarget.Latest,
      true,
      source.sourceModule.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const defaultRealm = moduleDeclaredRealm(source, sourceFile);
    const statementRealm = (statement) => {
      for (const doc of ts.getJSDocCommentsAndTags(statement)) {
        const realm = declaredRealm(doc.getText(), 'realm');
        if (realm) return assertDeclaredRealm(realm, source.sourceModule);
      }
      return defaultRealm;
    };
    const exportsByName = new Map();
    for (const statement of sourceFile.statements) {
      const realm = statementRealm(statement);
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          addExport(
            exportsByName,
            element.name.text,
            statement.isTypeOnly || element.isTypeOnly ? ['type'] : ['value'],
            realm,
          );
        }
        continue;
      }
      if (!hasExportModifier(statement)) continue;
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
        addExport(exportsByName, statement.name.text, ['type'], realm);
      } else if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        if (statement.name) addExport(exportsByName, statement.name.text, ['type', 'value'], realm);
      } else if (ts.isFunctionDeclaration(statement)) {
        if (statement.name) addExport(exportsByName, statement.name.text, ['value'], realm);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const names = [];
          collectBindingNames(declaration.name, names);
          for (const name of names) addExport(exportsByName, name, ['value'], realm);
        }
      }
    }
    exportsByModule.set(source.sourceModule, exportsByName);
  }

  return exportsByModule;
}

function canonicalSourceExport(exportsByModule, sourceModule, sourceExport) {
  const provided = exportsByModule.get(sourceModule)?.get(sourceExport);
  if (!provided) {
    throw new Error(
      `API surface canonical source ${sourceModule} does not export ${sourceExport}`,
    );
  }
  return provided;
}

function assertCanonicalSourceProjections(inventory, exportsByModule) {
  for (const symbolRow of inventory.symbols) {
    const provided = canonicalSourceExport(
      exportsByModule,
      symbolRow.sourceModule,
      symbolRow.sourceExport,
    );
    if (!provided.kinds.has(symbolRow.kind)) {
      throw new Error(
        `API surface canonical export ${symbolRow.sourceModule}#${symbolRow.sourceExport} does not provide ${symbolRow.kind} kind`,
      );
    }
  }
}

function resolvedSymbol(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function sourceFileForPreflightedModule(program, source) {
  return program.getSourceFile(source.absolutePath)
    ?? program.getSourceFiles().find((candidate) => (
      resolve(candidate.fileName) === source.absolutePath
    ));
}

function exportedModuleExportSymbol(checker, sourceFile, exportName) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return null;
  return checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === exportName) ?? null;
}

function exportedModuleSymbol(checker, sourceFile, exportName) {
  const exported = exportedModuleExportSymbol(checker, sourceFile, exportName);
  return exported ? resolvedSymbol(checker, exported) : null;
}

function isDirectProtocolValueReexport(sourceFile, exportName) {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement)
      || !ts.isNamedExports(statement.exportClause)
      || statement.moduleSpecifier === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) return false;
    const specifier = statement.moduleSpecifier.text;
    if (specifier !== '@happier-dev/protocol' && !specifier.startsWith('@happier-dev/protocol/')) {
      return false;
    }
    return statement.exportClause.elements.some((element) => (
      !element.isTypeOnly && element.name.text === exportName
    ));
  });
}

function isDirectProtocolTypeReexport(sourceFile, exportName) {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isExportDeclaration(statement)
      || !ts.isNamedExports(statement.exportClause)
      || statement.moduleSpecifier === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)
    ) return false;
    const specifier = statement.moduleSpecifier.text;
    if (specifier !== '@happier-dev/protocol' && !specifier.startsWith('@happier-dev/protocol/')) {
      return false;
    }
    return statement.exportClause.elements.some((element) => (
      (statement.isTypeOnly || element.isTypeOnly) && element.name.text === exportName
    ));
  });
}

function readCanonicalAuthorSchemaProjectionTypes({
  checker,
  inventory,
  sourceFileByModule,
  reachableAuthorTypes,
}) {
  const find = (sourceExport) => {
    const rows = inventory.symbols.filter((row) => (
      row.kind === 'type' && row.sourceExport === sourceExport
    ));
    const symbols = new Set(rows.flatMap((row) => {
      const sourceFile = sourceFileByModule.get(row.sourceModule);
      const symbol = sourceFile && exportedModuleSymbol(checker, sourceFile, row.sourceExport);
      return symbol ? [symbol] : [];
    }));
    if (symbols.size !== 1) return null;
    const [symbol] = symbols;
    return reachableAuthorTypes.has(symbol) ? symbol : null;
  };
  return Object.freeze({
    pluginJsonSchema: find('PluginJsonSchema'),
    protocolComposableSchema: find('ProtocolComposableSchema'),
  });
}

function directProtocolSchemaProjection(
  checker,
  sourceFile,
  exportName,
  valueType,
  canonicalProjectionTypes,
  reachableAuthorTypes,
) {
  if (!isDirectProtocolValueReexport(sourceFile, exportName)) return null;
  const protocolComposableSchema = canonicalProjectionTypes.protocolComposableSchema;
  if (
    protocolComposableSchema
    && hasCanonicalProtocolComposableSchemaSurface(
      checker,
      valueType,
      canonicalProjectionTypes.pluginJsonSchema,
    )
  ) {
    return Object.freeze({ kind: 'composable', symbol: protocolComposableSchema });
  }
  const pluginJsonSchema = canonicalProjectionTypes.pluginJsonSchema;
  if (
    pluginJsonSchema
    && hasCanonicalPluginJsonSchemaSurface(checker, valueType, pluginJsonSchema)
  ) {
    return Object.freeze({ kind: 'json-schema', symbol: pluginJsonSchema });
  }
  const outputName = exportName.endsWith('Schema')
    ? exportName.slice(0, -'Schema'.length)
    : null;
  const outputSymbol = outputName && isDirectProtocolTypeReexport(sourceFile, outputName)
    ? exportedModuleSymbol(checker, sourceFile, outputName)
    : null;
  if (
    outputSymbol
    && reachableAuthorTypes.has(outputSymbol)
    && hasDirectProtocolSchemaOutputSurface(checker, valueType, outputSymbol)
  ) {
    return Object.freeze({ kind: 'output', symbol: outputSymbol });
  }
  return null;
}

function propertyType(checker, type, name) {
  const property = checker.getPropertyOfType(type, name);
  const declaration = property?.valueDeclaration ?? property?.declarations?.[0];
  return property && declaration
    ? checker.getTypeOfSymbolAtLocation(property, declaration)
    : null;
}

function hasCallSurface(checker, type, minimumParameterCount) {
  return type?.getCallSignatures().some((signature) => (
    signature.minArgumentCount === minimumParameterCount
  )) === true;
}

function hasCanonicalPluginJsonSchemaSurface(checker, valueType, pluginJsonSchemaSymbol) {
  const publicSchemaType = checker.getDeclaredTypeOfSymbol(pluginJsonSchemaSymbol);
  if (checker.isTypeAssignableTo(valueType, publicSchemaType)) return true;
  if (valueType.getCallSignatures().length > 0 || valueType.getConstructSignatures().length > 0) return false;
  const publicProperties = new Map(checker.getPropertiesOfType(publicSchemaType).map((property) => [
    property.name,
    propertyType(checker, publicSchemaType, property.name),
  ]));
  return checker.getPropertiesOfType(valueType).every((property) => {
    const expected = publicProperties.get(property.name);
    const actual = propertyType(checker, valueType, property.name);
    return expected !== undefined && actual !== null && checker.isTypeAssignableTo(actual, expected);
  });
}

function hasCanonicalProtocolComposableSchemaSurface(checker, valueType, pluginJsonSchemaSymbol) {
  if (!pluginJsonSchemaSymbol) return false;
  const jsonSchema = propertyType(checker, valueType, 'jsonSchema');
  return jsonSchema !== null
    && hasCanonicalPluginJsonSchemaSurface(checker, jsonSchema, pluginJsonSchemaSymbol)
    && hasCallSurface(checker, propertyType(checker, valueType, 'parse'), 1)
    && hasCallSurface(checker, propertyType(checker, valueType, 'safeParse'), 1)
    && hasCallSurface(checker, propertyType(checker, valueType, 'optional'), 0)
    && hasCallSurface(checker, propertyType(checker, valueType, 'nullable'), 0);
}

function hasDirectProtocolSchemaOutputSurface(checker, valueType, outputSymbol) {
  const outputType = checker.getDeclaredTypeOfSymbol(outputSymbol);
  const parse = propertyType(checker, valueType, 'parse');
  if (!hasCallSurface(checker, parse, 1)) return false;
  if (!hasCallSurface(checker, propertyType(checker, valueType, 'safeParse'), 1)) return false;
  return parse.getCallSignatures().some((signature) => (
    checker.isTypeAssignableTo(signature.getReturnType(), outputType)
  ));
}

function collectComposableProjectionOutputTypes(checker, valueType, referencedTypes, seenTypes) {
  const parse = checker.getPropertyOfType(valueType, 'parse');
  const declaration = parse?.valueDeclaration ?? parse?.declarations?.[0];
  if (!parse || !declaration) return;
  const parseType = checker.getTypeOfSymbolAtLocation(parse, declaration);
  for (const signature of parseType.getCallSignatures()) {
    collectNamedSignatureTypes(checker, signature.getReturnType(), referencedTypes, seenTypes);
  }
}

function collectNamedSignatureTypes(checker, type, referencedTypes, seenTypes) {
  if (!type || seenTypes.has(type)) return;
  seenTypes.add(type);

  if (type.aliasSymbol) {
    referencedTypes.set(
      resolvedSymbol(checker, type.aliasSymbol),
      type.aliasSymbol.getName(),
    );
    for (const argument of type.aliasTypeArguments ?? []) {
      collectNamedSignatureTypes(checker, argument, referencedTypes, seenTypes);
    }
    return;
  }
  if (type.flags & ts.TypeFlags.TypeParameter) return;
  if (type.isUnionOrIntersection()) {
    for (const member of type.types) {
      collectNamedSignatureTypes(checker, member, referencedTypes, seenTypes);
    }
    return;
  }
  if (!(type.flags & ts.TypeFlags.Object)) return;

  const symbol = type.getSymbol();
  if (
    symbol
    && symbol.getName() !== '__type'
    && symbol.getName() !== '__function'
    && symbol.flags & ts.SymbolFlags.Type
  ) {
    referencedTypes.set(resolvedSymbol(checker, symbol), symbol.getName());
    if (type.objectFlags & ts.ObjectFlags.Reference) {
      for (const argument of checker.getTypeArguments(type)) {
        collectNamedSignatureTypes(checker, argument, referencedTypes, seenTypes);
      }
    }
    return;
  }

  if (type.objectFlags & ts.ObjectFlags.Reference) {
    for (const argument of checker.getTypeArguments(type)) {
      collectNamedSignatureTypes(checker, argument, referencedTypes, seenTypes);
    }
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    collectSignatureNamedTypes(checker, signature, referencedTypes, seenTypes);
  }
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    collectNamedSignatureTypes(
      checker,
      checker.getTypeOfSymbolAtLocation(property, declaration),
      referencedTypes,
      seenTypes,
    );
  }
}

function collectSignatureNamedTypes(checker, signature, referencedTypes, seenTypes) {
  for (const typeParameter of signature.getTypeParameters() ?? []) {
    collectNamedSignatureTypes(
      checker,
      checker.getBaseConstraintOfType(typeParameter),
      referencedTypes,
      seenTypes,
    );
    const declaration = typeParameter.symbol?.declarations?.[0];
    if (declaration && ts.isTypeParameterDeclaration(declaration) && declaration.default) {
      collectNamedSignatureTypes(
        checker,
        checker.getTypeFromTypeNode(declaration.default),
        referencedTypes,
        seenTypes,
      );
    }
  }
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
    if (!declaration) continue;
    collectNamedSignatureTypes(
      checker,
      checker.getTypeOfSymbolAtLocation(parameter, declaration),
      referencedTypes,
      seenTypes,
    );
  }
  collectNamedSignatureTypes(
    checker,
    signature.getReturnType(),
    referencedTypes,
    seenTypes,
  );
}

function namedSignatureTypeSymbol(checker, type) {
  if (type?.aliasSymbol) return resolvedSymbol(checker, type.aliasSymbol);
  if (!(type?.flags & ts.TypeFlags.Object)) return null;
  const symbol = type.getSymbol();
  if (
    !symbol
    || symbol.getName() === '__type'
    || symbol.getName() === '__function'
    || !(symbol.flags & ts.SymbolFlags.Type)
  ) return null;
  return resolvedSymbol(checker, symbol);
}

function isPublicTypeMember(symbol) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !ts.canHaveModifiers(declaration)) return true;
  const modifiers = ts.getModifiers(declaration) ?? [];
  return !modifiers.some((modifier) => (
    modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword
  ));
}

function collectPublicTypeMembers(
  checker,
  type,
  referencedTypes,
  seenTypes,
  seenMemberSurfaces,
) {
  if (!type || seenMemberSurfaces.has(type)) return;
  seenMemberSurfaces.add(type);
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    collectSignatureNamedTypes(checker, signature, referencedTypes, seenTypes);
  }
  for (const property of checker.getPropertiesOfType(type)) {
    if (!isPublicTypeMember(property)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) continue;
    collectDeclarationSignatureTypeNodes(checker, declaration, referencedTypes);
    collectNamedSignatureTypes(
      checker,
      checker.getTypeOfSymbolAtLocation(property, declaration),
      referencedTypes,
      seenTypes,
    );
  }
  for (const indexInfo of checker.getIndexInfosOfType(type)) {
    collectNamedSignatureTypes(checker, indexInfo.keyType, referencedTypes, seenTypes);
    collectNamedSignatureTypes(checker, indexInfo.type, referencedTypes, seenTypes);
  }
  if (type.isClassOrInterface()) {
    for (const baseType of checker.getBaseTypes(type) ?? []) {
      collectNamedSignatureTypes(checker, baseType, referencedTypes, seenTypes);
    }
  }
}

function namedImportTypeSymbol(checker, node) {
  if (!node.qualifier || node.isTypeOf) return null;
  const qualifierSymbol = checker.getSymbolAtLocation(node.qualifier);
  if (qualifierSymbol && !(qualifierSymbol.flags & ts.SymbolFlags.TypeParameter)) {
    return resolvedSymbol(checker, qualifierSymbol);
  }
  const importedType = checker.getTypeFromTypeNode(node);
  const importedSymbol = importedType.aliasSymbol ?? importedType.getSymbol();
  return importedSymbol && !(importedSymbol.flags & ts.SymbolFlags.TypeParameter)
    ? resolvedSymbol(checker, importedSymbol)
    : null;
}

function collectTypeNodeNamedTypes(checker, node, referencedTypes) {
  if (!node) return;
  if (ts.isTypeReferenceNode(node)) {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const referencedType = symbol ? resolvedSymbol(checker, symbol) : null;
    if (referencedType && !(referencedType.flags & ts.SymbolFlags.TypeParameter)) {
      referencedTypes.set(referencedType, node.typeName.getText());
    }
  } else if (ts.isExpressionWithTypeArguments(node)) {
    const symbol = checker.getSymbolAtLocation(node.expression);
    const referencedType = symbol ? resolvedSymbol(checker, symbol) : null;
    if (referencedType && !(referencedType.flags & ts.SymbolFlags.TypeParameter)) {
      referencedTypes.set(referencedType, node.expression.getText());
    }
  } else if (ts.isImportTypeNode(node) && node.qualifier && !node.isTypeOf) {
    const referencedType = namedImportTypeSymbol(checker, node);
    if (referencedType && !(referencedType.flags & ts.SymbolFlags.TypeParameter)) {
      referencedTypes.set(referencedType, node.qualifier.getText());
    }
  }
  ts.forEachChild(node, (child) => collectTypeNodeNamedTypes(checker, child, referencedTypes));
}

function collectDeclarationSignatureTypeNodes(checker, declaration, referencedTypes) {
  if (
    ts.isFunctionDeclaration(declaration)
    || ts.isMethodDeclaration(declaration)
    || ts.isConstructorDeclaration(declaration)
    || ts.isCallSignatureDeclaration(declaration)
    || ts.isConstructSignatureDeclaration(declaration)
    || ts.isGetAccessorDeclaration(declaration)
    || ts.isSetAccessorDeclaration(declaration)
    || ts.isIndexSignatureDeclaration(declaration)
  ) {
    for (const typeParameter of declaration.typeParameters ?? []) {
      collectTypeNodeNamedTypes(checker, typeParameter.constraint, referencedTypes);
      collectTypeNodeNamedTypes(checker, typeParameter.default, referencedTypes);
    }
    for (const parameter of declaration.parameters) {
      collectTypeNodeNamedTypes(checker, parameter.type, referencedTypes);
    }
    collectTypeNodeNamedTypes(checker, declaration.type, referencedTypes);
    return;
  }
  if (ts.isVariableDeclaration(declaration)) {
    collectTypeNodeNamedTypes(checker, declaration.type, referencedTypes);
    return;
  }
  if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) {
    collectTypeNodeNamedTypes(checker, declaration.type, referencedTypes);
    return;
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    for (const typeParameter of declaration.typeParameters ?? []) {
      collectTypeNodeNamedTypes(checker, typeParameter.constraint, referencedTypes);
      collectTypeNodeNamedTypes(checker, typeParameter.default, referencedTypes);
    }
    collectTypeNodeNamedTypes(checker, declaration.type, referencedTypes);
    return;
  }
  if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    for (const typeParameter of declaration.typeParameters ?? []) {
      collectTypeNodeNamedTypes(checker, typeParameter.constraint, referencedTypes);
      collectTypeNodeNamedTypes(checker, typeParameter.default, referencedTypes);
    }
    for (const heritageClause of declaration.heritageClauses ?? []) {
      collectTypeNodeNamedTypes(checker, heritageClause, referencedTypes);
    }
    for (const member of declaration.members) {
      if (ts.canHaveModifiers(member)) {
        const modifiers = ts.getModifiers(member) ?? [];
        if (modifiers.some((modifier) => (
          modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
        ))) continue;
      }
      collectTypeNodeNamedTypes(checker, member, referencedTypes);
    }
  }
}

function isTypeScriptPlatformType(program, referencedType) {
  const declarations = referencedType.declarations ?? [];
  return declarations.length > 0
    && declarations.some((declaration) => (
      program.isSourceFileDefaultLibrary(declaration.getSourceFile())
    ));
}

function referencedTypeDeclarationBasis(program, referencedType) {
  return [...new Set((referencedType.declarations ?? []).map((declaration) => {
    const sourceFile = declaration.getSourceFile();
    if (program.isSourceFileDefaultLibrary(sourceFile)) {
      return `typescript:${basename(sourceFile.fileName)}`;
    }
    const packageMetadata = declarationPackageMetadata(sourceFile);
    if (!packageMetadata) return sourceFile.fileName;
    return `${packageMetadata.name}:${relativeOutputPath(packageMetadata.root, sourceFile.fileName)}`;
  }))].sort().join(', ');
}

function symbolDeclarationIdentity(symbol) {
  const declarations = symbol?.declarations ?? [];
  if (declarations.length === 0) return null;
  return declarations.map((declaration) => {
    const sourceFile = declaration.getSourceFile();
    const physicalSource = ts.sys.realpath?.(sourceFile.fileName) ?? resolve(sourceFile.fileName);
    return `${physicalSource}:${declaration.pos}:${declaration.end}`;
  }).sort().join('|');
}

function explicitPublishedPackageSpecifiers(packageMetadata) {
  const packageExports = packageMetadata.exports;
  if (!packageExports || typeof packageExports !== 'object' || Array.isArray(packageExports)) {
    return [packageMetadata.name];
  }
  const exportKeys = Object.keys(packageExports);
  if (!exportKeys.some((key) => key.startsWith('.'))) return [packageMetadata.name];
  return exportKeys
    .filter((key) => (key === '.' || key.startsWith('./')) && !key.includes('*') && key !== './package.json')
    .map((key) => (key === '.' ? packageMetadata.name : `${packageMetadata.name}/${key.slice(2)}`));
}

const PUBLISHED_PACKAGE_TYPE_IDENTITIES_CACHE = new Map();

function publishedPackageTypeIdentities(program, packageMetadata, containingFile) {
  if (PUBLISHED_PACKAGE_TYPE_IDENTITIES_CACHE.has(packageMetadata.root)) {
    return PUBLISHED_PACKAGE_TYPE_IDENTITIES_CACHE.get(packageMetadata.root);
  }
  const rootNames = explicitPublishedPackageSpecifiers(packageMetadata).flatMap((specifier) => {
    const resolution = ts.resolveModuleName(
      specifier,
      containingFile,
      program.getCompilerOptions(),
      ts.sys,
    ).resolvedModule;
    return resolution ? [resolution.resolvedFileName] : [];
  });
  const publicProgram = ts.createProgram({
    rootNames: [...new Set(rootNames)],
    options: program.getCompilerOptions(),
  });
  const publicChecker = publicProgram.getTypeChecker();
  const identities = new Set();
  for (const rootName of rootNames) {
    const sourceFile = publicProgram.getSourceFile(rootName)
      ?? publicProgram.getSourceFiles().find((candidate) => (
        resolve(candidate.fileName) === resolve(rootName)
      ));
    if (!sourceFile) continue;
    const moduleSymbol = publicChecker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of publicChecker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolvedSymbol(publicChecker, exported);
      if (!(symbol.flags & ts.SymbolFlags.Type)) continue;
      const identity = symbolDeclarationIdentity(symbol);
      if (identity) identities.add(identity);
      const directAliasTarget = directTypeAliasTargetSymbol(publicChecker, symbol);
      const targetIdentity = directAliasTarget && symbolDeclarationIdentity(directAliasTarget);
      if (targetIdentity) identities.add(targetIdentity);
    }
  }
  PUBLISHED_PACKAGE_TYPE_IDENTITIES_CACHE.set(packageMetadata.root, identities);
  return identities;
}

function isPublishedThirdPartyType(program, referencedType) {
  const declarations = (referencedType.declarations ?? []).filter((declaration) => (
    !program.isSourceFileDefaultLibrary(declaration.getSourceFile())
  ));
  if (declarations.length === 0) return false;
  const packageMetadata = declarationPackageMetadata(declarations[0].getSourceFile());
  if (
    !packageMetadata
    || packageMetadata.name.startsWith('@happier-dev/')
    || packageMetadata.private
  ) return false;
  if (packageMetadata.name === '@types/node') return true;
  if (!declarations.every((declaration) => {
    const packageMetadata = declarationPackageMetadata(declaration.getSourceFile());
    return packageMetadata
      && typeof packageMetadata.name === 'string'
      && packageMetadata.root === declarationPackageMetadata(declarations[0].getSourceFile())?.root;
  })) return false;
  const identity = symbolDeclarationIdentity(referencedType);
  return identity !== null && publishedPackageTypeIdentities(
    program,
    packageMetadata,
    declarations[0].getSourceFile().fileName,
  ).has(identity);
}

function directTypeAliasTargetSymbol(checker, symbol) {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isTypeAliasDeclaration(declaration)) continue;
    let targetNode = declaration.type;
    while (ts.isParenthesizedTypeNode(targetNode)) targetNode = targetNode.type;
    if (!ts.isTypeReferenceNode(targetNode)) continue;
    const target = checker.getSymbolAtLocation(targetNode.typeName);
    if (target && !(target.flags & ts.SymbolFlags.TypeParameter)) {
      return resolvedSymbol(checker, target);
    }
  }
  return null;
}

function assertAuthorSignatureTypeClosure({ program, inventory, sources }) {
  const checker = program.getTypeChecker();
  const sourceByModule = new Map(sources.map((source) => [source.sourceModule, source]));
  const sourceFileByModule = new Map(
    sources.map((source) => [source.sourceModule, sourceFileForPreflightedModule(program, source)]),
  );
  const authorSpecifiers = new Set(
    inventory.entrypoints
      .filter((entrypoint) => entrypoint.visibility === 'author')
      .map((entrypoint) => entrypoint.specifier),
  );

  const reachableAuthorTypes = new Set();
  const authorRowsBySymbol = new Map();
  const addAuthorRowForSymbol = (symbol, row) => {
    if (!symbol) return;
    const rows = authorRowsBySymbol.get(symbol) ?? [];
    rows.push(row);
    authorRowsBySymbol.set(symbol, rows);
  };
  for (const row of inventory.symbols) {
    if (!authorSpecifiers.has(row.specifier)) continue;
    const sourceFile = sourceFileByModule.get(row.sourceModule);
    if (!sourceFile) continue;
    const symbol = exportedModuleSymbol(checker, sourceFile, row.sourceExport);
    if (!symbol) continue;
    addAuthorRowForSymbol(symbol, row);
    if (symbol.flags & ts.SymbolFlags.Type) {
      reachableAuthorTypes.add(symbol);
      const directAliasTarget = directTypeAliasTargetSymbol(checker, symbol);
      if (directAliasTarget) {
        reachableAuthorTypes.add(directAliasTarget);
        addAuthorRowForSymbol(directAliasTarget, row);
      }
    }
  }
  const canonicalAuthorSchemaProjectionTypes = readCanonicalAuthorSchemaProjectionTypes({
    checker,
    inventory,
    sourceFileByModule,
    reachableAuthorTypes,
  });

  const failures = [];
  let activeRow = null;
  try {
    for (const row of inventory.symbols) {
      activeRow = row;
      if (!authorSpecifiers.has(row.specifier)) continue;
      const source = sourceByModule.get(row.sourceModule);
      const sourceFile = sourceFileByModule.get(row.sourceModule);
      if (!source || !sourceFile) continue;
      const exportedSymbol = exportedModuleExportSymbol(checker, sourceFile, row.sourceExport);
      const symbol = exportedSymbol ? resolvedSymbol(checker, exportedSymbol) : null;
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!symbol || !declaration) continue;
      const directReferencedTypes = new Map();
      const seenTypes = new Set();
      const seenMemberSurfaces = new Set();
      const valueType = row.kind === 'value'
        ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
        : null;
      const schemaProjection = valueType && directProtocolSchemaProjection(
        checker,
        sourceFile,
        row.sourceExport,
        valueType,
        canonicalAuthorSchemaProjectionTypes,
        reachableAuthorTypes,
      );
      if (schemaProjection) {
        directReferencedTypes.set(schemaProjection.symbol, schemaProjection.symbol.getName());
        if (schemaProjection.kind === 'composable') {
          collectComposableProjectionOutputTypes(checker, valueType, directReferencedTypes, seenTypes);
        }
      } else {
        for (const symbolDeclaration of symbol.declarations ?? []) {
          collectDeclarationSignatureTypeNodes(checker, symbolDeclaration, directReferencedTypes);
        }
      }
      const referencedTypes = new Map(directReferencedTypes);
      const hasExplicitVariableType = (symbol.declarations ?? []).some((symbolDeclaration) => (
        ts.isVariableDeclaration(symbolDeclaration) && symbolDeclaration.type !== undefined
      ));
      const hasExplicitFunctionReturnType = (symbol.declarations ?? []).some((symbolDeclaration) => (
        ts.isFunctionDeclaration(symbolDeclaration) && symbolDeclaration.type !== undefined
      ));
      if (
        valueType
        && !schemaProjection
        && !hasExplicitVariableType
        && !hasExplicitFunctionReturnType
      ) {
        const namedValueType = namedSignatureTypeSymbol(checker, valueType);
        if (
          namedValueType
          && (
            reachableAuthorTypes.has(namedValueType)
            || isTypeScriptPlatformType(program, namedValueType)
            || isPublishedThirdPartyType(program, namedValueType)
          )
        ) {
          collectNamedSignatureTypes(checker, valueType, referencedTypes, seenTypes);
        } else {
          collectPublicTypeMembers(
            checker,
            valueType,
            referencedTypes,
            seenTypes,
            seenMemberSurfaces,
          );
        }
      }
      for (const [referencedType, name] of referencedTypes) {
        if (
          !isTypeScriptPlatformType(program, referencedType)
          && !isPublishedThirdPartyType(program, referencedType)
          && !reachableAuthorTypes.has(referencedType)
        ) {
          failures.push(
            `API surface author ${row.kind} ${row.sourceModule}#${row.sourceExport} public signature references author type ${name}, which is absent from the author inventory (declarations: ${referencedTypeDeclarationBasis(program, referencedType)})`,
          );
        }
      }
    }
  } catch (error) {
    const context = activeRow
      ? `${activeRow.kind} ${activeRow.sourceModule}#${activeRow.sourceExport}`
      : 'unknown author symbol';
    throw new Error(
      `API surface author signature traversal failed for ${context}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (failures.length > 0) throw new Error([...new Set(failures)].sort().join('\n'));
}

async function stageChangedOutputs(outputs) {
  const staged = [];
  try {
    for (const [index, output] of outputs.entries()) {
      if (!output.changed) continue;
      const temporaryPath = join(
        dirname(output.absolutePath),
        `.${basename(output.absolutePath)}.api-surface-${process.pid}-${index}.tmp`,
      );
      await writeFile(temporaryPath, output.contents, { encoding: 'utf8', flag: 'wx' });
      staged.push(Object.freeze({ output, temporaryPath }));
    }
    return staged;
  } catch (error) {
    await Promise.all(staged.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
    throw error;
  }
}

async function commitStagedOutputs(staged, renameFile = rename) {
  const promoted = [];
  try {
    for (const stagedOutput of staged) {
      const { output, temporaryPath } = stagedOutput;
      await renameFile(temporaryPath, output.absolutePath);
      promoted.push(stagedOutput);
    }
  } catch (promotionError) {
    const rollbackErrors = [];
    for (const { output, temporaryPath } of promoted.reverse()) {
      try {
        if (output.originalContents === null) {
          await unlink(output.absolutePath);
        } else {
          await writeFile(temporaryPath, output.originalContents, { encoding: 'utf8', flag: 'wx' });
          await renameFile(temporaryPath, output.absolutePath);
        }
      } catch (rollbackError) {
        if (!(output.originalContents === null && rollbackError?.code === 'ENOENT')) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [promotionError, ...rollbackErrors],
        'API surface promotion failed and one or more original outputs could not be restored',
        { cause: promotionError },
      );
    }
    throw promotionError;
  } finally {
    await Promise.all(staged.map(({ temporaryPath }) => unlink(temporaryPath).catch(() => undefined)));
  }
}

function publicationSpecDeprecation(statement, publicationSpecModule) {
  const docs = ts.getJSDocCommentsAndTags(statement);
  const text = docs.length > 0 ? docs[docs.length - 1].getText() : '';
  const retiredPosture = RETIRED_PER_SYMBOL_POSTURE.exec(text);
  if (retiredPosture) {
    throw new Error(
      `API surface publication spec ${publicationSpecModule} must not use retired per-symbol @${retiredPosture[1]} posture metadata`,
    );
  }
  if (PUBLISHER_OWNED_SINCE.test(text)) {
    throw new Error(
      `API surface publication spec ${publicationSpecModule} must not use publisher-owned @since metadata`,
    );
  }
  return parseStructuredDeprecationTags(
    ts.getJSDocTags(statement),
    `API surface publication spec ${publicationSpecModule}`,
  );
}

function assertSourceHasNoRetiredPerSymbolPosture(source) {
  const retiredPosture = RETIRED_PER_SYMBOL_POSTURE.exec(source.contents);
  if (retiredPosture) {
    throw new Error(
      `API surface source ${source.sourceModule} must not use retired per-symbol @${retiredPosture[1]} posture metadata`,
    );
  }
  if (PUBLISHER_OWNED_SINCE.test(source.contents)) {
    throw new Error(
      `API surface source ${source.sourceModule} must not use publisher-owned @since metadata`,
    );
  }
}

/**
 * Reads what one author-owned named-reexport publication spec publishes. The
 * generated entrypoint barrel is never an input, so this spec — not prior
 * generated bytes or the inventory — decides which symbols an entrypoint
 * carries.
 */
function collectPublicationSpecPublications(publicationSpec) {
  const sourceFile = ts.createSourceFile(
    publicationSpec.sourceModule,
    publicationSpec.contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const publications = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement)
      || !statement.moduleSpecifier
      || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || !statement.exportClause
      || !ts.isNamedExports(statement.exportClause)
    ) {
      throw new Error(
        `API surface publication spec ${publicationSpec.sourceModule} must contain only named re-export declarations`,
      );
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    if (!moduleSpecifier.startsWith('./') && !moduleSpecifier.startsWith('../')) {
      throw new Error(
        `API surface publication spec ${publicationSpec.sourceModule} must re-export package-local modules, not ${moduleSpecifier}`,
      );
    }
    const deprecation = publicationSpecDeprecation(statement, publicationSpec.sourceModule);
    for (const element of statement.exportClause.elements) {
      publications.push(Object.freeze({
        ...deprecation,
        exportName: element.name.text,
        sourceExport: (element.propertyName ?? element.name).text,
        kind: statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
        moduleSpecifier,
      }));
    }
  }
  if (publications.length === 0) {
    throw new Error(`API surface publication spec ${publicationSpec.sourceModule} publishes no symbols`);
  }
  return publications;
}

async function resolvePublicationSpecSourceModule(
  packageRoot,
  physicalPackageRoot,
  publicationSpec,
  moduleSpecifier,
) {
  for (const candidatePath of sourceModuleCandidates(publicationSpec.absolutePath, moduleSpecifier)) {
    if (!isWithinPackageRoot(packageRoot, candidatePath)) {
      throw new Error(
        `API surface publication spec ${publicationSpec.sourceModule} re-exports outside the package root: ${moduleSpecifier}`,
      );
    }
    const target = await optionalLstat(candidatePath);
    if (!target?.isFile()) continue;
    const physicalPath = await realpath(candidatePath);
    if (!isWithinPackageRoot(physicalPackageRoot, physicalPath)) {
      throw new Error(
        `API surface publication spec ${publicationSpec.sourceModule} re-exports outside the package root: ${moduleSpecifier}`,
      );
    }
    return relativeOutputPath(packageRoot, candidatePath);
  }
  throw new Error(
    `API surface publication spec ${publicationSpec.sourceModule} cannot resolve re-exported module ${moduleSpecifier}`,
  );
}

function entrypointSpecifierFromPublicationSpecModule(publicationSpecModule) {
  if (publicationSpecModule === 'src/index.public.ts') return '.';
  const match = /^src\/(.+)\/index\.public\.ts$/u.exec(publicationSpecModule);
  if (!match) {
    throw new Error(
      `API surface publication spec must be rooted at src/**/index.public.ts: ${publicationSpecModule}`,
    );
  }
  return `./${match[1]}`;
}

async function discoverPublicationSpecs({ packageRoot, physicalPackageRoot }) {
  const sourceRoot = join(packageRoot, 'src');
  const sourceRootStat = await optionalLstat(sourceRoot);
  if (!sourceRootStat?.isDirectory()) {
    throw new Error(`API surface publication-spec source root must be an existing directory: ${sourceRoot}`);
  }

  const publicationSpecs = [];
  const publicationSpecByFoldedSpecifier = new Map();
  const publicationSpecByFoldedPhysicalPath = new Map();
  const pendingDirectories = [{
    logicalPath: sourceRoot,
    physicalAncestors: new Set(),
  }];

  while (pendingDirectories.length > 0) {
    const { logicalPath, physicalAncestors } = pendingDirectories.pop();
    const physicalPath = await realpath(logicalPath);
    if (!isWithinPackageRoot(physicalPackageRoot, physicalPath)) {
      throw new Error(
        `API surface publication-spec directory resolves outside package root: ${relativeOutputPath(packageRoot, logicalPath)}`,
      );
    }
    const physicalDirectory = await lstat(physicalPath);
    if (!physicalDirectory.isDirectory()) {
      throw new Error(
        `API surface publication-spec path must resolve to a directory: ${relativeOutputPath(packageRoot, logicalPath)}`,
      );
    }

    const nestedAncestors = new Set(physicalAncestors);
    nestedAncestors.add(physicalPath.toLowerCase());
    const entries = await readdir(logicalPath, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const entryPath = join(logicalPath, entry.name);
      if (entry.name === 'index.public.ts') {
        const publicationSpec = await preflightSourceModule(
          packageRoot,
          physicalPackageRoot,
          relativeOutputPath(packageRoot, entryPath),
        );
        const specifier = entrypointSpecifierFromPublicationSpecModule(publicationSpec.sourceModule);
        const foldedSpecifier = specifier.toLowerCase();
        const existingSpecifier = publicationSpecByFoldedSpecifier.get(foldedSpecifier);
        if (existingSpecifier && existingSpecifier.specifier !== specifier) {
          throw new Error(
            `API surface publication specifier ${specifier} has a case-insensitive collision with ${existingSpecifier.specifier}`,
          );
        }
        const foldedPhysicalPath = publicationSpec.physicalPath.toLowerCase();
        const existingPhysicalPath = publicationSpecByFoldedPhysicalPath.get(foldedPhysicalPath);
        if (existingPhysicalPath) {
          throw new Error(
            `API surface publication specs ${existingPhysicalPath.publicationSpec.sourceModule} and ${publicationSpec.sourceModule} resolve to the same package file`,
          );
        }
        const entrypoint = Object.freeze({ specifier, publicationSpec });
        publicationSpecByFoldedSpecifier.set(foldedSpecifier, entrypoint);
        publicationSpecByFoldedPhysicalPath.set(foldedPhysicalPath, entrypoint);
        publicationSpecs.push(entrypoint);
        continue;
      }

      const entryPhysicalPath = await realpath(entryPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!entryPhysicalPath) continue;
      if (!isWithinPackageRoot(physicalPackageRoot, entryPhysicalPath)) {
        throw new Error(
          `API surface publication-spec directory resolves outside package root: ${relativeOutputPath(packageRoot, entryPath)}`,
        );
      }
      const entryPhysicalStat = await lstat(entryPhysicalPath);
      if (!entryPhysicalStat.isDirectory()) continue;
      if (nestedAncestors.has(entryPhysicalPath.toLowerCase())) continue;
      pendingDirectories.push({
        logicalPath: entryPath,
        physicalAncestors: nestedAncestors,
      });
    }
  }

  if (publicationSpecs.length === 0) {
    throw new Error('Plugin SDK source must declare at least one author-owned publication spec');
  }
  return publicationSpecs.sort((left, right) => (
    left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0
  ));
}

/**
 * Reads everything package source publishes: its author-owned publication
 * specs, what each one re-exports and which realm-split browser entries exist.
 * Generated entrypoint barrels, package exports, and the inventory are outputs
 * only. This is the only input the inventory is produced from.
 */
async function readPublishedApiSurfaceSource({ packageRoot, physicalPackageRoot }) {
  const entrypoints = [];
  const sourceModules = new Set();
  for (const { specifier, publicationSpec } of await discoverPublicationSpecs({
    packageRoot,
    physicalPackageRoot,
  })) {
    const symbols = await Promise.all(
      collectPublicationSpecPublications(publicationSpec).map(async (publication) => {
        const sourceModule = await resolvePublicationSpecSourceModule(
          packageRoot,
          physicalPackageRoot,
          publicationSpec,
          publication.moduleSpecifier,
        );
        return Object.freeze({ ...publication, sourceModule });
      }),
    );
    for (const symbol of symbols) sourceModules.add(symbol.sourceModule);
    const browserSourceModule = apiSurfaceEntrypointBrowserSourceModule(specifier);
    const browserSource = await optionalLstat(resolve(packageRoot, browserSourceModule));
    if (browserSource) {
      assertSourceHasNoRetiredPerSymbolPosture(await preflightSourceModule(
        packageRoot,
        physicalPackageRoot,
        browserSourceModule,
      ));
    }
    entrypoints.push(Object.freeze({
      specifier,
      browserRuntimeTarget: browserSource?.isFile()
        ? apiSurfaceEntrypointBrowserRuntimeTarget(specifier)
        : undefined,
      symbols: Object.freeze(symbols),
    }));
  }
  return Object.freeze({
    entrypoints: Object.freeze(entrypoints),
    sourceModules: Object.freeze([...sourceModules].sort()),
  });
}

async function prepareApiSurfaceMaterialization(
  options,
  {
    requireVendoredWorkspaceDeclarations = true,
  } = {},
) {
  assertPublicationOptions(options);
  const packageRoot = resolve(options.packageRoot);
  reportProgress(options, 'package-root');
  const packageRootStat = await optionalLstat(packageRoot);
  if (!packageRootStat?.isDirectory()) {
    throw new Error(`Plugin SDK package root must be an existing directory: ${packageRoot}`);
  }
  const physicalPackageRoot = await realpath(packageRoot);

  // Every production materializer phase answers type questions through whatever
  // `@happier-dev/*` copy this package resolves. Prove that copy is the current
  // workspace build before reading a single type, or the whole run reports on
  // a previous one. The source-only test harness below intentionally omits
  // this publisher-output freshness gate; it cannot write and is not reachable
  // from the production CLI.
  if (requireVendoredWorkspaceDeclarations) {
    reportProgress(options, 'vendored-declarations');
    await assertVendoredWorkspaceDeclarationsAreCurrent({ packageRoot });
  }

  const inventoryPath = join(packageRoot, 'api-surface.json');
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath, 'Plugin SDK package.json');
  reportProgress(options, 'source-preflight');
  const published = await readPublishedApiSurfaceSource({
    packageRoot,
    physicalPackageRoot,
  });
  const preflightedSourceModules = await Promise.all(
    published.sourceModules.map((sourceModule) => (
      preflightSourceModule(packageRoot, physicalPackageRoot, sourceModule)
    )),
  );
  for (const sourceModule of preflightedSourceModules) {
    assertSourceHasNoRetiredPerSymbolPosture(sourceModule);
  }
  reportProgress(options, 'inventory');
  const canonicalSourceExports = projectCanonicalSourceExports(preflightedSourceModules);
  const sourceInventory = projectApiSurfaceInventory({
    entrypoints: published.entrypoints.map((entrypoint) => ({
      specifier: entrypoint.specifier,
      browserRuntimeTarget: entrypoint.browserRuntimeTarget,
      symbols: entrypoint.symbols.map((symbol) => ({
        ...symbol,
        realm: canonicalSourceExport(
          canonicalSourceExports,
          symbol.sourceModule,
          symbol.sourceExport,
        ).realm,
      })),
    })),
  });
  const previousPublishedInventory = await readPreviousPublishedApiSurfaceInventory(options);
  const inventory = options.publishedVersion !== undefined
    ? projectPublishedApiSurfaceInventory({
      inventory: sourceInventory,
      publishedVersion: options.publishedVersion,
      previousPublishedInventory,
    })
    : sourceInventory;
  const generationPlan = createApiSurfaceGenerationPlan(inventory);
  // Building the public-surface program is the single most expensive phase, and
  // the signature-closure assertion and the declaration report must both read
  // the same one. Create it once, lazily, so the inventory-only readers below
  // never pay for it.
  let sharedPublicSurfaceProgram;
  const publicSurfaceProgram = () => {
    sharedPublicSurfaceProgram ??= createPublicSurfaceProgram(
      preflightedSourceModules.map((source) => source.absolutePath),
      packageRoot,
    );
    return sharedPublicSurfaceProgram;
  };
  return Object.freeze({
    packageRoot,
    physicalPackageRoot,
    inventoryPath,
    packageJsonPath,
    packageJson,
    publicSurfaceProgram,
    preflightedSourceModules: Object.freeze(preflightedSourceModules),
    canonicalSourceExports,
    inventory,
    publication: options.publishedVersion === undefined
      ? undefined
      : Object.freeze({
        publishedVersion: options.publishedVersion,
        previousPublishedInventoryPath: options.previousPublishedInventoryPath,
      }),
    generationPlan,
  });
}

/**
 * Projects the current author-owned publication specs into the SDK inventory
 * for source consumers such as pack staging. This never reads a generated
 * inventory or writes public-contract outputs.
 */
export async function readCurrentApiSurfaceInventory({ packageRoot }) {
  const prepared = await prepareApiSurfaceMaterialization({ packageRoot });
  return prepared.inventory;
}

function buildApiSurfaceOutputs(prepared, additionalOutputs) {
  const {
    packageRoot,
    inventoryPath,
    packageJsonPath,
    packageJson,
    inventory,
    generationPlan,
  } = prepared;
  return [
    Object.freeze({
      owner: 'apiSurfaceInventory',
      absolutePath: inventoryPath,
      relativePath: 'api-surface.json',
      contents: `${JSON.stringify(inventory, null, 2)}\n`,
    }),
    Object.freeze({
      owner: 'packageExports',
      absolutePath: packageJsonPath,
      relativePath: 'package.json',
      contents: renderPackageJson(packageJson, generationPlan.packageExports),
    }),
    ...Object.entries(generationPlan.sourceBarrels).map(([sourceModule, contents]) => Object.freeze({
      owner: 'sourceBarrels',
      absolutePath: resolve(packageRoot, sourceModule),
      relativePath: sourceModule,
      contents,
    })),
    Object.freeze({
      owner: 'authorApiMarkdown',
      absolutePath: join(packageRoot, 'API.md'),
      relativePath: 'API.md',
      contents: generationPlan.authorApiMarkdown,
    }),
    ...additionalOutputs,
  ];
}

async function finalizeApiSurfaceMaterialization(
  prepared,
  options,
  { additionalOutputs = [], materializedPlanOutputs },
) {
  const {
    packageRoot,
    physicalPackageRoot,
    packageJson,
    preflightedSourceModules,
    canonicalSourceExports,
    inventory,
    publication,
    generationPlan,
  } = prepared;
  reportProgress(options, 'output-preflight');
  const outputs = buildApiSurfaceOutputs(prepared, additionalOutputs);
  const preflightedOutputs = await Promise.all(
    outputs.map((output) => preflightOutput(packageRoot, physicalPackageRoot, output)),
  );
  assertUniqueOutputDestinations(preflightedOutputs);
  reportProgress(options, 'source-projection');
  assertCanonicalSourcesAreNotGeneratedBarrels(preflightedSourceModules, preflightedOutputs);
  await assertCanonicalSourcesDoNotReachGeneratedBarrels({
    inventory,
    sources: preflightedSourceModules,
    outputs: preflightedOutputs,
    packageRoot,
    physicalPackageRoot,
  });
  assertCanonicalSourceProjections(inventory, canonicalSourceExports);
  reportProgress(options, 'author-signature-closure');
  assertAuthorSignatureTypeClosure({
    program: prepared.publicSurfaceProgram(),
    inventory,
    sources: preflightedSourceModules,
  });
  reportProgress(options, 'realm-closure');
  await assertInventoryValueRealmClosures({
    inventory,
    packageJson,
    sources: preflightedSourceModules,
    outputs: preflightedOutputs,
    packageRoot,
  });
  const changedOutputs = preflightedOutputs.filter((output) => output.changed);

  if (options.write) {
    reportProgress(options, 'write-outputs');
    const staged = await stageChangedOutputs(changedOutputs);
    await commitStagedOutputs(staged, options.renameFile);
  }

  return Object.freeze({
    schemaVersion: 1,
    mode: options.write ? 'write' : options.check ? 'check' : 'dry-run',
    status: options.write || changedOutputs.length === 0 ? 'current' : 'drift',
    sourceToolingComplete: true,
    packageRoot,
    inventoryPath: prepared.inventoryPath,
    ...(publication === undefined ? {} : { publication }),
    materializedPlanOutputs,
    inMemoryPlanOutputs: IN_MEMORY_PLAN_OUTPUTS,
    unmaterializedPlanOutputs: Object.freeze([]),
    summary: Object.freeze({
      plannedFiles: preflightedOutputs.length,
      changedFiles: changedOutputs.length,
      writtenFiles: options.write ? changedOutputs.length : 0,
    }),
    files: Object.freeze(preflightedOutputs.map((output) => Object.freeze({
      owner: output.owner,
      path: relativeOutputPath(packageRoot, output.absolutePath),
      changed: output.changed,
      written: options.write && output.changed,
      summary: output.relativePath === PUBLIC_DECLARATION_REPORT_PATH
        ? renderDeclarationDiffSample(summarizeDeclarationDiff(output.originalContents, output.contents))
        : Object.freeze([]),
    }))),
    generationPlan,
  });
}

/**
 * Runs the package-owned API-surface materializer. This lower-level owner
 * projects the inventory, package exports, source barrels, and author API
 * index. It is the pre-emission phase: a changed `*.public.ts` may require a
 * generated barrel write before TypeScript can emit the declarations the full
 * publisher verifies. Its source outputs still use the same atomic corridor;
 * the caller compiles after this phase, then runs the full publisher below.
 */
export async function runApiSurfaceMaterializer(options) {
  const prepared = await prepareApiSurfaceMaterialization(options);
  return finalizeApiSurfaceMaterialization(prepared, options, {
    materializedPlanOutputs: API_SURFACE_MATERIALIZED_PLAN_OUTPUTS,
  });
}

/**
 * Test-only source harness for author-spec, source-projection, signature, and
 * realm contracts when the sole publisher has not yet refreshed vendored
 * declarations. It deliberately accepts no write/check/rename options, so it
 * cannot weaken or bypass the production CLI's freshness guard.
 */
export async function runApiSurfaceSourceHarnessForTests({ packageRoot, onProgress = undefined }) {
  const options = Object.freeze({
    packageRoot,
    write: false,
    check: false,
    onProgress,
  });
  const prepared = await prepareApiSurfaceMaterialization(options, {
    requireVendoredWorkspaceDeclarations: false,
  });
  const report = await finalizeApiSurfaceMaterialization(prepared, options, {
    materializedPlanOutputs: API_SURFACE_MATERIALIZED_PLAN_OUTPUTS,
  });
  // The production CLI reports output state only. This test-only harness also
  // exposes the already-validated source projection so source tests can assert
  // realm and entrypoint contracts without reading a stale generated inventory.
  return Object.freeze({ ...report, inventory: prepared.inventory });
}

/**
 * Runs the complete SDK public-contract publisher. The capability matrix is
 * intentionally created here, from the real package source, and published in
 * the same all-output transaction as the API-surface artifacts. Its emitted
 * declaration check deliberately runs only after the pre-emission materializer
 * and compiler have produced current `dist` output; it never falls back to a
 * source graph.
 */
export async function runApiSurfaceCli(options) {
  const prepared = await prepareApiSurfaceMaterialization(options);
  const { createCapabilityMatrixOutput } = await import('./capabilityMatrixCli.mjs');
  const capabilityMatrixOutput = await createCapabilityMatrixOutput({
    packageRoot: prepared.packageRoot,
    apiInventory: prepared.inventory,
  });
  reportProgress(options, 'declaration-report');
  const emittedDeclarationSurface = projectPreparedDeclarationSurface({
    packageRoot: prepared.packageRoot,
    packageJson: prepared.packageJson,
    title: PUBLIC_DECLARATION_REPORT_TITLE,
    bundledDependencies: prepared.packageJson.bundledDependencies ?? [],
  });
  assertInventoryMatchesPreparedDeclarationSurface({
    inventory: prepared.inventory,
    entrypoints: emittedDeclarationSurface.entrypoints,
    rows: emittedDeclarationSurface.rows,
  });
  return finalizeApiSurfaceMaterialization(prepared, options, {
    additionalOutputs: [
      Object.freeze({
        owner: capabilityMatrixOutput.owner,
        absolutePath: join(prepared.packageRoot, capabilityMatrixOutput.relativePath),
        relativePath: capabilityMatrixOutput.relativePath,
        contents: capabilityMatrixOutput.contents,
      }),
      Object.freeze({
        owner: 'publicDeclarationReport',
        absolutePath: join(prepared.packageRoot, PUBLIC_DECLARATION_REPORT_PATH),
        relativePath: PUBLIC_DECLARATION_REPORT_PATH,
        contents: emittedDeclarationSurface.declarationReport,
      }),
    ],
    materializedPlanOutputs: MATERIALIZED_PLAN_OUTPUTS,
  });
}

export function createApiSurfaceProgressReporter({
  now = () => performance.now(),
  write = (line) => process.stderr.write(line),
} = {}) {
  const startedAt = now();
  let previousAt = startedAt;
  return (phase) => {
    const currentAt = now();
    write(
      `api-surface: phase=${phase} deltaMs=${Math.round(currentAt - previousAt)} totalMs=${Math.round(currentAt - startedAt)}\n`,
    );
    previousAt = currentAt;
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseApiSurfaceCliArgs(args);
  const onProgress = createApiSurfaceProgressReporter();
  const report = options.materializeSource
    ? await runApiSurfaceMaterializer({ ...options, onProgress })
    : await runApiSurfaceCli({ ...options, onProgress });
  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderCliSummary(report));
  if (options.check && report.summary.changedFiles > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
