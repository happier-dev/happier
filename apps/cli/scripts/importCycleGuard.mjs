import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const CLI_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_SOURCE_ROOT = resolve(CLI_ROOT, 'src');
const DEFAULT_TSCONFIG_PATH = resolve(CLI_ROOT, 'tsconfig.json');
const DEFAULT_BASELINE_PATH = resolve(SCRIPT_DIR, 'importCycleGuard.baseline.json');
const RUNTIME_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const TEST_FILE_PATTERN = /(^|\.)(test|spec)\.[cm]?tsx?$/;
const TEST_SUPPORT_FILE_PATTERN = /\.(?:testkit|testUtils)\.[cm]?tsx?$/;
const TEST_SETUP_FILE_PATTERN = /^test-setup\.[cm]?tsx?$/;
const BASELINE_VERSION = 1;

export function analyzeRuntimeImportCycles(params = {}) {
  const sourceRoot = normalizeAbsolutePath(params.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const tsconfigPath = normalizeAbsolutePath(params.tsconfigPath ?? DEFAULT_TSCONFIG_PATH);
  const parsedConfig = readTsconfig(tsconfigPath);
  const runtimeFiles = parsedConfig.fileNames
    .map(normalizeAbsolutePath)
    .filter((filePath) => isRuntimeSourceFile(filePath, sourceRoot))
    .sort(compareStrings);
  const runtimeFileSet = new Set(runtimeFiles);
  const graph = buildRuntimeImportGraph({
    compilerOptions: parsedConfig.options,
    runtimeFiles,
    runtimeFileSet,
    sourceRoot,
    tsconfigPath,
  });

  return {
    cycles: findRuntimeImportCycles({ graph, sourceRoot }),
    graph: toRelativeGraph(graph, sourceRoot),
    sourceRoot: toPosixPath(sourceRoot),
  };
}

export function compareCyclesToBaseline(params) {
  const baselineCycles = params.baselineCycles.map(normalizeBaselineCycle).sort(compareCycleKeys);
  const currentCycles = params.currentCycles.map(normalizeCycle).sort(compareCycleKeys);
  const baselineByKey = new Map(baselineCycles.map((cycle) => [formatCycleKey(cycle), cycle]));
  const currentByKey = new Map(currentCycles.map((cycle) => [formatCycleKey(cycle), cycle]));

  const allowedCycles = currentCycles.filter((cycle) => baselineByKey.has(formatCycleKey(cycle)));
  const newCycles = currentCycles.filter((cycle) => !baselineByKey.has(formatCycleKey(cycle)));
  const staleBaselineCycles = baselineCycles.filter((cycle) => !currentByKey.has(formatCycleKey(cycle)));

  return {
    allowedCycles,
    newCycles,
    staleBaselineCycles,
  };
}

export function formatCycleKey(cycle) {
  return [...cycle.files].sort(compareStrings).join('\n');
}

export function readBaselineCycles(baselinePath = DEFAULT_BASELINE_PATH) {
  if (!existsSync(baselinePath)) return [];

  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid import-cycle baseline at ${baselinePath}: expected an object`);
  }
  if (parsed.version !== BASELINE_VERSION) {
    throw new Error(
      `Invalid import-cycle baseline at ${baselinePath}: expected version ${BASELINE_VERSION}`,
    );
  }
  if (!Array.isArray(parsed.cycles)) {
    throw new Error(`Invalid import-cycle baseline at ${baselinePath}: expected cycles array`);
  }

  return parsed.cycles.map(normalizeBaselineCycle).sort(compareCycleKeys);
}

export function serializeBaselineCycles(cycles) {
  return `${JSON.stringify(
    {
      version: BASELINE_VERSION,
      cycles: cycles.map((cycle) => ({
        files: [...cycle.files].sort(compareStrings),
      })),
    },
    null,
    2,
  )}\n`;
}

export function formatGuardFailure(newCycles) {
  const lines = [
    `CLI runtime import-cycle guard failed: ${newCycles.length} new cycle SCC(s) found.`,
    '',
    'Update the baseline only for known debt. Otherwise remove the runtime import cycle.',
  ];

  newCycles.forEach((cycle, index) => {
    lines.push('', `New cycle ${index + 1}:`);
    for (const file of cycle.files) {
      lines.push(`  - ${file}`);
    }
    if (cycle.edges.length > 0) {
      lines.push('  Runtime edges:');
      for (const [from, to] of cycle.edges) {
        lines.push(`    - ${from} -> ${to}`);
      }
    }
  });

  return lines.join('\n');
}

export function parseImportCycleGuardArgs(argv) {
  const options = {
    baselinePath: DEFAULT_BASELINE_PATH,
    help: false,
    sourceRoot: DEFAULT_SOURCE_ROOT,
    tsconfigPath: DEFAULT_TSCONFIG_PATH,
    writeBaseline: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') {
      options.baselinePath = resolveRequiredArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--source-root' || arg === '--src') {
      options.sourceRoot = resolveRequiredArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--tsconfig') {
      options.tsconfigPath = resolveRequiredArg(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--write-baseline' || arg === '--update-baseline') {
      options.writeBaseline = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown import-cycle guard argument: ${arg}`);
  }

  return options;
}

