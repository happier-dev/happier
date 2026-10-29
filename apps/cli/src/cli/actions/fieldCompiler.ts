import { actionCliFlagNameForField } from '@happier-dev/protocol/actions/actionCliProjection';
import type { ActionInputFieldHint, ActionInputHints, ActionInputPredicate, JsonSchemaObject } from '@happier-dev/protocol';
import { ACTION_CLI_COMPILER_OWNED_FLAGS } from './flags';

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

export function readObjectProperties(schema: JsonSchemaObject): Readonly<Record<string, JsonSchemaObject>> | null {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
  return properties as Readonly<Record<string, JsonSchemaObject>>;
}

function isSchemaObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Field discovery only; the original caller schema still admits complete inputs. */
function readCallerObjectSchemas(schema: JsonSchemaObject): readonly JsonSchemaObject[] {
  if (readObjectProperties(schema)) return [schema];
  const arms = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(arms)) return [];
  const objects: JsonSchemaObject[] = [];
  for (const arm of arms) {
    if (!isSchemaObject(arm)) return [];
    const nested = readCallerObjectSchemas(arm);
    if (!nested.length) return [];
    objects.push(...nested);
  }
  return objects;
}

/**
 * Zod projects `.optional()`/`.nullable()` as `anyOf` arms and unions as
 * `anyOf`/`oneOf`. Unwrap a single non-null arm; distinct shapes remain a union.
 */
export function unwrapNullableSchema(schema: JsonSchemaObject): JsonSchemaObject {
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

export function readSchemaType(schema: JsonSchemaObject): string | null {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const concrete = type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    return concrete.length === 1 ? concrete[0]! : null;
  }
  return null;
}

export function readEnumChoices(schema: JsonSchemaObject): readonly string[] | null {
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

export function resolveFieldKind(rawSchema: JsonSchemaObject): Readonly<{
  kind: ActionCliFieldKind;
  choices: readonly string[] | null;
}> {
  const schema = unwrapNullableSchema(rawSchema);
  const arms = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(arms) && arms.length && arms.every(isSchemaObject)) {
    const variants = arms.map(resolveFieldKind);
    const first = variants[0]!;
    if (variants.every(variant => variant.kind === first.kind)) {
      return { kind: first.kind, choices: variants.every(variant => variant.choices !== null)
        ? Object.freeze([...new Set(variants.flatMap(variant => variant.choices ?? []))]) : null };
    }
    return { kind: 'json', choices: null };
  }
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

export function findHint(hints: ActionInputHints | undefined, path: string): ActionInputFieldHint | null {
  return hints?.fields?.find((field) => field.path === path) ?? null;
}

export function readHintChoices(hint: ActionInputFieldHint | null): readonly string[] | null {
  const options = hint?.options;
  if (!options || options.length === 0) return null;
  const values = options
    .map((option) => option.value)
    .filter((value): value is string => typeof value === 'string');
  return values.length === options.length ? Object.freeze(values) : null;
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function generatedFlagSpellings(kind: ActionCliFieldKind, flag: string): readonly string[] {
  if (kind === 'boolean') return Object.freeze([flag, `--no-${flag.slice(2)}`]);
  if (kind === 'json') return Object.freeze([`${flag}-json`]);
  return Object.freeze([flag, `${flag}-json`]);
}

/** Project only the CLI spelling; the canonical Action schema path is unchanged. */
export function projectActionCliFieldFlag(params: Readonly<{
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
  const aliasesByPath = params.aliasesByPath ?? new Map<string, readonly string[]>();
  const schemas = readCallerObjectSchemas(params.jsonSchema);
  if (!schemas.length) return Object.freeze([]);
  const properties = new Map<string, JsonSchemaObject[]>();
  for (const schema of schemas) {
    for (const [path, property] of Object.entries(readObjectProperties(schema) ?? {})) {
      const variants = properties.get(path) ?? [];
      variants.push(property);
      properties.set(path, variants);
    }
  }
  const requiredPaths = new Set([...properties.keys()].filter(path => schemas.every(schema => (
    Array.isArray(schema.required) && schema.required.includes(path)
  ))));
  const occupied = new Set([
    ...ACTION_CLI_COMPILER_OWNED_FLAGS,
    ...(params.reservedFlags ?? []),
    ...[...aliasesByPath.values()].flat(),
  ]);
  return Object.freeze([...properties].map(([path, variants]): ActionCliField => {
    const propertySchema = variants.length === 1 ? variants[0]! : { anyOf: variants };
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

