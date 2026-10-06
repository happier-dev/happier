import { actionCliFlagNameForField } from '@happier-dev/protocol/actions/actionCliProjection';
import { listActionCliCommandDeclarations } from '@happier-dev/protocol/actions/actionSpecs';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { ActionCliCommandBinding, ActionId, ActionInputFieldHint, ActionInputHints, ActionInputPredicate, ActionSpec, JsonSchemaObject } from '@happier-dev/protocol';
import {
  ACTION_CLI_COMPILER_OWNED_FLAGS,
  ACTION_CLI_MACHINE_ID_FLAG,
  ACTION_CLI_SERVER_ID_FLAG,
  validateActionCliFlagCollisions,
} from './parseCommandInput';

/**
 * How one caller field is spelled on the command line. The kind comes from the
 * effective CLI caller schema's JSON Schema projection; hints only refine
 * presentation, choices and dynamic option sources. When the structure is not an
 * ordinary scalar/list the compiler offers `--field-json` rather than guessing.
 */
export type ActionCliFieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string_list'
  | 'json';

export type ActionCliField = Readonly<{
  path: string;
  flag: string;
  aliases: readonly string[];
  kind: ActionCliFieldKind;
  required: boolean;
  title: string | null;
  description: string | null;
  choices: readonly string[] | null;
  optionsSourceId: string | null;
  listSeparator: 'comma' | 'newline' | null;
  maxSelections: number | null;
  visibleWhen: ActionInputPredicate | null;
  requiredWhen: ActionInputPredicate | null;
  disabledWhen: ActionInputPredicate | null;
  minimum: number | null;
  maximum: number | null;
  exclusiveMinimum: number | null;
  exclusiveMaximum: number | null;
}>;

export type CompiledActionCliCommand = Readonly<{
  actionId: ActionId;
  spec: ActionSpec;
  path: readonly [string, ...string[]];
  visibility: 'canonical' | 'alias' | 'hidden';
  deprecated: ActionCliCommandBinding['deprecated'];
  positionals: readonly ActionCliField[];
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
   * It is not when the Action declares a semantic `machineId` field: one
   * spelling cannot mean both "route this invocation there" and "this is the
   * Action's input", so the declaration decides, not a runtime precedence rule.
   */
  routesByTransportMachineId: boolean;
  /** This command preserves the established command-local exact-Home selector. */
  acceptsServerId: boolean;
  /** This command may not borrow the device's ambient active Home. */
  requiresServerId: boolean;
  /** Existing CLI request lifetime selected by the Action-owned projection. */
  requestTimeout: NonNullable<ActionSpec['cli']>['requestTimeout'];
}>;

/** The caller field whose flag would collide with the physical routing flag. */
const TRANSPORT_MACHINE_ID_FIELD = 'machineId';

function readObjectProperties(schema: JsonSchemaObject): Readonly<Record<string, JsonSchemaObject>> | null {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return properties as Readonly<Record<string, JsonSchemaObject>>;
}

/**
 * Zod projects `.optional()`/`.nullable()` as `anyOf` arms and unions as
 * `anyOf`/`oneOf`. Only the single meaningful arm is interesting here: a field
 * that is genuinely a union of shapes stays a JSON field.
 */
function unwrapNullableSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const arms = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (!arms) return schema;
  const meaningful = arms.filter((arm): arm is JsonSchemaObject => (
    Boolean(arm) && typeof arm === 'object' && !Array.isArray(arm)
    && (arm as JsonSchemaObject).type !== 'null'
  ));
  return meaningful.length === 1 ? meaningful[0]! : schema;
}

function readSchemaType(schema: JsonSchemaObject): string | null {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const concrete = type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    return concrete.length === 1 ? concrete[0]! : null;
  }
  return null;
}

function readEnumChoices(schema: JsonSchemaObject): readonly string[] | null {
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : schema.const !== undefined
      ? [schema.const]
      : null;
  if (!values || values.length === 0) return null;
  return values.every((value) => typeof value === 'string')
    ? Object.freeze(values as string[])
    : null;
}

function resolveFieldKind(rawSchema: JsonSchemaObject): Readonly<{
  kind: ActionCliFieldKind;
  choices: readonly string[] | null;
}> {
  const schema = unwrapNullableSchema(rawSchema);
  const choices = readEnumChoices(schema);
  if (choices) return { kind: 'enum', choices };
  switch (readSchemaType(schema)) {
    case 'string':
      return { kind: 'string', choices: null };
    case 'integer':
      return { kind: 'integer', choices: null };
    case 'number':
      return { kind: 'number', choices: null };
    case 'boolean':
      return { kind: 'boolean', choices: null };
    case 'array': {
      const items = schema.items;
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        const item = unwrapNullableSchema(items as JsonSchemaObject);
        const itemChoices = readEnumChoices(item);
        if (itemChoices) return { kind: 'string_list', choices: itemChoices };
        if (readSchemaType(item) === 'string') return { kind: 'string_list', choices: null };
      }
      return { kind: 'json', choices: null };
    }
    default:
      return { kind: 'json', choices: null };
  }
}

function findHint(hints: ActionInputHints | undefined, path: string): ActionInputFieldHint | null {
  return hints?.fields?.find((field) => field.path === path) ?? null;
}

