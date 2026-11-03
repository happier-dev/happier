import { ActionCliParseTarget, fieldSpellings, jsonFlagFor, negatedFlagFor, FlagMatch, buildFlagIndex, ActionCliFlagCollision, validateActionCliFlagCollisions, listActionCliCommandFlags, describeActionCliCommandFlags } from './fieldFlags';
export { validateActionCliFlagCollisions, listActionCliCommandFlags, describeActionCliCommandFlags } from './fieldFlags';
export type { ActionCliParseTarget, ActionCliFlagCollision } from './fieldFlags';
import { ACTION_CLI_HELP_FLAGS, ACTION_CLI_JSON_OUTPUT_FLAG, ACTION_CLI_WHOLE_INPUT_FLAG, ACTION_CLI_MACHINE_ID_FLAG, ACTION_CLI_SERVER_ID_FLAG, ACTION_CLI_REQUEST_ID_FLAG, ACTION_CLI_GLOBAL_FLAGS, ACTION_CLI_COMPILER_OWNED_FLAGS } from './flags';
export { ACTION_CLI_HELP_FLAGS, ACTION_CLI_JSON_OUTPUT_FLAG, ACTION_CLI_WHOLE_INPUT_FLAG, ACTION_CLI_MACHINE_ID_FLAG, ACTION_CLI_SERVER_ID_FLAG, ACTION_CLI_REQUEST_ID_FLAG, ACTION_CLI_GLOBAL_FLAGS, ACTION_CLI_COMPILER_OWNED_FLAGS } from './flags';
import { evaluateInputPredicate as evaluateActionInputPredicate, readInputPath as readActionInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { readActionCliDerivedDefault } from '@happier-dev/protocol/actions/actionCliProjection';
import { isMissingActionSecretInputError, readMissingActionSecretInputPaths } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { ActionCliBindContext, ActionCliBindInput } from '@happier-dev/protocol';

import { z } from 'zod/mini';

import type { ActionCliField, CompiledActionCliCommand } from './compiledCommands';

export type ActionCliParseFailure = Readonly<{
  ok: false;
  code: 'invalid_arguments';
  message: string;
}>;

export type ActionCliParseSuccess = Readonly<{
  ok: true;
  /** Canonical whole-Action input supplied by `--input-json`, if any. */
  canonicalBase: Readonly<Record<string, unknown>> | null;
  /** Friendly flags and positionals, before the Action's caller binder runs. */
  callerOverlay: Readonly<Record<string, unknown>>;
}>;

export type ActionCliParseResult = ActionCliParseFailure | ActionCliParseSuccess;

export type ComposedActionCliInput = Readonly<{
  ok: true;
  input: Readonly<Record<string, unknown>>;
  callerInput: Readonly<Record<string, unknown>>;
}> | ActionCliParseFailure;

type SecretInputDeclaration = Parameters<typeof readMissingActionSecretInputPaths>[0];

/** Only declared missing secret leaves wait for the CLI's private reader. */
function parseInputBeforeSecretPreparation(
  schema: z.ZodMiniType,
  input: unknown,
  secretInput?: SecretInputDeclaration,
  fieldContext?: Readonly<{ input: Readonly<Record<string, unknown>>; field: string }>,
) {
  const parsed = schema.safeParse(input);
  if (parsed.success || !secretInput) return parsed;
  const source = fieldContext?.input ?? input;
  const error = fieldContext ? { issues: parsed.error.issues.map(issue => ({
    code: issue.code, path: [fieldContext.field, ...issue.path],
  })) } : parsed.error;
  return isMissingActionSecretInputError(error, source, readMissingActionSecretInputPaths(secretInput, source))
    ? { success: true as const, data: input } : parsed;
}

function describeSchemaIssues(error: z.core.$ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/**
 * A schema's declared fields, through Zod's public object shape. An Action whose
 * canonical input first normalizes a friendlier spelling (`z.preprocess`) is a
 * pipe into that object: its fields are the object's, and the normalization
 * still runs once on the merged input through the canonical schema itself.
 */
function readObjectShape(schema: z.ZodMiniType): Record<string, z.ZodMiniType> | null {
  const shape: unknown = (schema as { shape?: unknown }).shape;
  if (shape !== null && typeof shape === 'object' && !Array.isArray(shape)) {
    return shape as Record<string, z.ZodMiniType>;
  }
  const def = (schema as { _zod?: { def?: { type?: unknown; out?: unknown } } })._zod?.def;
  return def?.type === 'pipe' && def.out ? readObjectShape(def.out as z.ZodMiniType) : null;
}

/** Keep each real union arm closed rather than pooling their allowed fields. */
function readPartialObjectShapes(schema: z.ZodMiniType): readonly Record<string, z.ZodMiniType>[] | null {
  const shape = readObjectShape(schema);
  if (shape) return [shape];
  const def = (schema as { _zod?: { def?: { type?: unknown; options?: unknown; out?: unknown } } })._zod?.def;
  if (def?.type === 'pipe' && def.out) return readPartialObjectShapes(def.out as z.ZodMiniType);
  if (def?.type !== 'union' || !Array.isArray(def.options)) return null;
  const shapes: Record<string, z.ZodMiniType>[] = [];
  for (const option of def.options) {
    const nested = readPartialObjectShapes(option as z.ZodMiniType);
    if (!nested) return null;
    shapes.push(...nested);
  }
  return shapes.length > 0 ? shapes : null;
}

/**
 * Validates one composition source as a partial: each supplied field against
 * its own declared schema, and nothing against the fields it did not supply.
 *
 * When whole-input JSON and friendly flags are composed, neither source is a
 * complete Action input on its own — the JSON may omit what a flag supplies and
 * the flags may omit what the JSON supplies — so demanding either shape's whole
 * set would reject exactly the composition the precedence rule promises. Field
 * membership is still enforced, which is what keeps a surface schema's omitted
 * fields (a public caller may not author plugin source or attachments)
 * unreachable.
 *
 * The schema's own object-level rules still run over what this source supplied
 * (see {@link readObjectLevelChecks}). They are the friendly vocabulary's
 * cross-field rules — `--active` cannot be combined with a Team query — and a
 * binder may discard one of the conflicting fields while projecting, after
 * which the canonical schema can no longer see the conflict at all.
 */
function parsePartialInputFields(
  shape: Readonly<Record<string, z.ZodMiniType>>,
  supplied: Readonly<Record<string, unknown>>,
  schema?: z.ZodMiniType,
  secretInput?: SecretInputDeclaration,
): Readonly<Record<string, unknown>> | ActionCliParseFailure {
  const parsed: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const [field, value] of Object.entries(supplied)) {
    const fieldSchema = Object.hasOwn(shape, field) ? shape[field] : undefined;
    if (!fieldSchema) {
      issues.push(`${field}: unrecognized field`);
      continue;
    }
    const result = parseInputBeforeSecretPreparation(fieldSchema, value, secretInput, { input: supplied, field });
    if (result.success) parsed[field] = result.data;
    else {
      issues.push(...result.error.issues.map((issue) => {
        const path = [field, ...issue.path].join('.');
        return `${path}: ${issue.message}`;
      }));
    }
  }
  if (issues.length > 0) return failure(issues.slice(0, 4).join('; '));
  const checks = schema ? readObjectLevelChecks(schema) : [];
  if (checks.length > 0) {
    const partialShape = Object.fromEntries(Object.entries(shape).map(([field, fieldSchema]) => (
      [field, z.optional(fieldSchema)]
    )));
    const refined = z.object(partialShape).check(...checks).safeParse(parsed);
    if (!refined.success) return failure(describeSchemaIssues(refined.error));
  }
  return Object.freeze(parsed);
}

/**
 * The object-level refinements a caller or whole-input schema declares.
 *
 * Zod runs an object's refinements only once every required field is present
 * and refuses `.partial()` on a refined object, so a partial source cannot be
 * checked by the schema as-is. The rules are the schema's own check objects
 * (Zod's documented `_zod.def.checks` extension point); re-attaching them to an
 * all-optional copy of the same shape evaluates exactly those rules against the
 * fields this source supplied. A rule that needs a field this source did not
 * supply sees it absent, as the rule's own optional-field handling expects.
 */
function readObjectLevelChecks(schema: z.ZodMiniType): readonly z.core.$ZodCheck<Record<string, unknown>>[] {
  const checks: unknown = (schema as { _zod?: { def?: { checks?: unknown } } })._zod?.def?.checks;
  return Array.isArray(checks) ? checks as z.core.$ZodCheck<Record<string, unknown>>[] : [];
}

/**
 * Validates and composes the parser's two intentional sources. Whole-input JSON
 * is canonical already; only the friendly overlay reaches the caller binder.
 * Both the friendly command dispatcher and generic built-in Action invocation
 * consume this owner so the two entry points cannot drift.
 */
export function composeActionCliInput(params: Readonly<{
  parsed: ActionCliParseSuccess;
  canonicalSchema: z.ZodMiniType;
  wholeInputSchema?: z.ZodMiniType;
  callerSchema: z.ZodMiniType;
  bindInput?: ActionCliBindInput | null;
  context: ActionCliBindContext;
  secretInput?: SecretInputDeclaration;
}>): ComposedActionCliInput {
  // With no whole-input JSON, an empty argv is still the friendly caller shape:
  // binders may own established defaults (for example list page size). When a
  // canonical base is present, an empty overlay must not run the friendly binder
  // and manufacture fields that replace caller-supplied canonical values.
  const hasCallerOverlay = params.parsed.canonicalBase === null
    || Object.keys(params.parsed.callerOverlay).length > 0;

  // Whole-input JSON alone is a complete Action input and keeps whole-input
  // validation. Composed with friendly flags it is only the base of one input
  // the flags complete, so it is validated field by field and completeness plus
  // the cross-field rules are decided once, at the end, by the canonical schema.
  const baseSchema = params.wholeInputSchema ?? params.canonicalSchema;
  const baseShapes = params.parsed.canonicalBase !== null && hasCallerOverlay
    ? readPartialObjectShapes(baseSchema)
    : null;
  let baseRecord: Readonly<Record<string, unknown>> = Object.freeze({});
  if (params.parsed.canonicalBase !== null) {
    if (baseShapes === null) {
      const whole = parseInputBeforeSecretPreparation(baseSchema, params.parsed.canonicalBase, params.secretInput);
      if (!whole.success) return failure(describeSchemaIssues(whole.error));
      if (!whole.data || typeof whole.data !== 'object' || Array.isArray(whole.data)) {
        return failure('Canonical Action input must be an object.');
      }
      baseRecord = whole.data as Readonly<Record<string, unknown>>;
    } else {
      // The canonical schema's own cross-field rules are decided once, on the
      // merged input below; only the friendly overlay can lose a conflicting
      // field to its binder, so only the overlay's rules run on a partial source.
      const candidates = baseShapes.map((shape) => parsePartialInputFields(shape, params.parsed.canonicalBase!, undefined, params.secretInput));
      const partialBase = candidates.find((candidate) => !isParseFailure(candidate)) ?? candidates[0]!;
      if (isParseFailure(partialBase)) return partialBase;
      baseRecord = partialBase;
    }
  }

  const callerShape = params.parsed.canonicalBase === null
    ? null
    : readObjectShape(params.callerSchema);
  let callerValue: unknown = undefined;
  if (hasCallerOverlay) {
    if (callerShape === null) {
      const whole = parseInputBeforeSecretPreparation(params.callerSchema, params.parsed.callerOverlay, params.secretInput);
      if (!whole.success) return failure(describeSchemaIssues(whole.error));
      callerValue = whole.data;
    } else {
      // Only a binder can discard fields before the final canonical check.
      // Without one, completeness refinements must see the merged JSON + flags.
      const overlay = parsePartialInputFields(callerShape, params.parsed.callerOverlay,
        params.bindInput ? params.callerSchema : undefined, params.secretInput);
      if (isParseFailure(overlay)) return overlay;
      callerValue = overlay;
    }
  }

  let boundOverlay: Readonly<Record<string, unknown>> = Object.freeze({});
  try {
    const candidate = !hasCallerOverlay
      ? {}
      : params.bindInput
        ? params.bindInput(callerValue, params.context)
        : callerValue;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return failure('CLI input binder must return an object.');
    }
    boundOverlay = candidate as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof z.core.$ZodError) return failure(describeSchemaIssues(error));
    throw error;
  }

  // A binder is a projection of what the caller typed. Over a canonical base
  // the overlay is partial, so an absent caller field surfaces as `undefined`
  // and is not a contribution at all. A value the binder marks as its own
  // derived default (an intent-derived run shape, a generated local id) is not
  // a caller source: §6.4 requires it to preserve, not overwrite, an already
  // valid canonical field. Everything else the binder returned came from what
  // the caller typed — under its own name or normalized into a different
  // canonical name — and is rejected rather than silently merged when the base
  // already carries it. Provenance is the binder's statement, never inferred
  // from how a canonical key happens to be spelled.
  const contributed: Record<string, unknown> = {};
  const binderDefaults: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(boundOverlay)) {
    if (value === undefined) continue;
    const derived = readActionCliDerivedDefault(value);
    if (derived) binderDefaults[field] = derived.value;
    else contributed[field] = value;
  }
  // The parser already refused a field the caller spelled both ways. What is
  // left to decide here is the binder's own renaming: a caller field the binder
  // normalizes into a different canonical name the base already carries.
  const duplicateCanonicalFields = Object.keys(contributed).filter((field) => (
    Object.prototype.hasOwnProperty.call(baseRecord, field)
  ));
  if (duplicateCanonicalFields.length > 0) {
    return failure(
      `Provide ${duplicateCanonicalFields.join(', ')} either with friendly arguments or with --input-json, not both.`,
    );
  }

  const merged = {
    ...binderDefaults,
    ...baseRecord,
    ...contributed,
  };
  if (baseShapes && baseShapes.length > 1) {
    // A partial arm cannot lend fields to a different completed internal arm.
    // Re-admit the completed public union before the broader internal schema.
    // Single-object commands retain their authenticated preparation boundary.
    const publicInput = parseInputBeforeSecretPreparation(baseSchema, merged, params.secretInput);
    if (!publicInput.success) return failure(describeSchemaIssues(publicInput.error));
  }
  const canonical = parseInputBeforeSecretPreparation(params.canonicalSchema, merged, params.secretInput);
  if (!canonical.success) return failure(describeSchemaIssues(canonical.error));
  if (!canonical.data || typeof canonical.data !== 'object' || Array.isArray(canonical.data)) {
    return failure('Canonical Action input must be an object.');
  }
  return {
    ok: true,
    input: canonical.data as Readonly<Record<string, unknown>>,
    callerInput: callerValue && typeof callerValue === 'object' && !Array.isArray(callerValue)
      ? callerValue as Readonly<Record<string, unknown>>
      : Object.freeze({}),
  };
}

