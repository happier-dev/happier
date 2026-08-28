import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  resolveWorkspaceBundleLockPath,
  withWorkspaceBundleLock,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../../..');
const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages/plugin-sdk');
const WORKSPACE_BUILD_LOCK_PATH = resolveWorkspaceBundleLockPath(REPO_ROOT);
const OUTPUT_PATH = resolve(REPO_ROOT, 'packages/plugin-sdk/src/actions/actionTypeMap.generated.ts');
const PROTOCOL_TSCONFIG_PATH = resolve(REPO_ROOT, 'packages/protocol/tsconfig.json');
const SDK_TSCONFIG_PATH = resolve(REPO_ROOT, 'packages/plugin-sdk/tsconfig.json');
const TYPE_FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation
  | ts.TypeFormatFlags.UseStructuralFallback
  | ts.TypeFormatFlags.MultilineObjectLiterals
  | ts.TypeFormatFlags.InTypeAlias
  | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const RUNTIME_ACTION_SCHEMA = 'ZodType<unknown, unknown, $ZodTypeInternals<unknown, unknown>>';
const OPAQUE_VALIDATOR_BRANDED_STRING = /string & \$brand<'[^']+'>/gu;
const MUTABLE_PROTOCOL_JSON_VALUE = /\bPluginJsonValueV2\b/gu;
const FORBIDDEN_PUBLIC_VALIDATOR_REFERENCE = /(?:['"]zod(?:\/[^'"]*)?['"]|\bz\.[A-Za-z_$]|\bZod[A-Za-z0-9_]*\b|\$(?:brand|Zod[A-Za-z0-9_]*))/u;

export function createActionTypeMapTimingReporter({
  now = () => performance.now(),
  write = (line) => process.stderr.write(line),
} = {}) {
  const startedAt = now();
  let previousAt = startedAt;
  return (phase) => {
    const currentAt = now();
    write(
      `action-type-map: phase=${phase} deltaMs=${Math.round(currentAt - previousAt)} totalMs=${Math.round(currentAt - startedAt)}\n`,
    );
    previousAt = currentAt;
  };
}

/**
 * Recursive aliases which TypeScript intentionally keeps named while printing
 * the canonical Action maps. The Action-owned aliases are public structural
 * closures; shared SDK types are imported from their existing public entries.
 * Generated SDK declarations must not depend on a private Protocol path or a
 * validator-library alias.
 */
const PUBLIC_ACTION_TYPE_CLOSURE = [
  'export type PluginAgentExternalSessionLinkDataArray = readonly PluginAgentExternalSessionLinkDataValue[];',
  'export type PluginAgentExternalSessionLinkDataObject = { readonly [key: string]: PluginAgentExternalSessionLinkDataValue };',
  'export type PluginAgentExternalSessionLinkDataValue = null | boolean | number | string | PluginAgentExternalSessionLinkDataArray | PluginAgentExternalSessionLinkDataObject;',
  '',
  'export type JSONType = string | number | boolean | null | JSONType[] | { [key: string]: JSONType };',
];

/**
 * These are type-only projections of one canonical Protocol Action catalog.
 * Their order supplies the few named helper types intentionally retained by
 * TypeScript's structural printer; all Action ids and map rows are derived.
 */
const TYPE_PROJECTIONS = [
  // These helpers are intentionally file-local. Public Action signatures use
  // them transitively, but exposing their raw Protocol vocabulary would add
  // duplicate SDK entry points rather than an author capability.
  { relativePath: 'packages/protocol/src/actions/executor/types.ts', name: 'ActionCaller', export: true },
  { relativePath: 'packages/protocol/src/plugins/contributions/publicTypes.ts', name: 'PluginPolicyExpressionV2', export: true, local: true },
  { relativePath: 'packages/protocol/src/actions/actionUiPlacements.ts', name: 'ActionUiPlacement', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'ActionSurfaceBindingCaller', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'ActionSurfaceBindingContext', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'ActionSurfaceBindingTransform', export: true },
  { relativePath: 'packages/protocol/src/sessions/work/state/sessionWorkStateRpc.ts', name: 'SessionUsageLimitCheckNowRequestV1Input', export: true },
  { relativePath: 'packages/protocol/src/sessions/work/state/sessionWorkStateRpc.ts', name: 'SessionUsageLimitConsumeResetCreditRequestV1Input', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'SessionTranscriptGetExternalShareableInputV1', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'SessionTranscriptGetExternalShareableResultV1', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'ActionInputFieldHint', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'ActionInputHints', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'ActionInputOption', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'ActionInputOptionValue', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'ActionInputPredicate', export: true },
  { relativePath: 'packages/protocol/src/actions/actionInputHintsRuntime.ts', name: 'EffectiveActionInputField', export: true },
  { relativePath: 'packages/protocol/src/actions/actionExecutionResult.ts', name: 'ActionExecuteResult', export: true },
  { relativePath: 'packages/protocol/src/machines/administration/pluginMachineExecutionOriginV1.ts', name: 'PluginMachineExecutionOriginV1', export: true },
  { relativePath: 'packages/protocol/src/plugins/actions/v2.ts', name: 'PluginActionContributionV2', export: true },
  { relativePath: 'packages/protocol/src/plugins/actions/v2.ts', name: 'PluginToolContributionV2', export: true },
  { relativePath: 'packages/protocol/src/plugins/contributions/v2.ts', name: 'PluginCommandContributionV2', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'ActionSpec', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'PluginActionInputById', export: true },
  { relativePath: 'packages/protocol/src/actions/actionSpecs.ts', name: 'PluginActionResultById', export: true },
];

