/**
 * The SDK publishes Protocol-owned composable values directly. This module
 * projects their declarations for SDK authors without creating another parser
 * or JSON-Schema owner.
 */
import { createProtocolStoredReadSchema as canonicalCreateProtocolStoredReadSchema, defineProtocolArray as canonicalDefineProtocolArray, defineProtocolJsonValue as canonicalDefineProtocolJsonValue, defineProtocolLiteral as canonicalDefineProtocolLiteral, defineProtocolNumber as canonicalDefineProtocolNumber, defineProtocolObject as canonicalDefineProtocolObject, defineProtocolString as canonicalDefineProtocolString, defineProtocolUnion as canonicalDefineProtocolUnion, defineProtocolUniqueArray as canonicalDefineProtocolUniqueArray, defineProtocolUtf8String as canonicalDefineProtocolUtf8String, isProtocolComposableSchema as canonicalIsProtocolComposableSchema, ProtocolValidationError as canonicalProtocolValidationError } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { pluginJsonValuesEqual as canonicalPluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { embedProtocolJsonSchema as canonicalEmbedProtocolJsonSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

/** Embed an existing schema without changing the meaning of its document-local references. */
export const embedProtocolJsonSchema: (projection: PluginJsonSchema, path: readonly (string | number)[]) => PluginJsonSchema = canonicalEmbedProtocolJsonSchema;
/** Re-export exact owner identities so consumers can name inferred declarations through the SDK. */
import type {
    ProtocolArrayOptions,
    ProtocolComposableSchema,
    ProtocolJsonValueOptions,
    ProtocolNumberOptions,
    ProtocolObjectOptions,
    ProtocolSchemaInput,
    ProtocolSchemaOutput,
    ProtocolStoredReadSchema,
    ProtocolStringOptions,
    ProtocolUniqueJsonArrayOptions,
    ProtocolUtf8StringOptions,
} from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
export type {
    ProtocolArrayOptions,
    ProtocolComposableSchema,
    ProtocolJsonValueOptions,
    ProtocolNumberOptions,
    ProtocolObjectEvolutionPolicy,
    ProtocolObjectOptions,
    ProtocolSchemaInput,
    ProtocolSchemaOutput,
    ProtocolSchemaSafeParseResult,
    ProtocolStoredReadSchema,
    ProtocolStringOptions,
    ProtocolUniqueJsonArrayOptions,
    ProtocolUtf8StringOptions,
    ProtocolValidationIssue,
    ProtocolObjectProjection,
} from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import type { JsonValue as ProtocolJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
export type { JsonValue as ProtocolJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginJsonSchemaV2 as PluginJsonSchema, PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
export type { PluginJsonSchemaV2 as PluginJsonSchema, PluginJsonValueV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
export { canonicalProtocolValidationError as ProtocolValidationError };

export const createProtocolStoredReadSchema: <TInput, TOutput>(
    schema: ProtocolComposableSchema<TInput, TOutput>,
) => ProtocolStoredReadSchema<TOutput> = canonicalCreateProtocolStoredReadSchema;

// Separate mapped projections keep declaration emit from forwarding an unbound
// projection parameter through generic object fields.
type ProtocolObjectInput<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
> = Readonly<{
    readonly [TKey in keyof TShape as undefined extends ProtocolSchemaInput<TShape[TKey]>
        ? never
        : TKey]: Exclude<
        ProtocolSchemaInput<TShape[TKey]>,
        undefined
    >;
} & {
    readonly [TKey in keyof TShape as undefined extends ProtocolSchemaInput<TShape[TKey]>
        ? TKey
        : never]?: Exclude<
        ProtocolSchemaInput<TShape[TKey]>,
        undefined
    >;
}>;

type ProtocolObjectOutput<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
> = Readonly<{
    readonly [TKey in keyof TShape as undefined extends ProtocolSchemaOutput<TShape[TKey]>
        ? never
        : TKey]: Exclude<
        ProtocolSchemaOutput<TShape[TKey]>,
        undefined
    >;
} & {
    readonly [TKey in keyof TShape as undefined extends ProtocolSchemaOutput<TShape[TKey]>
        ? TKey
        : never]?: Exclude<
        ProtocolSchemaOutput<TShape[TKey]>,
        undefined
    >;
}>;

type ProtocolObjectFields<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    TProjection extends 'input' | 'output',
> = TProjection extends 'input' ? ProtocolObjectInput<TShape> : ProtocolObjectOutput<TShape>;

type ProtocolObjectAdditionalValue<
    TOptions extends ProtocolObjectOptions,
    TProjection extends 'input' | 'output',
> = TOptions['additionalProperties'] extends ProtocolComposableSchema<unknown, unknown>
    ? TProjection extends 'input'
        ? ProtocolSchemaInput<TOptions['additionalProperties']>
        : ProtocolSchemaOutput<TOptions['additionalProperties']>
    : ProtocolJsonValue;

type ProtocolObjectKnownValue<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    TProjection extends 'input' | 'output',
> = Exclude<
    ProtocolObjectFields<TShape, TProjection>[keyof ProtocolObjectFields<TShape, TProjection>],
    undefined
>;

type ProtocolObjectPreservedProjection<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    TOptions extends ProtocolObjectOptions,
    TProjection extends 'input' | 'output',
> = ProtocolObjectFields<TShape, TProjection> & Readonly<Record<
    string,
    ProtocolObjectAdditionalValue<TOptions, TProjection> | ProtocolObjectKnownValue<TShape, TProjection>
>>;

/**
 * The one SDK recognition boundary for an executable public composable schema.
 *
 * Recognition is structural because an executable parser cannot travel through
 * manifest JSON and separately installed SDK copies share no symbol identity.
 * Protocol owns that structural decision; the SDK only re-states the narrowed
 * type as its own public projection. Anything else is plain declaration data
 * and is rejected by whichever owner consumes it — the executable-schema
 * requirement for a contribution protocol, or JSON Schema normalization for a
 * manifest field. The SDK does not classify near-misses on its own.
 */
export function readProtocolComposableSchema<TInput = ProtocolJsonValue, TOutput = TInput>(
    value: unknown,
): ProtocolComposableSchema<TInput, TOutput> | undefined {
    return canonicalIsProtocolComposableSchema<TInput, TOutput>(value) ? value : undefined;
}

/** Canonical Protocol runtime values retain their exact identity. */
export const pluginJsonValuesEqual: (left: unknown, right: unknown) => boolean =
    canonicalPluginJsonValuesEqual;
export const defineProtocolLiteral: <const TValue extends string | number | boolean | null>(
    value: TValue,
) => ProtocolComposableSchema<TValue, TValue> = canonicalDefineProtocolLiteral;
export const defineProtocolString: (
    options?: ProtocolStringOptions,
) => ProtocolComposableSchema<string, string> = canonicalDefineProtocolString;
export const defineProtocolUtf8String: (
    options: ProtocolUtf8StringOptions,
) => ProtocolComposableSchema<string, string> = canonicalDefineProtocolUtf8String;
export const defineProtocolNumber: (
    options?: ProtocolNumberOptions,
) => ProtocolComposableSchema<number, number> = canonicalDefineProtocolNumber;
export const defineProtocolObject = canonicalDefineProtocolObject as <
    const TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    const TOptions extends ProtocolObjectOptions,
>(
    shape: TShape,
    options: TOptions,
) => ProtocolComposableSchema<
    TOptions['policy'] extends 'additive-open/preserve'
        ? ProtocolObjectPreservedProjection<TShape, TOptions, 'input'>
        : ProtocolObjectFields<TShape, 'input'>,
    TOptions['policy'] extends 'additive-open/preserve'
        ? ProtocolObjectPreservedProjection<TShape, TOptions, 'output'>
        : ProtocolObjectFields<TShape, 'output'>
>;
export const defineProtocolArray = canonicalDefineProtocolArray as <
    TSchema extends ProtocolComposableSchema<unknown, unknown>,
>(
    itemSchema: TSchema,
    options?: ProtocolArrayOptions,
) => ProtocolComposableSchema<
    readonly ProtocolSchemaInput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
>;
export const defineProtocolUniqueArray = canonicalDefineProtocolUniqueArray as <
    TSchema extends ProtocolComposableSchema<unknown, unknown>,
>(
    itemSchema: TSchema,
    options?: ProtocolUniqueJsonArrayOptions,
) => ProtocolComposableSchema<
    readonly ProtocolSchemaInput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
>;
export const defineProtocolUnion = canonicalDefineProtocolUnion as <
    const TMembers extends readonly [
        ProtocolComposableSchema<unknown, unknown>,
        ProtocolComposableSchema<unknown, unknown>,
        ...ProtocolComposableSchema<unknown, unknown>[],
    ],
>(members: TMembers, options?: ProtocolJsonValueOptions) => ProtocolComposableSchema<
    ProtocolSchemaInput<TMembers[number]>,
    ProtocolSchemaOutput<TMembers[number]>
>;
export const defineProtocolJsonValue: <TValue extends ProtocolJsonValue = ProtocolJsonValue>(
    options?: ProtocolJsonValueOptions,
) => ProtocolComposableSchema<TValue, TValue> = canonicalDefineProtocolJsonValue;