function buildRuntimeImportGraph(params) {
  const graph = new Map(params.runtimeFiles.map((filePath) => [filePath, new Set()]));
  const moduleResolutionHost = createModuleResolutionHost(dirname(params.tsconfigPath));

  for (const filePath of params.runtimeFiles) {
    const sourceText = readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.getScriptKindFromFileName(filePath),
    );
    const imports = collectRuntimeModuleSpecifiers(sourceFile);

    for (const moduleSpecifier of imports) {
      const resolvedFile = resolveModuleSpecifier({
        compilerOptions: params.compilerOptions,
        containingFile: filePath,
        moduleResolutionHost,
        moduleSpecifier,
        runtimeFileSet: params.runtimeFileSet,
        sourceRoot: params.sourceRoot,
      });
      if (resolvedFile) {
        graph.get(filePath)?.add(resolvedFile);
      }
    }
  }

  return sortGraph(graph);
}

function readTsconfig(tsconfigPath) {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatTsDiagnostic(configFile.error));
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(tsconfigPath),
    undefined,
    tsconfigPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(parsedConfig.errors.map(formatTsDiagnostic).join('\n'));
  }

  return parsedConfig;
}

function collectRuntimeModuleSpecifiers(sourceFile) {
  const specifiers = [];

  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && importDeclarationHasRuntimeEdge(node)) {
      const specifier = readStringModuleSpecifier(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
      return;
    }

    if (ts.isExportDeclaration(node) && exportDeclarationHasRuntimeEdge(node)) {
      const specifier = readStringModuleSpecifier(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
      return;
    }

    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      const moduleReference = node.moduleReference;
      if (
        ts.isExternalModuleReference(moduleReference) &&
        moduleReference.expression &&
        ts.isStringLiteral(moduleReference.expression)
      ) {
        specifiers.push(moduleReference.expression.text);
      }
    }
  });

  return specifiers;
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
  if (!exportClause) return true;
  if (ts.isNamespaceExport(exportClause)) return true;
  if (exportClause.elements.length === 0) return true;

  return exportClause.elements.some((element) => !element.isTypeOnly);
}

function readStringModuleSpecifier(moduleSpecifier) {
  if (!moduleSpecifier) return null;
  if (!ts.isStringLiteral(moduleSpecifier)) return null;
  return moduleSpecifier.text;
}

function resolveModuleSpecifier(params) {
  const resolution = ts.resolveModuleName(
    params.moduleSpecifier,
    params.containingFile,
    params.compilerOptions,
    params.moduleResolutionHost,
  );
  const resolvedFileName = resolution.resolvedModule?.resolvedFileName;
  if (!resolvedFileName) return null;

  const resolvedFile = normalizeAbsolutePath(resolvedFileName);
  if (resolvedFile.endsWith('.d.ts')) return null;
  if (!isPathInside(params.sourceRoot, resolvedFile)) return null;
  if (!params.runtimeFileSet.has(resolvedFile)) return null;

  return resolvedFile;
}

function createModuleResolutionHost(currentDirectory) {
  return {
    directoryExists: ts.sys.directoryExists?.bind(ts.sys),
    fileExists: ts.sys.fileExists.bind(ts.sys),
    getCurrentDirectory: () => currentDirectory,
    getDirectories: ts.sys.getDirectories?.bind(ts.sys),
    readFile: ts.sys.readFile.bind(ts.sys),
    realpath: ts.sys.realpath?.bind(ts.sys),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

function findRuntimeImportCycles(params) {
  const components = findStronglyConnectedComponents(params.graph);
  return components
    .filter((component) => {
      if (component.length > 1) return true;
      const filePath = component[0];
      return Boolean(filePath && params.graph.get(filePath)?.has(filePath));
    })
    .map((component) => cycleFromComponent({ component, graph: params.graph, sourceRoot: params.sourceRoot }))
    .sort(compareCycleKeys);
}

function findStronglyConnectedComponents(graph) {
  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let current = null;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.sort(compareStrings));
    }
  }

  for (const node of [...graph.keys()].sort(compareStrings)) {
    if (!indices.has(node)) visit(node);
  }

  return components;
}