/**
 * Field-by-field validation of a caller source before it is complete, with the
 * caller schema's own object-level rules — the same check composition applies to
 * a partial overlay. A retained workflow uses it to refuse a malformed Action
 * field before it reads credentials or resolves its own workflow-owned fields.
 */
export function validateActionCliCallerFields(
  callerSchema: z.ZodMiniType,
  supplied: Readonly<Record<string, unknown>>,
): ActionCliParseFailure | null {
  const shape = readObjectShape(callerSchema);
  if (shape === null) return null;
  const checked = parsePartialInputFields(shape, supplied, callerSchema);
  return isParseFailure(checked) ? checked : null;
}

/**
 * CLI-owned flags never enter Action input. They are removed before parsing, so
 * a command that adds its own transport flag lists it in `valueFlags` below.
 */



/**
 * Removes the CLI-owned flags — help, output mode, physical routing, request
 * identity — so the Action parser only ever sees caller input. Keeping this at
 * the same owner as the parser means one place decides what "not Action input"
 * means.
 */
export function stripCliOwnedFlags(
  tokens: readonly string[],
  policy: Readonly<{ booleanFlags?: readonly string[]; valueFlags?: readonly string[] }>,
): readonly string[] {
  const booleanFlags = new Set([...ACTION_CLI_GLOBAL_FLAGS, ...(policy.booleanFlags ?? [])]);
  const valueFlags = new Set(policy.valueFlags ?? []);
  const kept: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (positionalOnly) { kept.push(token); continue; }
    if (token === '--') { positionalOnly = true; kept.push(token); continue; }
    const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (booleanFlags.has(name)) continue;
    if (valueFlags.has(name)) {
      if (!token.includes('=')) index += 1;
      continue;
    }
    kept.push(token);
  }
  return Object.freeze(kept);
}


