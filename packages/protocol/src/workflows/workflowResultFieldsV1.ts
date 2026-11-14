import type { PluginJsonSchemaV2 } from '../plugins/contributions/jsonSchema.js';
import type { WorkflowResultContract } from './workflowV1.js';

/**
 * The finite named-field projection of a result contract (04 §6.1).
 *
 * A result contract is a full JSON Schema, validated at runtime by
 * `validateExecutionRunProfileResult`. Named-field authoring, the review value
 * editor, the reference pickers and the validator's field check all read the
 * same small subset through this one owner:
 *
 *   { type: 'object', properties?, required?, additionalProperties?: false }
 *
 * where each property is Yes/No (`boolean`), Text (`string`), Number
 * (`number`), Choice (`string` + non-empty unique string `enum`) or List
 * (`array` of `boolean`/`string`/`number` items), optionally with `title` and
 * `description`, with text length constraints preserved. Anything else projects to `advanced` and is never rewritten
 * by the builder: the projection is exact, so `build(project(x))` equals `x`
 * for every projectable contract.
 */
export const WORKFLOW_RESULT_FIELD_TYPES = [
  'boolean',
  'text',
  'number',
  'choice',
  'list',
] as const;
export type WorkflowResultFieldType =
  (typeof WORKFLOW_RESULT_FIELD_TYPES)[number];
export const WORKFLOW_RESULT_LIST_ITEM_TYPES = [
  'text',
  'number',
  'boolean',
] as const;
export type WorkflowResultListItemType =
  (typeof WORKFLOW_RESULT_LIST_ITEM_TYPES)[number];

export type WorkflowResultField = Readonly<{
  name: string;
  type: WorkflowResultFieldType;
  required: boolean;
  description?: string;
  /** Preserved from an imported schema; the editor names a field by its key. */
  title?: string;
  /** Choice values, in order. */
  choices?: readonly string[];
  /** List item type. */
  itemType?: WorkflowResultListItemType;
  /** Imported text constraints remain attached through named-field edits. */
  minLength?: number;
  maxLength?: number;
}>;

export type WorkflowResultFieldsProjection =
  | Readonly<{ kind: 'text' }>
  | Readonly<{ kind: 'decision'; decisions: readonly string[] }>
  | Readonly<{
      kind: 'fields';
      fields: readonly WorkflowResultField[];
      closed: boolean;
    }>
  | Readonly<{ kind: 'advanced' }>;

const ROOT_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
]);
const FIELD_KEYS = new Set(['type', 'title', 'description', 'enum', 'items', 'minLength', 'maxLength']);

/** One authoring rule for the editor and definition edits; retained other keys stay advanced. */
export function isWorkflowResultFieldNameValid(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/u.test(name);
}

/** Inspect raw authoring input before the shared JSON Schema parser can drop an unsupported key. */
export function findInvalidWorkflowResultFieldName(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('kind' in result) || result.kind !== 'json'
    || !('schema' in result) || typeof result.schema !== 'object' || result.schema === null
    || !('properties' in result.schema) || typeof result.schema.properties !== 'object' || result.schema.properties === null) return null;
  return Object.keys(result.schema.properties).find((name) => !isWorkflowResultFieldNameValid(name)) ?? null;
}

const SCALAR_SCHEMA_TYPE = {
  text: 'string',
  number: 'number',
  boolean: 'boolean',
} as const;

function readScalarType(
  type: PluginJsonSchemaV2['type'],
): WorkflowResultListItemType | null {
  return type === 'string'
    ? 'text'
    : type === 'number'
      ? 'number'
      : type === 'boolean'
        ? 'boolean'
        : null;
}

