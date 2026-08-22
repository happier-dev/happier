import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../../..');
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
    rootNames: parsed.fileNames,
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

function exportedModuleType(checker, sourceFile, name) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`Generated Action type map has no module symbol: ${sourceFile.fileName}`);
  const symbol = checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === name);
  if (!symbol) throw new Error(`Generated Action type map does not export ${name}.`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}

function validateGeneratedModule(output, expectedInputKeys, expectedResultKeys) {
  if (PRIVATE_OR_ABSOLUTE_IMPORT.test(output)) {
    throw new Error('Generated Action type map contains a private or absolute import.');
  }
  if (FORBIDDEN_PUBLIC_VALIDATOR_REFERENCE.test(output)) {
    throw new Error('Generated Action type map contains a validator-library implementation reference.');
  }

  const parsed = requireParsedConfig(SDK_TSCONFIG_PATH, 'Plugin SDK');
  const canonicalOutputPath = ts.sys.resolvePath(OUTPUT_PATH);
  const host = ts.createCompilerHost({ ...parsed.options, incremental: false, noEmit: true }, true);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const isOutput = (fileName) => ts.sys.resolvePath(fileName) === canonicalOutputPath;

  host.fileExists = (fileName) => isOutput(fileName) || defaultFileExists(fileName);
  host.readFile = (fileName) => isOutput(fileName) ? output : defaultReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => (
    isOutput(fileName)
      ? ts.createSourceFile(fileName, output, languageVersion, true, ts.ScriptKind.TS)
      : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  );

  const program = ts.createProgram({
    rootNames: [OUTPUT_PATH],
    options: { ...parsed.options, incremental: false, noEmit: true },
    host,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && isOutput(diagnostic.file.fileName));
  if (diagnostics.length > 0) {
    throw new Error(`Generated Action type map does not typecheck: ${diagnostics
      .map((diagnostic) => {
        const position = diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : null;
        const location = position ? `${position.line + 1}:${position.character + 1}: ` : '';
        const sourceLine = position
          ? `\n${output.split('\n').slice(Math.max(0, position.line - 6), position.line + 7).join('\n')}`
          : '';
        return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}${sourceLine}`;
      })
      .join('\n')}`);
  }

  const sourceFile = program.getSourceFile(OUTPUT_PATH);
  if (!sourceFile) throw new Error(`Generated Action type map source is unavailable: ${OUTPUT_PATH}`);
  const checker = program.getTypeChecker();
  const input = exportedModuleType(checker, sourceFile, 'PluginActionInputById');
  const result = exportedModuleType(checker, sourceFile, 'PluginActionResultById');
  const actualInputKeys = mapKeys(checker, input, 'generated PluginActionInputById');
  const actualResultKeys = mapKeys(checker, result, 'generated PluginActionResultById');
  assertSameKeys(actualInputKeys, expectedInputKeys, 'Generated PluginActionInputById');
  assertSameKeys(actualResultKeys, expectedResultKeys, 'Generated PluginActionResultById');
  assertConcreteMapValues(checker, input, sourceFile, 'Generated PluginActionInputById');
  assertConcreteMapValues(checker, result, sourceFile, 'Generated PluginActionResultById');
}

function renderModule() {
  const { checker, program } = requireProtocolProgram();
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
    '',
    'export type PluginJsonSchemaV2 = PluginJsonSchema;',
    '',
    ...projections.map((projection) => projection.rendered),
    '',
    'export type PluginInvocableActionId = keyof PluginActionInputById;',
    '',
  ].join('\n');
  validateGeneratedModule(output, inputKeys, resultKeys);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const mode = requireArgument();
  const output = renderModule();

  if (mode === '--write') {
    await writeFile(OUTPUT_PATH, output, 'utf8');
  } else {
    const current = await readFile(OUTPUT_PATH, 'utf8');
    if (current !== output) {
      throw new Error(`Generated Action type map is stale: ${OUTPUT_PATH}. Run yarn generate:action-type-map.`);
    }
  }
}