function cycleFromComponent(params) {
  const componentSet = new Set(params.component);
  const files = params.component.map((filePath) => toPosixRelative(params.sourceRoot, filePath)).sort(compareStrings);
  const edges = [];

  for (const from of params.component) {
    for (const to of params.graph.get(from) ?? []) {
      if (componentSet.has(to)) {
        edges.push([
          toPosixRelative(params.sourceRoot, from),
          toPosixRelative(params.sourceRoot, to),
        ]);
      }
    }
  }

  return {
    edges: edges.sort(compareTuple),
    files,
  };
}

function normalizeCycle(cycle) {
  return {
    edges: Array.isArray(cycle.edges) ? cycle.edges.map((edge) => [...edge]).sort(compareTuple) : [],
    files: [...cycle.files].sort(compareStrings),
  };
}

function normalizeBaselineCycle(cycle) {
  const files = Array.isArray(cycle) ? cycle : cycle?.files;
  if (!Array.isArray(files) || files.some((filePath) => typeof filePath !== 'string')) {
    throw new Error('Invalid import-cycle baseline entry: expected files array');
  }
  return {
    edges: [],
    files: [...new Set(files)].sort(compareStrings),
  };
}

function sortGraph(graph) {
  return new Map(
    [...graph.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([from, targets]) => [from, new Set([...targets].sort(compareStrings))]),
  );
}

function toRelativeGraph(graph, sourceRoot) {
  return Object.fromEntries(
    [...graph.entries()].map(([from, targets]) => [
      toPosixRelative(sourceRoot, from),
      [...targets].map((target) => toPosixRelative(sourceRoot, target)).sort(compareStrings),
    ]),
  );
}

function isRuntimeSourceFile(filePath, sourceRoot) {
  if (!isPathInside(sourceRoot, filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (!RUNTIME_SOURCE_EXTENSIONS.has(extname(filePath))) return false;

  const relativePath = toPosixRelative(sourceRoot, filePath);
  const segments = relativePath.split('/');
  if (segments.includes('__tests__') || segments.includes('__fixtures__') || segments.includes('testkit')) {
    return false;
  }

  const name = basename(filePath);
  if (TEST_FILE_PATTERN.test(name)) return false;
  if (TEST_SUPPORT_FILE_PATTERN.test(name)) return false;
  if (TEST_SETUP_FILE_PATTERN.test(name)) return false;
  if (name === 'vitestSetup.ts') return false;

  return true;
}

function formatTsDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function normalizeAbsolutePath(filePath) {
  return resolve(filePath);
}

function isPathInside(root, filePath) {
  const relativePath = relative(root, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function toPosixRelative(root, filePath) {
  return toPosixPath(relative(root, filePath));
}

function toPosixPath(filePath) {
  return filePath.split(sep).join('/');
}

function compareCycleKeys(left, right) {
  return compareStrings(formatCycleKey(left), formatCycleKey(right));
}

function compareTuple(left, right) {
  return compareStrings(`${left[0]}\u0000${left[1]}`, `${right[0]}\u0000${right[1]}`);
}

function compareStrings(left, right) {
  return left.localeCompare(right, 'en');
}

function resolveRequiredArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Expected a value after ${flag}`);
  }
  return resolve(value);
}

function printHelp() {
  console.log(`Usage: node scripts/importCycleGuard.mjs [options]

Checks apps/cli/src for static runtime import/export SCCs.

Options:
  --baseline <path>       Baseline JSON path (default: scripts/importCycleGuard.baseline.json)
  --source-root <path>    Source root to analyze (default: src)
  --tsconfig <path>       tsconfig used for module resolution (default: tsconfig.json)
  --write-baseline        Replace the baseline with the currently detected SCCs
  --help                  Show this help
`);
}

function runCli() {
  const options = parseImportCycleGuardArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = analyzeRuntimeImportCycles({
    sourceRoot: options.sourceRoot,
    tsconfigPath: options.tsconfigPath,
  });

  if (options.writeBaseline) {
    writeFileSync(options.baselinePath, serializeBaselineCycles(result.cycles), 'utf8');
    console.log(`Wrote ${result.cycles.length} CLI runtime import-cycle baseline SCC(s) to ${options.baselinePath}`);
    return;
  }

  const baselineCycles = readBaselineCycles(options.baselinePath);
  const comparison = compareCyclesToBaseline({
    baselineCycles,
    currentCycles: result.cycles,
  });

  if (comparison.newCycles.length > 0) {
    console.error(formatGuardFailure(comparison.newCycles));
    process.exitCode = 1;
    return;
  }

  const staleSuffix =
    comparison.staleBaselineCycles.length > 0
      ? `; ${comparison.staleBaselineCycles.length} stale baseline SCC(s) can be pruned`
      : '';
  console.log(
    `CLI runtime import-cycle guard passed: ${comparison.allowedCycles.length} baseline SCC(s), 0 new SCC(s)${staleSuffix}.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