function readHintChoices(hint: ActionInputFieldHint | null): readonly string[] | null {
  const options = hint?.options;
  if (!options || options.length === 0) return null;
  const values = options
    .map((option) => option.value)
    .filter((value): value is string => typeof value === 'string');
  return values.length === options.length ? Object.freeze(values) : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function generatedFlagSpellings(kind: ActionCliFieldKind, flag: string): readonly string[] {
  if (kind === 'boolean') return Object.freeze([flag, `--no-${flag.slice(2)}`]);
  if (kind === 'json') return Object.freeze([`${flag}-json`]);
  return Object.freeze([flag, `${flag}-json`]);
}

/** Project only the CLI spelling; the canonical Action schema path is unchanged. */
function projectActionCliFieldFlag(params: Readonly<{
  path: string;
  kind: ActionCliFieldKind;
  occupied: ReadonlySet<string>;
}>): string {
  const canonical = actionCliFlagNameForField(params.path);
  const candidates = [
    canonical,
    `--action-${canonical.slice(2)}`,
    `--action-${canonical.slice(2)}-field`,
  ];
  for (const candidate of candidates) {
    if (generatedFlagSpellings(params.kind, candidate).every((flag) => !params.occupied.has(flag))) {
      return candidate;
    }
  }
  let discriminator = 2;
  while (true) {
    const candidate = `--action-${canonical.slice(2)}-field-${discriminator}`;
    if (generatedFlagSpellings(params.kind, candidate).every((flag) => !params.occupied.has(flag))) {
      return candidate;
    }
    discriminator += 1;
  }
}

/**
 * The ordinary field flags one already structurally described input accepts.
 *
 * Both input sources reach this one derivation: a bundled Action projects its
 * effective CLI caller Zod schema through the existing Action-schema-to-JSON
 * projection, and a contributed Action supplies its published
 * `ActionDefinitionV1` JSON schema directly. Neither path introspects Zod
 * internals, and an ambiguous structure gets `--field-json` rather than a guess.
 */
export function compileActionCliFieldsFromJsonSchema(params: Readonly<{
  jsonSchema: JsonSchemaObject;
  hints?: ActionInputHints | undefined;
  aliasesByPath?: ReadonlyMap<string, readonly string[]>;
  reservedFlags?: readonly string[];
}>): readonly ActionCliField[] {
  const jsonSchema = params.jsonSchema;
  const aliasesByPath = params.aliasesByPath ?? new Map<string, readonly string[]>();
  const properties = readObjectProperties(jsonSchema);
  if (!properties) return Object.freeze([]);
  const requiredPaths = new Set(
    Array.isArray(jsonSchema.required)
      ? jsonSchema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const occupied = new Set([
    ...ACTION_CLI_COMPILER_OWNED_FLAGS,
    ...(params.reservedFlags ?? []),
    ...[...aliasesByPath.values()].flat(),
  ]);
  return Object.freeze(Object.entries(properties).map(([path, propertySchema]): ActionCliField => {
    const hint = findHint(params.hints, path);
    const effectiveSchema = unwrapNullableSchema(propertySchema);
    const { kind, choices } = resolveFieldKind(effectiveSchema);
    const flag = projectActionCliFieldFlag({ path, kind, occupied });
    for (const spelling of generatedFlagSpellings(kind, flag)) occupied.add(spelling);
    return Object.freeze({
      path,
      flag,
      aliases: aliasesByPath.get(path) ?? Object.freeze([]),
      kind,
      required: requiredPaths.has(path) || hint?.required === true,
      title: typeof hint?.title === 'string' ? hint.title : null,
      description: typeof hint?.description === 'string' ? hint.description : null,
      choices: readHintChoices(hint) ?? choices,
      optionsSourceId: typeof hint?.optionsSourceId === 'string' ? hint.optionsSourceId : null,
      listSeparator: hint?.listSeparator ?? null,
      maxSelections: hint?.maxSelections ?? null,
      visibleWhen: hint?.visibleWhen ?? null,
      requiredWhen: hint?.requiredWhen ?? null,
      disabledWhen: hint?.disabledWhen ?? null,
      minimum: readFiniteNumber(effectiveSchema.minimum),
      maximum: readFiniteNumber(effectiveSchema.maximum),
      exclusiveMinimum: readFiniteNumber(effectiveSchema.exclusiveMinimum),
      exclusiveMaximum: readFiniteNumber(effectiveSchema.exclusiveMaximum),
    });
  }));
}

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
  const { fields, callerSchema } = compileActionCliFields(spec, {
    reservedFlags: spec.cli?.acceptsServerId === true ? [ACTION_CLI_SERVER_ID_FLAG] : [],
  });
  const fieldsByPath = new Map(fields.map((field) => [field.path, field]));
  const positionals = (binding.positionals ?? [])
    .map((path) => fieldsByPath.get(path))
    .filter((field): field is ActionCliField => Boolean(field));
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
  const routesByTransportMachineId = !fieldsByPath.has(TRANSPORT_MACHINE_ID_FIELD);
  const collision = validateActionCliFlagCollisions(
    { fields, positionals },
    { reservedFlags: [
      ...(routesByTransportMachineId ? [ACTION_CLI_MACHINE_ID_FLAG] : []),
      ...(spec.cli?.acceptsServerId === true ? [ACTION_CLI_SERVER_ID_FLAG] : []),
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
    variadicPositional,
    fields,
    callerSchema,
    wholeInputSchema: spec.cli?.wholeInputSchema ?? spec.inputSchema,
    binding,
    routesByTransportMachineId,
    acceptsServerId: spec.cli?.acceptsServerId === true,
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

/** The longest declared friendly path that prefixes `words`, or `null`. */
export function findCompiledActionCliCommand(
  words: readonly string[],
  commands: readonly CompiledActionCliCommand[] = listCompiledActionCliCommands(),
): CompiledActionCliCommand | null {
  let best: CompiledActionCliCommand | null = null;
  for (const command of commands) {
    if (command.path.length > words.length) continue;
    if (!command.path.every((segment, index) => words[index] === segment)) continue;
    if (!best || command.path.length > best.path.length) best = command;
  }
  return best;
}