function failure(message: string): ActionCliParseFailure {
  return { ok: false, code: 'invalid_arguments', message };
}





export type ActionCliFieldState = Readonly<{
  present: boolean;
  visible: boolean;
  required: boolean;
  disabled: boolean;
  selectionCount: number;
}>;

/** One shared interpretation of the compiled hint predicates for parser and completion. */
export function resolveActionCliFieldState(
  field: ActionCliField,
  input: Readonly<Record<string, unknown>>,
): ActionCliFieldState {
  const current = readActionInputPath(input, field.path);
  return Object.freeze({
    present: current !== undefined,
    visible: field.visibleWhen === null || evaluateActionInputPredicate(field.visibleWhen, input),
    required: field.required
      || (field.requiredWhen !== null && evaluateActionInputPredicate(field.requiredWhen, input)),
    disabled: field.disabledWhen !== null && evaluateActionInputPredicate(field.disabledWhen, input),
    selectionCount: Array.isArray(current) ? current.length : current === undefined ? 0 : 1,
  });
}






function coerceScalar(field: ActionCliField, raw: string): unknown | ActionCliParseFailure {
  switch (field.kind) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw.trim())) {
        return failure(`Invalid ${field.flag}: expected an integer.`);
      }
      return enforceNumericRange(field, Number(raw.trim()));
    }
    case 'number': {
      const parsed = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(parsed)) {
        return failure(`Invalid ${field.flag}: expected a number.`);
      }
      return enforceNumericRange(field, parsed);
    }
    default:
      // Identifiers are normalized by their own schema. Message-like text keeps
      // the caller's exact bytes, including surrounding whitespace and newlines.
      return raw;
  }
}

