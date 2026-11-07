import { compileActionCliFieldsFromJsonSchema, type ActionCliField } from './fieldCompiler';
export { compileActionCliFieldsFromJsonSchema } from './fieldCompiler';
export type { ActionCliField, ActionCliFieldKind } from './fieldCompiler';
import { actionCliFlagNameForField } from '@happier-dev/protocol/actions/actionCliProjection';
import { listActionCliCommandDeclarations } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionCliCommandBinding, ActionId, ActionInputFieldHint, ActionInputHints, ActionInputPredicate, ActionSpec, JsonSchemaObject } from '@happier-dev/protocol';
import { actionCliCommandPattern, findActionCliCommandPattern } from './commandPatterns';
import { ACTION_CLI_PROJECT_TARGET_VALUE_FLAGS, isWorkflowActionCliCommand } from './executionTarget';
export { actionCliCommandPattern } from './commandPatterns';
import {
  ACTION_CLI_COMPILER_OWNED_FLAGS,
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_SERVER_ID_FLAG,
  validateActionCliFlagCollisions,
} from './parseCommandInput';



export type CompiledActionCliCommand = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  path: readonly [string, ...string[]];
  visibility: 'canonical' | 'alias' | 'hidden';
  deprecated: ActionCliCommandBinding['deprecated'];
  positionals: readonly ActionCliField[];
  positionalsBeforeLastSegment: readonly ActionCliField[];
  variadicPositional: ActionCliField | null;
  fields: readonly ActionCliField[];
  /** The schema the parsed caller value is validated against before binding. */
  callerSchema: ActionSpec['inputSchema'];
  /** Strict Action-owned schema accepted by whole-object `--input-json`. */
  wholeInputSchema: ActionSpec['inputSchema'];
  binding: ActionCliCommandBinding;
  /**
   * Whether `--machine-id` is the CLI's physical routing flag for this command.
   *
   * Workflow queries reserve the transport spelling and project a semantic
   * Machine filter separately. Otherwise an Action's own `machineId` field
   * owns the spelling; no invocation gives one spelling both meanings.
   */
  routesByTransportMachineId: boolean;
  transportMachineIdFlags: readonly string[];
  /** Workflow project selectors route execution and never enter Action input. */
  transportProjectTargetFlags: readonly string[];
  /** This command preserves the established command-local exact-Home selector. */
  acceptsServerId: boolean;
  /** This command may not borrow the device's ambient active Home. */
  requiresServerId: boolean;
  /** Existing CLI request lifetime selected by the Action-owned projection. */
  requestTimeout: NonNullable<ActionSpec['cli']>['requestTimeout'];
}>;

/** The caller field whose flag would collide with the physical routing flag. */
const TRANSPORT_MACHINE_ID_FIELD = 'machineId';












export type CompiledActionCliFields = Readonly<{
  fields: readonly ActionCliField[];
  /** The schema the parsed caller value is validated against before binding. */
  callerSchema: ActionSpec['inputSchema'];
  wholeInputSchema: ActionSpec['inputSchema'];
  bindInput: NonNullable<ActionSpec['cli']>['bindInput'];
}>;

/**
 * The ordinary field flags one Action accepts, derived from its effective CLI
 * caller schema and hints. `happier actions invoke <action-id>` uses this for a
 * dynamically selected Action; a declared friendly command uses the same
 * derivation through `compileActionCliCommands`, so both spell a field the same
 * way and neither owns a private table.
 */
export function compileActionCliFields(
  spec: ActionSpec,
  options: Readonly<{
    reservedFlags?: readonly string[];
    /**
     * Established spellings a retained workflow keeps for its Action fields
     * (plan §13.3 compatibility aliases). They join the Action's own declared
     * aliases in the same descriptor, so parse, help and completion agree.
     */
    flagAliases?: readonly Readonly<{ path: string; aliases: readonly string[] }>[];
  }> = {},
): CompiledActionCliFields {
  const projection = spec.cli;
  const callerSchema = projection?.inputSchema ?? spec.inputSchema;
  const aliasesByPath = new Map<string, readonly string[]>();
  for (const entry of [...(projection?.flagAliases ?? []), ...(options.flagAliases ?? [])]) {
    aliasesByPath.set(entry.path, Object.freeze([...(aliasesByPath.get(entry.path) ?? []), ...entry.aliases]));
  }
  return Object.freeze({
    fields: compileActionCliFieldsFromJsonSchema({
      jsonSchema: zodSchemaToJsonSchemaObject(callerSchema),
      hints: projection?.inputHints ?? spec.inputHints,
      aliasesByPath,
      ...(options.reservedFlags ? { reservedFlags: options.reservedFlags } : {}),
    }),
    callerSchema,
    wholeInputSchema: projection?.wholeInputSchema ?? spec.inputSchema,
    bindInput: projection?.bindInput,
  });
}

