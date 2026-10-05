import { z } from 'zod';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../contributionIdentity.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '../../actions/jsonSchemaValidation.js';
import { PluginJsonSchemaV2Schema, PluginJsonValueV2Schema, PluginLocalizedStringV2Schema, type PluginJsonSchemaV2 } from '../publicTypes.js';

export const PluginDeclarativeDataFieldV1Schema = z.object({
  path: z.array(z.string().min(1)), type: z.enum(['string', 'number', 'boolean']),
}).strict();
export type PluginDeclarativeDataFieldV1 = z.infer<typeof PluginDeclarativeDataFieldV1Schema>;

/** Resource inputs are the exact mounted consumer inputs, never RPC overrides. */
export const PluginDeclarativeDataSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resource'), resource: asProtocolZod(PluginContributionIdentityV1Schema),
    inputSchema: PluginJsonSchemaV2Schema, input: PluginJsonValueV2Schema.optional(), outputSchema: PluginJsonSchemaV2Schema }).strict(),
  z.object({ kind: z.literal('value'), value: PluginJsonValueV2Schema }).strict(),
]);
export type PluginDeclarativeDataSourceV1 = z.infer<typeof PluginDeclarativeDataSourceV1Schema>;

const column = z.object({ label: PluginLocalizedStringV2Schema, field: PluginDeclarativeDataFieldV1Schema,
  priority: z.enum(['primary', 'secondary']).optional(), proportion: z.boolean().optional() }).strict();
const meaning = z.enum(['good', 'bad', 'neutral']);
const markState = z.object({ label: PluginLocalizedStringV2Schema, meaning }).strict();
const mark = z.object({ field: PluginDeclarativeDataFieldV1Schema, whenTrue: markState, whenFalse: markState }).strict();
export const PluginDeclarativeMetricNodeV1Schema = z.object({ kind: z.literal('metric'), label: PluginLocalizedStringV2Schema,
  data: PluginDeclarativeDataSourceV1Schema, value: PluginDeclarativeDataFieldV1Schema, unit: PluginLocalizedStringV2Schema.optional(),
  comparison: z.object({ value: PluginDeclarativeDataFieldV1Schema, label: PluginLocalizedStringV2Schema, meaning }).strict().optional() }).strict();
export const PluginDeclarativeTableNodeV1Schema = z.object({ kind: z.literal('table'), label: PluginLocalizedStringV2Schema.optional(),
  data: PluginDeclarativeDataSourceV1Schema, rows: z.array(z.string().min(1)), columns: z.array(column).min(1), incomplete: z.boolean().optional(), mark: mark.optional() }).strict();
export const PluginDeclarativeRowsNodeV1Schema = PluginDeclarativeTableNodeV1Schema.extend({ kind: z.literal('rows') });
export const PluginDeclarativeChartNodeV1Schema = z.object({ kind: z.literal('chart'), label: PluginLocalizedStringV2Schema,
  style: z.enum(['bar', 'line']), data: PluginDeclarativeDataSourceV1Schema, rows: z.array(z.string().min(1)),
  x: PluginDeclarativeDataFieldV1Schema, y: PluginDeclarativeDataFieldV1Schema }).strict();
export type PluginDeclarativeDataNodeV1 = z.infer<typeof PluginDeclarativeMetricNodeV1Schema>
  | z.infer<typeof PluginDeclarativeTableNodeV1Schema> | z.infer<typeof PluginDeclarativeRowsNodeV1Schema>
  | z.infer<typeof PluginDeclarativeChartNodeV1Schema>;

export function isPluginDeclarativeDataNodeV1(node: { kind: string }): node is PluginDeclarativeDataNodeV1 {
  return node.kind === 'metric' || node.kind === 'table' || node.kind === 'rows' || node.kind === 'chart';
}

function schemaAt(root: PluginJsonSchemaV2, path: readonly string[]): PluginJsonSchemaV2 | undefined {
  let schema: PluginJsonSchemaV2 | undefined = root;
  for (const key of path) schema = schema?.type === 'object' ? schema.properties?.[key] : undefined;
  return schema;
}

export function readPluginDeclarativeDataFieldV1(value: unknown, field: PluginDeclarativeDataFieldV1): string | number | boolean {
  let current = value;
  for (const key of field.path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, key)) throw new Error('declarative_data_field_invalid');
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  if (typeof current !== field.type || (typeof current === 'number' && !Number.isFinite(current))) throw new Error('declarative_data_field_invalid');
  return current as string | number | boolean;
}

