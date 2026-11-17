import { z } from 'zod/mini';

const name = z.string().check(z.minLength(1));
const nonnegativeInteger = z.number().check(z.int(), z.nonnegative());
const integer = z.string().check(z.regex(/^[+-]?\d+$/u));
const decimal = z.string().check(z.regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u));
// A repeated four-character group overflows V8's regexp stack on valid large cells.
const base64 = z.string().check(z.regex(/^[A-Za-z0-9+/]*={0,2}$/u), z.refine(value => value.length % 4 === 0));

export const DatabaseSemanticTypeV1Schema = z.enum([
    'text', 'boolean', 'integer', 'decimal', 'float', 'json', 'binary', 'temporal', 'unknown',
]);
export type DatabaseSemanticTypeV1 = z.infer<typeof DatabaseSemanticTypeV1Schema>;

/** Nonfinite floats are tagged; exact SQL numbers and JSON retain their text. */
export const DatabaseValueV1Schema = z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('null') }),
    z.strictObject({ type: z.literal('text'), value: z.string() }),
    z.strictObject({ type: z.literal('boolean'), value: z.boolean() }),
    z.strictObject({ type: z.literal('integer'), value: integer }),
    z.strictObject({ type: z.literal('decimal'), value: decimal }),
    z.strictObject({ type: z.literal('float'), value: z.union([z.number(), z.literal('NaN'), z.literal('Infinity'), z.literal('-Infinity')]) }),
    // Preserve the engine's JSON text, including integers beyond JS precision.
    z.strictObject({ type: z.literal('json'), value: z.string() }),
    z.strictObject({ type: z.literal('binary'), encoding: z.literal('base64'), value: base64 }),
    z.strictObject({ type: z.literal('temporal'), nativeType: name, value: z.string() }),
]);
export type DatabaseValueV1 = z.infer<typeof DatabaseValueV1Schema>;

export const DatabaseValueRangeV1Schema = z.strictObject({
    offset: nonnegativeInteger, length: nonnegativeInteger,
    unit: z.enum(['utf8_bytes', 'bytes']), total: z.optional(nonnegativeInteger),
});
export type DatabaseValueRangeV1 = z.infer<typeof DatabaseValueRangeV1Schema>;
/** A retained slice is explicitly incomplete, never a replacement complete value. */
export const DatabasePartialCellV1Schema = z.discriminatedUnion('valueType', [
    z.strictObject({ type: z.literal('partial'), valueType: z.literal('text'), value: z.string(),
        encoding: z.literal('utf8'), range: z.extend(DatabaseValueRangeV1Schema, { unit: z.literal('utf8_bytes') }) }),
    z.strictObject({ type: z.literal('partial'), valueType: z.literal('json'), value: z.string(),
        encoding: z.literal('utf8'), range: z.extend(DatabaseValueRangeV1Schema, { unit: z.literal('utf8_bytes') }) }),
    z.strictObject({ type: z.literal('partial'), valueType: z.literal('binary'), value: base64,
        encoding: z.literal('base64'), range: z.extend(DatabaseValueRangeV1Schema, { unit: z.literal('bytes') }) }),
]);
export type DatabasePartialCellV1 = z.infer<typeof DatabasePartialCellV1Schema>;
export const DatabaseCellV1Schema = z.union([DatabaseValueV1Schema, DatabasePartialCellV1Schema]);
export type DatabaseCellV1 = z.infer<typeof DatabaseCellV1Schema>;

export const DatabaseNamedCellV1Schema = z.strictObject({ column: name, value: DatabaseValueV1Schema });
export type DatabaseNamedCellV1 = z.infer<typeof DatabaseNamedCellV1Schema>;
export const DatabaseRowIdentityV1Schema = z.strictObject({
    key: z.array(DatabaseNamedCellV1Schema).check(z.minLength(1)),
    original: z.array(DatabaseNamedCellV1Schema),
});
export type DatabaseRowIdentityV1 = z.infer<typeof DatabaseRowIdentityV1Schema>;
export const DatabaseRowV1Schema = z.strictObject({
    cells: z.array(DatabaseCellV1Schema), identity: z.optional(DatabaseRowIdentityV1Schema),
});
export type DatabaseRowV1 = z.infer<typeof DatabaseRowV1Schema>;

/** Position supplies identity: labels can be duplicated, including for zero-row results. */
export const DatabaseColumnV1Schema = z.strictObject({
    name: z.string(), nativeType: name, semanticType: DatabaseSemanticTypeV1Schema,
    nullable: z.optional(z.boolean()), defaultExpression: z.optional(z.nullable(z.string())),
    generated: z.optional(z.boolean()),
});
export type DatabaseColumnV1 = z.infer<typeof DatabaseColumnV1Schema>;
export const DatabaseWriteValueV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('value'), cell: DatabaseValueV1Schema }),
]);
export type DatabaseWriteValueV1 = z.infer<typeof DatabaseWriteValueV1Schema>;