/**
 * One declared friendly command this binary could not compile because the
 * Action's effective caller schema has no JSON Schema projection, so no flags
 * can be derived for it. The command is skipped and the reason is retained;
 * every other declared command still compiles. Authoring mistakes in the
 * declaration itself (an unknown or wrongly typed variadic positional, a flag
 * collision) stay fatal, because those are ours to fix and must not vanish.
 */
export type CompiledActionCliCommandDiagnostic = Readonly<{
  code: 'action_cli_command_uncompilable';
  actionId: ActionId;
  path: readonly [string, ...string[]];
  reason: string;
}>;

export type CompiledActionCliCommandSet = Readonly<{
  commands: readonly CompiledActionCliCommand[];
  diagnostics: readonly CompiledActionCliCommandDiagnostic[];
}>;

/** The typed unrepresentable-schema refusal raised by the Action JSON Schema projection. */
function readUnrepresentableSchemaReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return (error as { code?: unknown }).code === 'action_schema_unrepresentable' ? error.message : null;
}

function compileDeclaredActionCliCommand(
  { spec, binding }: ReturnType<typeof listActionCliCommandDeclarations>[number],
): CompiledActionCliCommand {
  const acceptsServerId = spec.cli?.acceptsServerId === true || isWorkflowActionCliCommand(spec.id);
  const { fields, callerSchema } = compileActionCliFields(spec, {
    reservedFlags: [
      ...(acceptsServerId ? [ACTION_CLI_SERVER_ID_FLAG] : []),
      ...(spec.cli?.transportMachineIdAliases ?? []),
      ...(isWorkflowActionCliCommand(spec.id) ? [ACTION_CLI_MACHINE_ID_FLAG, ...ACTION_CLI_PROJECT_TARGET_VALUE_FLAGS] : []),
    ],
  });
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const positionalsBeforeLastSegment = (binding.positionalsBeforeLastSegment ?? []).map(path => {
    const field = fieldsByPath.get(path);
    if (!field || !['string', 'enum', 'integer', 'number'].includes(field.kind)) {
      throw new Error(`Action CLI interleaved positional ${path} must name a scalar caller field for ${spec.id}.`);
    }
    return field;
  });
  if (positionalsBeforeLastSegment.length && binding.path.length < 2) throw new Error(`Action CLI interleaved positionals require a nested path for ${spec.id}.`);
  const positionals = [...positionalsBeforeLastSegment, ...(binding.positionals ?? [])
    .map((path) => fieldsByPath.get(path))
    .filter((field): field is ActionCliField => Boolean(field))];
  const variadicPositional = binding.variadicPositional
    ? fieldsByPath.get(binding.variadicPositional) ?? null
    : null;
  if (binding.variadicPositional && !variadicPositional) {
    throw new Error(
      `Action CLI variadic positional ${binding.variadicPositional} is not a caller field for ${spec.id}.`,
    );
  }
  if (variadicPositional && variadicPositional.kind !== 'string_list') {
    throw new Error(
      `Action CLI variadic positional ${variadicPositional.path} for ${spec.id} must be a string list.`,
    );
  }
  const routesByTransportMachineId = isWorkflowActionCliCommand(spec.id) || !fieldsByPath.has(TRANSPORT_MACHINE_ID_FIELD);
  if (!routesByTransportMachineId && spec.cli?.transportMachineIdAliases?.length) {
    throw new Error(`Action ${spec.id} has semantic machineId input and cannot declare Machine transport aliases.`);
  }
  const transportMachineIdFlags = Object.freeze(routesByTransportMachineId
    ? [ACTION_CLI_MACHINE_ID_FLAG, ...(spec.cli?.transportMachineIdAliases ?? [])]
    : []);
  const transportProjectTargetFlags = routesByTransportMachineId && isWorkflowActionCliCommand(spec.id)
    ? ACTION_CLI_PROJECT_TARGET_VALUE_FLAGS : [];
  const collision = validateActionCliFlagCollisions(
    { fields, positionals },
    { reservedFlags: [
      ...transportMachineIdFlags,
      ...transportProjectTargetFlags,
      ...(acceptsServerId ? [ACTION_CLI_SERVER_ID_FLAG] : []),
    ] },
  );
  if (!collision.ok) {
    throw Object.assign(
      new Error(`Action CLI flag ${collision.flag} for ${collision.fieldPath} collides with ${collision.conflictingFieldPath ?? 'a CLI-owned flag'}.`),
      collision,
    );
  }
  return Object.freeze({
    actionId: spec.id,
    spec,
    path: [...binding.path] as unknown as readonly [string, ...string[]],
    visibility: binding.visibility,
    deprecated: binding.deprecated,
    positionals: Object.freeze(positionals),
    positionalsBeforeLastSegment: Object.freeze(positionalsBeforeLastSegment),
    variadicPositional,
    fields,
    callerSchema,
    wholeInputSchema: spec.cli?.wholeInputSchema ?? spec.inputSchema,
    binding,
    routesByTransportMachineId,
    transportMachineIdFlags,
    transportProjectTargetFlags,
    acceptsServerId,
    requiresServerId: spec.cli?.requiresServerId === true,
    requestTimeout: spec.cli?.requestTimeout,
  });
}