export function readPluginDeclarativeDataRowsV1(value: unknown, path: readonly string[]): readonly unknown[] {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, key)) throw new Error('declarative_data_rows_invalid');
    current = (current as Readonly<Record<string, unknown>>)[key];
  }
  if (!Array.isArray(current)) throw new Error('declarative_data_rows_invalid');
  return current;
}

/** Validate at document admission and again at the Resource output boundary. */
export function validatePluginDeclarativeDataNodeV1(node: PluginDeclarativeDataNodeV1, output?: unknown): void {
  const fields = node.kind === 'metric' ? [node.value, ...(node.comparison ? [node.comparison.value] : [])]
    : node.kind === 'chart' ? [node.x, node.y] : [...node.columns.map((entry) => entry.field), ...(node.mark ? [node.mark.field] : [])];
  if ((node.kind === 'rows' || node.kind === 'table') && node.mark && node.mark.field.type !== 'boolean') throw new Error('declarative_data_field_invalid');
  if (node.kind === 'chart' && (node.y.type !== 'number' || node.x.type === 'boolean')) throw new Error('declarative_data_field_invalid');
  if ((node.kind === 'rows' || node.kind === 'table') && node.columns.some((entry) => entry.proportion && entry.field.type !== 'number')) throw new Error('declarative_data_field_invalid');
  if (node.data.kind === 'resource') {
    const inputValidator = compilePluginJsonSchema(node.data.inputSchema);
    if (node.data.input !== undefined && !isValidPluginJsonSchemaValue(inputValidator, node.data.input)) throw new Error('declarative_data_input_invalid');
    const root = node.kind === 'metric' ? node.data.outputSchema : schemaAt(node.data.outputSchema, node.rows)?.items;
    if (!root || (node.kind !== 'metric' && schemaAt(node.data.outputSchema, node.rows)?.type !== 'array')) throw new Error('declarative_data_rows_invalid');
    for (const field of fields) {
      const declared = schemaAt(root, field.path);
      if (!declared || (declared.type !== field.type && !(field.type === 'number' && declared.type === 'integer'))) throw new Error('declarative_data_field_invalid');
    }
    const validateOutput = compilePluginJsonSchema(node.data.outputSchema);
    if (output === undefined) return;
    if (!isValidPluginJsonSchemaValue(validateOutput, output)) throw new Error('declarative_data_output_invalid');
  }
  const value = node.data.kind === 'value' ? node.data.value : output;
  const rows = node.kind === 'metric' ? [value] : readPluginDeclarativeDataRowsV1(value, node.rows);
  for (const row of rows) for (const field of fields) readPluginDeclarativeDataFieldV1(row, field);
}

/** Only displayed scalar fields are copied; undeclared/private output never is. */
export function freezePluginDeclarativeDataNodeV1(node: PluginDeclarativeDataNodeV1, output: unknown): PluginDeclarativeDataNodeV1 {
  validatePluginDeclarativeDataNodeV1(node, output);
  const value = node.data.kind === 'value' ? node.data.value : output;
  if (node.kind === 'metric') {
    if (!node.comparison) return { ...node, data: { kind: 'value', value: readPluginDeclarativeDataFieldV1(value, node.value) }, value: { path: [], type: node.value.type } };
    return { ...node, data: { kind: 'value', value: { value: readPluginDeclarativeDataFieldV1(value, node.value),
      comparison: readPluginDeclarativeDataFieldV1(value, node.comparison.value) } }, value: { path: ['value'], type: node.value.type },
      comparison: { ...node.comparison, value: { path: ['comparison'], type: node.comparison.value.type } } };
  }
  const rows = readPluginDeclarativeDataRowsV1(value, node.rows);
  if (node.kind === 'chart') return { ...node, data: { kind: 'value', value: rows.map((row) => ({ x: readPluginDeclarativeDataFieldV1(row, node.x), y: readPluginDeclarativeDataFieldV1(row, node.y) })) }, rows: [], x: { path: ['x'], type: node.x.type }, y: { path: ['y'], type: 'number' } };
  return { ...node, data: { kind: 'value', value: rows.map((row) => ({
    ...Object.fromEntries(node.columns.map((entry, index) => [`c${index}`, readPluginDeclarativeDataFieldV1(row, entry.field)])),
    ...(node.mark ? { mark: readPluginDeclarativeDataFieldV1(row, node.mark.field) } : {}),
  })) }, rows: [], columns: node.columns.map((entry, index) => ({ ...entry, field: { path: [`c${index}`], type: entry.field.type } })),
  ...(node.mark ? { mark: { ...node.mark, field: { path: ['mark'], type: 'boolean' } } } : {}) };
}