function projectField(
  name: string,
  schema: PluginJsonSchemaV2,
  required: boolean,
): WorkflowResultField | null {
  if (Object.keys(schema).some((key) => !FIELD_KEYS.has(key))) return null;
  if (schema.title !== undefined && typeof schema.title !== 'string')
    return null;
  if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined)) return null;
  const base = {
    name,
    required,
    ...(schema.description === undefined
      ? {}
      : { description: schema.description }),
    ...(schema.title === undefined ? {} : { title: schema.title }),
    ...(schema.minLength === undefined ? {} : { minLength: schema.minLength }),
    ...(schema.maxLength === undefined ? {} : { maxLength: schema.maxLength }),
  };
  if (schema.type === 'array') {
    if (schema.enum !== undefined || schema.items === undefined) return null;
    const items = schema.items;
    if (Object.keys(items).some((key) => key !== 'type')) return null;
    const itemType = readScalarType(items.type);
    return itemType === null ? null : { ...base, type: 'list', itemType };
  }
  if (schema.items !== undefined) return null;
  if (schema.enum !== undefined) {
    const choices = schema.enum;
    if (
      schema.type !== 'string' ||
      // An empty list is a Choice still being authored; the editor asks for a value.
      !choices.every(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ) ||
      new Set(choices).size !== choices.length
    )
      return null;
    return { ...base, type: 'choice', choices };
  }
  const scalar = readScalarType(schema.type);
  return scalar === null ? null : { ...base, type: scalar };
}

/** Reads a result contract as named fields when, and only when, it is exactly representable. */
export function projectWorkflowResultFields(
  result: WorkflowResultContract | undefined,
): WorkflowResultFieldsProjection {
  if (result === undefined || result.kind === 'text') return { kind: 'text' };
  if (result.kind === 'decision')
    return { kind: 'decision', decisions: result.decisions };
  const schema = result.schema;
  if (
    schema.type !== 'object' ||
    Object.keys(schema).some((key) => !ROOT_KEYS.has(key))
  )
    return { kind: 'advanced' };
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  )
    return { kind: 'advanced' };
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  if (
    new Set(required).size !== required.length ||
    required.some((name) => !Object.hasOwn(properties, name))
  ) {
    return { kind: 'advanced' };
  }
  const fields: WorkflowResultField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isWorkflowResultFieldNameValid(name)) return { kind: 'advanced' };
    const field = projectField(name, property, required.includes(name));
    if (field === null) return { kind: 'advanced' };
    fields.push(field);
  }
  return {
    kind: 'fields',
    fields,
    closed: schema.additionalProperties === false,
  };
}

/**
 * Writes named fields back as the canonical contract. `closed` defaults to
 * true for new contracts so later steps can rely on exactly these fields; an
 * open loaded contract stays open. Required names follow field order.
 */
export function buildWorkflowResultFieldsContract(
  fields: readonly WorkflowResultField[],
  options: Readonly<{ closed?: boolean }> = {},
): Extract<WorkflowResultContract, { kind: 'json' }> {
  const properties = Object.fromEntries(fields.map((field): [string, PluginJsonSchemaV2] => {
    const described = {
      ...(field.minLength === undefined || (field.type !== 'text' && field.type !== 'choice') ? {} : { minLength: field.minLength }),
      ...(field.maxLength === undefined || (field.type !== 'text' && field.type !== 'choice') ? {} : { maxLength: field.maxLength }),
      ...(field.title === undefined ? {} : { title: field.title }),
      ...(field.description === undefined || field.description === ''
        ? {}
        : { description: field.description }),
    };
    return [field.name,
      field.type === 'list'
        ? {
            type: 'array',
            ...described,
            items: { type: SCALAR_SCHEMA_TYPE[field.itemType ?? 'text'] },
          }
        : field.type === 'choice'
          ? { type: 'string', ...described, enum: [...(field.choices ?? [])] }
          : { type: SCALAR_SCHEMA_TYPE[field.type], ...described }];
  }));
  const required = fields
    .filter((field) => field.required)
    .map((field) => field.name);
  return {
    kind: 'json',
    schema: {
      type: 'object',
      properties,
      ...(required.length === 0 ? {} : { required }),
      ...(options.closed === false ? {} : { additionalProperties: false }),
    },
  };
}

/**
 * The field names a later step can rely on: a closed named-field contract
 * declares exactly these, so a reference to any other first path segment can
 * never resolve. Open and advanced contracts declare no closed set.
 */
export function readWorkflowClosedResultFieldNames(
  result: WorkflowResultContract | undefined,
): ReadonlySet<string> | null {
  const projection = projectWorkflowResultFields(result);
  return projection.kind === 'fields' && projection.closed
    ? new Set(projection.fields.map((field) => field.name))
    : null;
}