/**
 * One descriptor per declared friendly path. Dispatch, help, completion and
 * execution all read this same object, so a flag cannot exist in help without
 * existing in the parser.
 *
 * Compilation is per spec, not per surface: one Action whose schema cannot be
 * projected is reported as a diagnostic and skipped, so an unrelated command a
 * user types still exists.
 */
export function compileActionCliCommandSet(
  declarations: ReturnType<typeof listActionCliCommandDeclarations> = listActionCliCommandDeclarations(),
): CompiledActionCliCommandSet {
  const commands: CompiledActionCliCommand[] = [];
  const diagnostics: CompiledActionCliCommandDiagnostic[] = [];
  for (const declaration of declarations) {
    try {
      commands.push(compileDeclaredActionCliCommand(declaration));
    } catch (error) {
      const reason = readUnrepresentableSchemaReason(error);
      if (reason === null) throw error;
      diagnostics.push(Object.freeze({
        code: 'action_cli_command_uncompilable' as const,
        actionId: declaration.spec.id,
        path: [...declaration.binding.path] as unknown as readonly [string, ...string[]],
        reason,
      }));
    }
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function compileActionCliCommands(
  declarations: ReturnType<typeof listActionCliCommandDeclarations> = listActionCliCommandDeclarations(),
): readonly CompiledActionCliCommand[] {
  return compileActionCliCommandSet(declarations).commands;
}

let compiledCommandsCache: CompiledActionCliCommandSet | null = null;

/** The live compiled command set for this binary. */
export function listCompiledActionCliCommands(): readonly CompiledActionCliCommand[] {
  compiledCommandsCache ??= compileActionCliCommandSet();
  return compiledCommandsCache.commands;
}

/** Declared commands this binary could not compile, with the exact reason each was skipped. */
export function listCompiledActionCliCommandDiagnostics(): readonly CompiledActionCliCommandDiagnostic[] {
  compiledCommandsCache ??= compileActionCliCommandSet();
  return compiledCommandsCache.diagnostics;
}

export function actionCliCommandUsagePath(command: CompiledActionCliCommand): string {
  return actionCliCommandPattern(command).map(segment => typeof segment === 'string' ? segment : `<${segment.path}>`).join(' ');
}

/** The longest declared friendly pattern that prefixes `words`, or `null`. */
export function findCompiledActionCliCommand(
  words: readonly string[],
  commands: readonly CompiledActionCliCommand[] = listCompiledActionCliCommands(),
): CompiledActionCliCommand | null {
  return findActionCliCommandPattern(words, commands.map((command) => ({ command, pattern: actionCliCommandPattern(command) })))?.command ?? null;
}