function enforceNumericRange(field: ActionCliField, value: number): number | ActionCliParseFailure {
  if (field.minimum !== null && value < field.minimum) {
    return failure(`Invalid ${field.flag}: expected a value of at least ${field.minimum}.`);
  }
  if (field.maximum !== null && value > field.maximum) {
    return failure(`Invalid ${field.flag}: expected a value of at most ${field.maximum}.`);
  }
  if (field.exclusiveMinimum !== null && value <= field.exclusiveMinimum) {
    return failure(`Invalid ${field.flag}: expected a value greater than ${field.exclusiveMinimum}.`);
  }
  if (field.exclusiveMaximum !== null && value >= field.exclusiveMaximum) {
    return failure(`Invalid ${field.flag}: expected a value less than ${field.exclusiveMaximum}.`);
  }
  return value;
}

function splitListValue(field: ActionCliField, raw: string): readonly string[] {
  if (field.listSeparator === 'comma') return raw.split(',');
  if (field.listSeparator === 'newline') return raw.split(/\r?\n/u);
  return [raw];
}

function validateFieldHints(
  command: ActionCliParseTarget,
  input: Readonly<Record<string, unknown>>,
): ActionCliParseFailure | null {
  for (const field of command.fields) {
    const { present, visible, disabled, required } = resolveActionCliFieldState(field, input);
    if (present && !visible) return failure(`${field.flag} is not available for the selected input.`);
    if (present && disabled) return failure(`${field.flag} is disabled for the selected input.`);
    if (
      !present
      && visible
      && !disabled
      && required
      && field.requiredWhen !== null
      && evaluateActionInputPredicate(field.requiredWhen, input)
    ) return failure(`${field.flag} is required for the selected input.`);
    const selected = readActionInputPath(input, field.path);
    if ((field.kind === 'integer' || field.kind === 'number') && typeof selected === 'number') {
      const range = enforceNumericRange(field, selected);
      if (isParseFailure(range)) return range;
    }
    if (field.maxSelections !== null && Array.isArray(selected) && selected.length > field.maxSelections) {
      return failure(`${field.flag} accepts at most ${field.maxSelections} values.`);
    }
  }
  return null;
}

