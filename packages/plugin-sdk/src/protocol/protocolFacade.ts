/**
 * The SDK publishes Protocol-owned composable values directly. This module
 * projects their declarations for SDK authors without creating another parser
 * or JSON-Schema owner.
 */
import {
    defineProtocolArray as canonicalDefineProtocolArray,
    defineProtocolJsonValue as canonicalDefineProtocolJsonValue,
    defineProtocolLiteral as canonicalDefineProtocolLiteral,
    defineProtocolNumber as canonicalDefineProtocolNumber,
    defineProtocolObject as canonicalDefineProtocolObject,
    defineProtocolString as canonicalDefineProtocolString,
    defineProtocolUnion as canonicalDefineProtocolUnion,
    defineProtocolUniqueArray as canonicalDefineProtocolUniqueArray,
    defineProtocolUtf8String as canonicalDefineProtocolUtf8String,
    pluginJsonValuesEqual as canonicalPluginJsonValuesEqual,
    ProtocolValidationError as canonicalProtocolValidationError,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
/**
 * Declaration-neutral SDK projection of Protocol's mutable structural JSON
 * (`PluginJsonValueV2`): data as authored into declarations and carried on
 * wire payloads, before Protocol normalizes and freezes it. It is not
 * interchangeable with `ProtocolJsonValue`, which names the already normalized
 * strict runtime value. A value of this type may be passed where a strict
 * runtime value is expected; the reverse is deliberately rejected.
 */
export type PluginJsonValueV2 =
    | null
    | boolean
    | number
    | string
    | PluginJsonValueV2[]
    | { [key: string]: PluginJsonValueV2 };

/**
 * Canonical public protocol projection of the SDK schema DTO. Its definition
 * lives at the `/protocol` boundary so inferred consumer declarations can
 * name the public export without reaching through a private identity module.
 */
export type PluginJsonSchema = {
    $schema?: 'http://json-schema.org/draft-07/schema#';
    type?: 'null' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'object';
    format?: 'date-time' | 'time' | 'date' | 'duration' | 'uri' | 'uri-reference' | 'uri-template' | 'url' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'regex' | 'uuid' | 'json-pointer' | 'relative-json-pointer';
    title?: string;
    description?: string;
    default?: PluginJsonValueV2;
    enum?: PluginJsonValueV2[];
    const?: PluginJsonValueV2;
    properties?: Record<string, PluginJsonSchema>;
    required?: string[];
    additionalProperties?: boolean | PluginJsonSchema;
    items?: PluginJsonSchema;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    'x-happier-max-utf8-bytes'?: number;
    'x-happier-max-serialized-utf8-bytes'?: number;
    pattern?: string;
    anyOf?: PluginJsonSchema[];
    oneOf?: PluginJsonSchema[];
    allOf?: PluginJsonSchema[];
};

/**
 * Declaration-neutral SDK projection of Protocol's one strict JSON value: data
 * that has already passed the strict normalizer, so it is immutable here as
 * well. The SDK root republishes this exact type as `JsonValue`; the two names
 * are one contract with one declaration, not two spellings.
 */
export type ProtocolJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly ProtocolJsonValue[]
    | { readonly [key: string]: ProtocolJsonValue };

export type ProtocolValidationIssue = Readonly<{
    path: readonly (string | number)[];
    code: string;
    message: string;
}>;

export interface ProtocolValidationError extends Error {
    readonly issues: readonly ProtocolValidationIssue[];
}

export type ProtocolSchemaSafeParseResult<TOutput> =
    | Readonly<{ success: true; data: TOutput }>
    | Readonly<{ success: false; error: ProtocolValidationError }>;

/** The one validator-neutral schema composition surface available to SDK authors. */
export interface ProtocolComposableSchema<TInput, TOutput = TInput> {
    readonly jsonSchema: PluginJsonSchema;
    // The broad overload preserves runtime parser admission while the typed
    // overload retains authored-input inference through the neutral surface.
    parse(value: unknown): TOutput;
    parse(value: TInput): TOutput;
    safeParse(value: unknown): ProtocolSchemaSafeParseResult<TOutput>;
    optional(): ProtocolComposableSchema<TInput | undefined, TOutput | undefined>;
    nullable(): ProtocolComposableSchema<TInput | null, TOutput | null>;
}

/** Extracts the authored input from a public composable schema. */
export type ProtocolSchemaInput<TSchema> =
    TSchema extends { parse: (...args: infer TArguments) => unknown }
        ? TArguments extends readonly [infer TInput, ...readonly unknown[]]
            ? TInput
            : never
        : never;

/** Extracts the parsed author value from a public composable schema. */
export type ProtocolSchemaOutput<TSchema> =
    TSchema extends { parse: (...args: infer _TArguments) => infer TOutput }
        ? TOutput
        : never;

type ProtocolObjectProjection<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    TProjection extends 'input' | 'output',
> = Readonly<{
    readonly [TKey in keyof TShape as undefined extends (
        TProjection extends 'input'
            ? ProtocolSchemaInput<TShape[TKey]>
            : ProtocolSchemaOutput<TShape[TKey]>
    )
        ? never
        : TKey]: Exclude<
        TProjection extends 'input'
            ? ProtocolSchemaInput<TShape[TKey]>
            : ProtocolSchemaOutput<TShape[TKey]>,
        undefined
    >;
} & {
    readonly [TKey in keyof TShape as undefined extends (
        TProjection extends 'input'
            ? ProtocolSchemaInput<TShape[TKey]>
            : ProtocolSchemaOutput<TShape[TKey]>
    )
        ? TKey
        : never]?: Exclude<
        TProjection extends 'input'
            ? ProtocolSchemaInput<TShape[TKey]>
            : ProtocolSchemaOutput<TShape[TKey]>,
        undefined
    >;
}>;

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
    ProtocolObjectProjection<TShape, TProjection>[keyof ProtocolObjectProjection<TShape, TProjection>],
    undefined
>;

type ProtocolObjectPreservedProjection<
    TShape extends Readonly<Record<string, ProtocolComposableSchema<unknown, unknown>>>,
    TOptions extends ProtocolObjectOptions,
    TProjection extends 'input' | 'output',
> = ProtocolObjectProjection<TShape, TProjection> & Readonly<Record<
    string,
    ProtocolObjectAdditionalValue<TOptions, TProjection> | ProtocolObjectKnownValue<TShape, TProjection>
>>;

function isProtocolComposableSchemaRecord(value: unknown): value is object {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCompleteProtocolComposableSchemaSurface<TInput, TOutput>(
    value: unknown,
): value is ProtocolComposableSchema<TInput, TOutput> {
    if (!isProtocolComposableSchemaRecord(value)) return false;
    const jsonSchema = Reflect.get(value, 'jsonSchema');
    return jsonSchema !== null
        && typeof jsonSchema === 'object'
        && !Array.isArray(jsonSchema)
        && typeof Reflect.get(value, 'parse') === 'function'
        && typeof Reflect.get(value, 'safeParse') === 'function'
        && typeof Reflect.get(value, 'optional') === 'function'
        && typeof Reflect.get(value, 'nullable') === 'function';
}

/**
 * The one SDK recognition boundary for an executable public composable schema.
 * A plain JSON Schema remains plain manifest data; a parser-shaped partial
 * value is rejected instead of silently becoming a second schema spelling.
 */
export function readProtocolComposableSchema<TInput = ProtocolJsonValue, TOutput = TInput>(
    value: unknown,
): ProtocolComposableSchema<TInput, TOutput> | undefined {
    if (hasCompleteProtocolComposableSchemaSurface<TInput, TOutput>(value)) return value;
    if (!isProtocolComposableSchemaRecord(value)) return undefined;

    const members = [
        Reflect.get(value, 'parse'),
        Reflect.get(value, 'safeParse'),
        Reflect.get(value, 'optional'),
        Reflect.get(value, 'nullable'),
    ];
    if (members.some((member) => typeof member === 'function')) {
        throw new TypeError(
            'Protocol composable schema must expose complete parse, safeParse, optional, nullable, and jsonSchema surface',
        );
    }
    return undefined;
}

export type ProtocolObjectEvolutionPolicy =
    | 'closed'
    | 'additive-open/drop'
    | 'additive-open/preserve';

export type ProtocolStringOptions = Readonly<{
    minLength?: number;
    maxLength?: number;
    pattern?: string;
}>;

export type ProtocolUtf8StringOptions = Readonly<{
    maxUtf8Bytes: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
}>;

export type ProtocolNumberOptions = Readonly<{
    integer?: boolean;
    minimum?: number;
    maximum?: number;
}>;

export type ProtocolArrayOptions = Readonly<{
    minItems?: number;
    maxItems?: number;
}>;

export type ProtocolUniqueJsonArrayOptions = ProtocolArrayOptions;

export type ProtocolJsonValueOptions = Readonly<{
    maxSerializedUtf8Bytes?: number;
}>;

export type ProtocolObjectOptions<
    TAdditional extends ProtocolComposableSchema<unknown, unknown> | undefined =
        | ProtocolComposableSchema<unknown, unknown>
        | undefined,
> = Readonly<{
    policy: ProtocolObjectEvolutionPolicy;
    additionalProperties?: TAdditional;
}>;

/** Canonical Protocol runtime values retain their exact identity. */
export const pluginJsonValuesEqual: (left: unknown, right: unknown) => boolean =
    canonicalPluginJsonValuesEqual;
export const ProtocolValidationError: Readonly<{
    new (issues: readonly ProtocolValidationIssue[]): ProtocolValidationError;
    readonly prototype: ProtocolValidationError;
}> = canonicalProtocolValidationError;

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
        : ProtocolObjectProjection<TShape, 'input'>,
    TOptions['policy'] extends 'additive-open/preserve'
        ? ProtocolObjectPreservedProjection<TShape, TOptions, 'output'>
        : ProtocolObjectProjection<TShape, 'output'>
>;
export const defineProtocolArray = canonicalDefineProtocolArray as <
    TSchema extends ProtocolComposableSchema<unknown, unknown>,
>(
    itemSchema: TSchema,
    options?: ProtocolArrayOptions,
) => ProtocolComposableSchema<
    readonly ProtocolSchemaOutput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
>;
export const defineProtocolUniqueArray = canonicalDefineProtocolUniqueArray as <
    TSchema extends ProtocolComposableSchema<unknown, unknown>,
>(
    itemSchema: TSchema,
    options?: ProtocolUniqueJsonArrayOptions,
) => ProtocolComposableSchema<
    readonly ProtocolSchemaOutput<TSchema>[],
    readonly ProtocolSchemaOutput<TSchema>[]
>;
export const defineProtocolUnion = canonicalDefineProtocolUnion as <
    const TMembers extends readonly [
        ProtocolComposableSchema<unknown, unknown>,
        ProtocolComposableSchema<unknown, unknown>,
        ...ProtocolComposableSchema<unknown, unknown>[],
    ],
>(members: TMembers) => ProtocolComposableSchema<
    ProtocolSchemaOutput<TMembers[number]>,
    ProtocolSchemaOutput<TMembers[number]>
>;
export const defineProtocolJsonValue: <TValue extends ProtocolJsonValue = ProtocolJsonValue>(
    options?: ProtocolJsonValueOptions,
) => ProtocolComposableSchema<TValue, TValue> = canonicalDefineProtocolJsonValue;