export function resolveActionTypeProjectionRootNames({
  projections = TYPE_PROJECTIONS,
  repoRoot = REPO_ROOT,
} = {}) {
  return [...new Set(projections.map(({ relativePath }) => resolve(repoRoot, relativePath)))].sort();
}

const PRIVATE_OR_ABSOLUTE_IMPORT = /(?:@happier-dev\/|\bimport\s*\(|\bfrom\s*['"](?:\/|[A-Za-z]:[\\/]))/u;

function requireArgument() {
  const argument = process.argv.slice(2);
  if (argument.length !== 1 || (argument[0] !== '--check' && argument[0] !== '--write')) {
    throw new Error('Usage: node scripts/generateActionTypeMap.mjs --check|--write');
  }
  return argument[0];
}

function requireParsedConfig(path, label) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!parsed) throw new Error(`Unable to read ${label} TypeScript configuration: ${path}`);
  return parsed;
}

function requireProtocolProgram() {
  const parsed = requireParsedConfig(PROTOCOL_TSCONFIG_PATH, 'Protocol');
  const program = ts.createProgram({
    // The projection needs only its declared Protocol owners and their normal
    // transitive imports. Rooting the compiler at every Protocol source file
    // makes an Action-map check pay for unrelated graphs and can push the
    // structural printer into pathological heap growth on busy workspaces.
    rootNames: resolveActionTypeProjectionRootNames(),
    options: parsed.options,
  });
  const diagnostics = program.getOptionsDiagnostics();
  if (diagnostics.length > 0) {
    throw new Error(`Cannot derive Action types with invalid Protocol compiler options: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
  }
  return Object.freeze({ checker: program.getTypeChecker(), program });
}

function sourceFileFor(program, relativePath) {
  const sourcePath = resolve(REPO_ROOT, relativePath);
  const sourceFile = program.getSourceFile(sourcePath);
  if (!sourceFile) throw new Error(`Protocol source is unavailable: ${relativePath}`);
  return sourceFile;
}

function projectedType(checker, sourceFile, { name, local }) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === name)
    : undefined;
  const symbol = exported ?? (local ? sourceFile.locals?.get(name) : undefined);
  if (!symbol) {
    const availability = local ? 'Protocol declaration' : 'Protocol export';
    throw new Error(`${availability} is unavailable: ${name} from ${sourceFile.fileName}`);
  }
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function renderTypeAlias(name, typeText, exported) {
  if (PRIVATE_OR_ABSOLUTE_IMPORT.test(typeText)) {
    throw new Error(`${name} structural projection contains a private or absolute import.`);
  }
  const source = ts.createSourceFile(
    'actionTypeMap.generated.ts',
    `${exported ? 'export ' : ''}type ${name} = ${typeText};`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = source.parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new Error(`${name} structural projection is not valid TypeScript: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
  }
  return printer.printFile(source).trimEnd();
}

/**
 * Action schemas and validator brands remain Protocol runtime implementation
 * facts. Public Action signatures expose schema slots opaquely and branded
 * result scalars as their ordinary string representation, without changing
 * the canonical Action catalog, caller policy, or invocation behavior.
 */
function renderPublicActionProjectionType(typeText) {
  return typeText
    .replaceAll(RUNTIME_ACTION_SCHEMA, 'unknown')
    .replace(OPAQUE_VALIDATOR_BRANDED_STRING, 'string');
}

export function renderActionTypeProjection(name, typeText) {
  const projected = renderPublicActionProjectionType(typeText);
  return name === 'PluginActionInputById'
    ? projected.replace(MUTABLE_PROTOCOL_JSON_VALUE, 'JsonValue')
    : projected;
}

export async function writeFileIfChanged(path, content) {
  try {
    if (await readFile(path, 'utf8') === content) return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(path, content, 'utf8');
  return true;
}

function mapKeys(checker, type, name) {
  const keys = checker.getPropertiesOfType(type).map((property) => property.name).sort();
  if (keys.length === 0) throw new Error(`${name} must retain at least one literal Action key.`);
  return keys;
}

function assertSameKeys(left, right, description) {
  if (left.length !== right.length || left.some((key, index) => key !== right[index])) {
    throw new Error(`${description} key mismatch: ${JSON.stringify({ left, right })}`);
  }
}

function assertConcreteMapValues(checker, type, sourceFile, name) {
  for (const property of checker.getPropertiesOfType(type)) {
    const location = property.valueDeclaration ?? property.declarations?.[0] ?? sourceFile;
    const value = checker.getTypeOfSymbolAtLocation(property, location);
    if ((value.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      throw new Error(`${name}.${property.name} degraded to ${checker.typeToString(value)}.`);
    }
  }
}

export function validateGeneratedModuleSyntax(output) {
  if (PRIVATE_OR_ABSOLUTE_IMPORT.test(output)) {
    throw new Error('Generated Action type map contains a private or absolute import.');
  }
  if (FORBIDDEN_PUBLIC_VALIDATOR_REFERENCE.test(output)) {
    throw new Error('Generated Action type map contains a validator-library implementation reference.');
  }

  const sourceFile = ts.createSourceFile(
    OUTPUT_PATH,
    output,
    ts.ScriptTarget.ES2022,
    false,
    ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics;
  if (diagnostics.length > 0) {
    throw new Error(
      `Generated Action type map is not valid TypeScript: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`,
    );
  }
}

export function collectGeneratedModuleDiagnostics(program, sourceFile) {
  const canonicalSourcePath = ts.sys.resolvePath(sourceFile.fileName);
  return ts.getPreEmitDiagnostics(program, sourceFile)
    .filter((diagnostic) => (
      diagnostic.file
      && ts.sys.resolvePath(diagnostic.file.fileName) === canonicalSourcePath
    ));
}

export function createGeneratedModuleValidationCompilerOptions(options) {
  return {
    ...options,
    incremental: false,
    noEmit: true,
    // The generated module is already the declaration-shaped structural
    // projection. Declaration-transforming that 29k-line type-only file again
    // adds no correspondence proof and caused the publisher's heap blow-up.
    declaration: false,
    declarationMap: false,
  };
}

export function validateGeneratedModule(output, expectedInputKeys, expectedResultKeys) {
  validateGeneratedModuleSyntax(output);

  const parsed = requireParsedConfig(SDK_TSCONFIG_PATH, 'Plugin SDK');
  const options = createGeneratedModuleValidationCompilerOptions(parsed.options);
  const canonicalOutputPath = ts.sys.resolvePath(OUTPUT_PATH);
  const host = ts.createCompilerHost(options, true);
  const readSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => (
    ts.sys.resolvePath(path) === canonicalOutputPath || ts.sys.fileExists(path)
  );
  host.readFile = (path) => (
    ts.sys.resolvePath(path) === canonicalOutputPath ? output : ts.sys.readFile(path)
  );
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => (
    ts.sys.resolvePath(path) === canonicalOutputPath
      ? ts.createSourceFile(path, output, languageVersion, true, ts.ScriptKind.TS)
      : readSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram({
    rootNames: [OUTPUT_PATH],
    options,
    host,
  });
  const sourceFile = program.getSourceFile(OUTPUT_PATH);
  if (!sourceFile) throw new Error('Generated Action type map source is unavailable to the Plugin SDK compiler.');
  const diagnostics = collectGeneratedModuleDiagnostics(program, sourceFile);
  if (diagnostics.length > 0) {
    throw new Error(
      `Generated Action type map does not compile: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`,
    );
  }

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error('Generated Action type map has no module symbol.');
  const exports = checker.getExportsOfModule(moduleSymbol);
  const requireGeneratedMap = (name) => {
    const symbol = exports.find((candidate) => candidate.name === name);
    if (!symbol) throw new Error(`Generated Action type map is missing ${name}.`);
    return checker.getDeclaredTypeOfSymbol(symbol);
  };
  const inputMap = requireGeneratedMap('PluginActionInputById');
  const resultMap = requireGeneratedMap('PluginActionResultById');
  const inputKeys = mapKeys(checker, inputMap, 'Generated PluginActionInputById');
  const resultKeys = mapKeys(checker, resultMap, 'Generated PluginActionResultById');
  assertSameKeys(inputKeys, resultKeys, 'Generated Action input/result maps');
  assertSameKeys(inputKeys, expectedInputKeys, 'Protocol/generated Action input maps');
  assertSameKeys(resultKeys, expectedResultKeys, 'Protocol/generated Action result maps');
  assertConcreteMapValues(checker, inputMap, sourceFile, 'Generated PluginActionInputById');
  assertConcreteMapValues(checker, resultMap, sourceFile, 'Generated PluginActionResultById');
}

function renderStructuralModule(onPhase = () => {}) {
  const { checker, program } = requireProtocolProgram();
  onPhase('protocol-program');
  const projections = TYPE_PROJECTIONS.map((projection) => {
    const sourceFile = sourceFileFor(program, projection.relativePath);
    const type = projectedType(checker, sourceFile, projection);
    return {
      ...projection,
      sourceFile,
      type,
      rendered: renderTypeAlias(
        projection.name,
        renderActionTypeProjection(
          projection.name,
          checker.typeToString(type, undefined, TYPE_FORMAT_FLAGS),
        ),
        projection.export,
      ),
    };
  });
  const inputMap = projections.find((projection) => projection.name === 'PluginActionInputById');
  const resultMap = projections.find((projection) => projection.name === 'PluginActionResultById');
  if (!inputMap || !resultMap) throw new Error('Action type projections must include exact input and result maps.');
  const inputKeys = mapKeys(checker, inputMap.type, 'Protocol PluginActionInputById');
  const resultKeys = mapKeys(checker, resultMap.type, 'Protocol PluginActionResultById');
  assertSameKeys(inputKeys, resultKeys, 'Protocol Action input/result maps');
  assertConcreteMapValues(checker, inputMap.type, inputMap.sourceFile, 'Protocol PluginActionInputById');
  assertConcreteMapValues(checker, resultMap.type, resultMap.sourceFile, 'Protocol PluginActionResultById');

  const output = [
    '// This file is generated by scripts/generateActionTypeMap.mjs. Do not edit by hand.',
    '// It contains type-only structural projections of the canonical Protocol Action catalog.',
    '',
    "import type { JsonValue, PluginJsonSchema, PluginJsonValueV2 } from '../identity.js';",
    "import type { AgentExternalSessionTranscriptRawRecord } from '../externalSessions.js';",
    "import type { PluginUiJsonValueV1 } from '../ui/publicContract.js';",
    '',
    ...PUBLIC_ACTION_TYPE_CLOSURE,
    '',
    'export type PluginJsonSchemaV2 = PluginJsonSchema;',
    '',
    ...projections.map((projection) => projection.rendered),
    '',
    'export type PluginInvocableActionId = keyof PluginActionInputById;',
    '',
  ].join('\n');
  onPhase('structural-projection');
  return Object.freeze({ inputKeys, output, resultKeys });
}

async function runActionTypeMap(mode) {
  const timing = createActionTypeMapTimingReporter();
  const { inputKeys, output, resultKeys } = renderStructuralModule(timing);
  validateGeneratedModule(output, inputKeys, resultKeys);
  timing('generated-module-validation');

  if (mode === '--write') {
    await writeFileIfChanged(OUTPUT_PATH, output);
  } else {
    const current = await readFile(OUTPUT_PATH, 'utf8');
    if (current !== output) {
      throw new Error(`Generated Action type map is stale: ${OUTPUT_PATH}. Run yarn generate:action-type-map.`);
    }
  }
  timing(mode === '--write' ? 'publication-write' : 'publication-check');
}

export async function runActionTypeMapWithWorkspaceLock({
  mode,
  run = runActionTypeMap,
  lockPath = WORKSPACE_BUILD_LOCK_PATH,
  env = process.env,
  lockOptions = {},
} = {}) {
  if (mode !== '--check' && mode !== '--write') {
    throw new Error('Action type map mode must be --check or --write');
  }
  return await withWorkspaceBundleLock(
    async () => await run(mode),
    {
      ...lockOptions,
      lockPath,
      heldLockValue: lockOptions.heldLockValue
        ?? env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      errorLabel: lockOptions.errorLabel
        ?? '@happier-dev/plugin-sdk generated Action map lock',
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await runActionTypeMapWithWorkspaceLock({ mode: requireArgument() });
}