function isParseFailure(value: unknown): value is ActionCliParseFailure {
  return Boolean(value) && typeof value === 'object' && (value as ActionCliParseFailure).ok === false;
}

export function actionCliCommandInputArgv(command: CompiledActionCliCommand, argv: readonly string[]): readonly string[] {
  const before = command.path.length - 1;
  const count = command.positionalsBeforeLastSegment.length;
  return [...argv.slice(before, before + count), ...argv.slice(command.path.length + count)];
}

/**
 * Keeps canonical whole-input JSON distinct from friendly flags/positionals.
 * The execution owner validates and binds those two shapes through their own
 * schemas before performing the one final merge. Keeping them separate here is
 * what prevents a friendly binder from dropping canonical nested fields.
 */
export function parseActionCliCommandInput(
  command: CompiledActionCliCommand,
  argv: readonly string[],
): ActionCliParseResult {
  return parseActionCliInput(command, actionCliCommandInputArgv(command, argv));
}

export function parseActionCliInput(
  command: ActionCliParseTarget,
  tokens: readonly string[],
  options: Readonly<{ validateHints?: boolean }> = {},
): ActionCliParseResult {
  const flags = buildFlagIndex(command);
  const value: Record<string, unknown> = {};
  const sources = new Map<string, string>();
  const positionalValues: string[] = [];
  let positionalOnly = false;

  const claim = (field: ActionCliField, source: string): ActionCliParseFailure | null => {
    const existing = sources.get(field.path);
    if (existing) {
      return failure(
        `Provide ${field.path} either with ${existing} or with ${source}, not both.`,
      );
    }
    sources.set(field.path, source);
    return null;
  };

  let inputJson: Record<string, unknown> | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (!positionalOnly && token === '--') {
      positionalOnly = true;
      continue;
    }
    const equalsIndex = token.indexOf('=');
    const name = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    // A declared short alias is a field flag; undeclared dash-prefixed bytes
    // remain positional text, just as before.
    if (positionalOnly || (!token.startsWith('--') && !flags.has(name))) {
      positionalValues.push(token);
      continue;
    }
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : null;

    if (name === ACTION_CLI_WHOLE_INPUT_FLAG) {
      const raw = inlineValue ?? tokens[index + 1];
      if (typeof raw !== 'string') return failure(`Option ${ACTION_CLI_WHOLE_INPUT_FLAG} requires a value.`);
      if (inlineValue === null && raw.startsWith('--')) {
        return failure(`Option ${ACTION_CLI_WHOLE_INPUT_FLAG} requires a value.`);
      }
      if (inlineValue === null) index += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return failure(`Invalid ${ACTION_CLI_WHOLE_INPUT_FLAG}: expected JSON.`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return failure(`Invalid ${ACTION_CLI_WHOLE_INPUT_FLAG}: expected a JSON object.`);
      }
      if (inputJson) return failure(`Provide ${ACTION_CLI_WHOLE_INPUT_FLAG} once.`);
      inputJson = parsed as Record<string, unknown>;
      // A duplicate source is rejected in either order: whole-input JSON does
      // not silently win over an earlier field flag, and it does not silently
      // lose to a later one.
      for (const key of Object.keys(inputJson)) {
        const existing = sources.get(key);
        if (existing) {
          return failure(`Provide ${key} either with ${existing} or with ${ACTION_CLI_WHOLE_INPUT_FLAG}, not both.`);
        }
        sources.set(key, ACTION_CLI_WHOLE_INPUT_FLAG);
      }
      continue;
    }

    const match = flags.get(name);
    if (!match) return failure(`Unknown option: ${name}`);
    const { field, form } = match;

    if (form === 'boolean_true' || form === 'boolean_false') {
      if (inlineValue !== null) return failure(`Option ${name} does not accept a value.`);
      const conflict = claim(field, name);
      if (conflict) return conflict;
      value[field.path] = form === 'boolean_true';
      continue;
    }

    const raw = inlineValue ?? tokens[index + 1];
    if (typeof raw !== 'string') return failure(`Option ${name} requires a value.`);
    if (inlineValue === null && raw.startsWith('--')) {
      return failure(`Option ${name} requires a value.`);
    }
    if (inlineValue === null) index += 1;

    if (form === 'json') {
      const conflict = claim(field, name);
      if (conflict) return conflict;
      try {
        value[field.path] = JSON.parse(raw);
      } catch {
        return failure(`Invalid ${name}: expected JSON.`);
      }
      continue;
    }

    if (field.kind === 'string_list') {
      // Repeating a list flag — under any accepted spelling — is one source.
      // Another source for the same field, such as whole-input JSON, is not.
      const existing = sources.get(field.path);
      if (existing !== undefined && !fieldSpellings(field).includes(existing)) {
        return failure(`Provide ${field.path} either with ${existing} or with ${name}, not both.`);
      }
      const collected = value[field.path];
      value[field.path] = [...(Array.isArray(collected) ? collected : []), ...splitListValue(field, raw)];
      if (existing === undefined) sources.set(field.path, name);
      continue;
    }

    const conflict = claim(field, name);
    if (conflict) return conflict;
    const coerced = coerceScalar(field, raw);
    if (isParseFailure(coerced)) return coerced;
    value[field.path] = coerced;
  }

  if (!command.variadicPositional && positionalValues.length > command.positionals.length) {
    return failure(`Unexpected argument: ${positionalValues[command.positionals.length]}`);
  }
  for (const [index, positional] of positionalValues.slice(0, command.positionals.length).entries()) {
    const field = command.positionals[index]!;
    const coerced = coerceScalar(field, positional);
    if (isParseFailure(coerced)) return coerced;
    // An interleaved slot also selects the command's target. Whole JSON may
    // repeat that selector only with the same value, never change its target.
    if (inputJson !== null && index < (command.positionalsBeforeLastSegment?.length ?? 0)
      && sources.get(field.path) === ACTION_CLI_WHOLE_INPUT_FLAG) {
      if (readActionInputPath(inputJson, field.path) !== coerced) return failure(`Command selector ${field.path} conflicts with ${ACTION_CLI_WHOLE_INPUT_FLAG}.`);
      continue;
    }
    const conflict = claim(field, `<${field.path}>`);
    if (conflict) return conflict;
    value[field.path] = coerced;
  }
  const trailingPositionals = positionalValues.slice(command.positionals.length);
  if (command.variadicPositional && trailingPositionals.length > 0) {
    const field = command.variadicPositional;
    const conflict = claim(field, `<${field.path}...>`);
    if (conflict) return conflict;
    value[field.path] = trailingPositionals;
  }

  // Hints govern friendly fields. A canonical-only input may intentionally use
  // nested canonical replacements for required friendly fields (for example
  // `firstMessage` instead of `message`), so it bypasses caller-hint checks and
  // proceeds to canonical validation. When a friendly overlay exists, the base
  // remains visible only for conditional/required hint evaluation.
  if (options.validateHints !== false && (inputJson === null || Object.keys(value).length > 0)) {
    const hintInput = inputJson === null ? value : { ...inputJson, ...value };
    const hintFailure = validateFieldHints(command, hintInput);
    if (hintFailure) return hintFailure;
  }

  return {
    ok: true,
    canonicalBase: inputJson === null ? null : Object.freeze({ ...inputJson }),
    callerOverlay: Object.freeze({ ...value }),
  };
}
