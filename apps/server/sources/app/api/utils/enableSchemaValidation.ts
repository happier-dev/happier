import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { deferZodSchemaForParser } from '@happier-dev/protocol/lazyZodSchema';

/** Configure the API's native Zod request and response admission. */
export function enableSchemaValidation<Logger extends FastifyBaseLogger>(app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
>): void {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(admittedResponseSerializerCompiler);
    app.addHook('onRoute', route => {
        const schema = route.schema;
        if (!schema) return;
        // Fastify probes Fluent markers/prototypes while normalizing routes.
        // Its native lazy schema is the framework handle; the original shared
        // definition is resolved only by actual parsing or explicit projection.
        for (const key of ['body', 'params', 'querystring', 'query', 'headers']) {
            const value: unknown = Reflect.get(schema, key);
            if (value !== undefined) Reflect.set(schema, key, deferZodSchemaForParser(value));
        }
        if (schema.response) {
            schema.response = Object.fromEntries<unknown>(Object.entries(schema.response)
                .map(([status, value]) => {
                    const parser = deferZodSchemaForParser(value);
                    if (parser !== value && parser !== null && typeof parser === 'object') declaredResponseSchemas.set(parser, value);
                    return [status, parser];
                }));
        }
    });
}

// Response objects already parsed by the exact schema a route declares for that status.
// Weakly held: an entry lives only as long as the response object it describes.
const admittedResponses = new WeakMap<object, unknown>();
// Fastify hands the serializer the parser handle installed below; map it back to the declaration.
const declaredResponseSchemas = new WeakMap<object, unknown>();

/**
 * Parse a response once at its producer. When `schema` is the route's declared schema for the
 * status sent, the response serializer emits this object without parsing it again. Any other
 * payload (unadmitted, admitted by another schema, or replaced by a hook) is still parsed there.
 */
export function admitResponse<TSchema extends { parse(value: unknown): unknown }>(schema: TSchema, value: unknown): ReturnType<TSchema['parse']> {
    const admitted = schema.parse(value);
    if (admitted !== null && typeof admitted === 'object') admittedResponses.set(admitted, schema);
    return admitted as ReturnType<TSchema['parse']>;
}

/**
 * Record a response its producer assembled only from members it admitted itself (each stored
 * value through its own schema, every other member typed construction), for the route that
 * declares `schema` for the status sent. The serializer then emits it without a second parse.
 * The same identity rule as `admitResponse` applies: a hook that replaces the object is parsed.
 */
export function recordAssembledResponse<T extends object>(schema: object, value: T): T {
    admittedResponses.set(value, schema);
    return value;
}

type DeclaredOrder = Readonly<{ keys: readonly string[]; members: readonly (object | undefined)[] }>;
const declaredOrders = new WeakMap<object, DeclaredOrder | null>();

function readDefinition(schema: object): Record<string, unknown> | undefined {
    const internals: unknown = Reflect.get(schema, '_zod');
    const definition: unknown = internals !== null && typeof internals === 'object' ? Reflect.get(internals, 'def') : undefined;
    return definition !== null && typeof definition === 'object' ? definition as Record<string, unknown> : undefined;
}

// Optional/nullable/readonly wrappers and arrays carry their inner schema's order; unions, pipes and
// every other kind are left as produced (their parse output order is the producer's choice).
type InnerSchema = Readonly<{ kind: 'object' | 'array'; schema: object }> | null;
const innerSchemas = new WeakMap<object, InnerSchema>();

function innerObjectOrArraySchema(schema: object): InnerSchema {
    let inner = innerSchemas.get(schema);
    if (inner === undefined) {
        inner = resolveInnerObjectOrArraySchema(schema) ?? null;
        innerSchemas.set(schema, inner);
    }
    return inner;
}

function resolveInnerObjectOrArraySchema(schema: object): Readonly<{ kind: 'object' | 'array'; schema: object }> | undefined {
    let current: object | undefined = schema;
    for (let depth = 0; current && depth < 8; depth++) {
        const definition = readDefinition(current);
        if (!definition) return undefined;
        if (definition.type === 'object') return { kind: 'object', schema: current };
        if (definition.type === 'array') return typeof definition.element === 'object' && definition.element !== null
            ? { kind: 'array', schema: definition.element } : undefined;
        if (definition.type !== 'optional' && definition.type !== 'nullable' && definition.type !== 'readonly') return undefined;
        current = typeof definition.innerType === 'object' && definition.innerType !== null ? definition.innerType : undefined;
    }
    return undefined;
}

function declaredOrder(schema: object): DeclaredOrder | null {
    let order = declaredOrders.get(schema);
    if (order === undefined) {
        const shape = readDefinition(schema)?.shape;
        order = shape !== null && typeof shape === 'object' ? {
            keys: Object.keys(shape),
            // Only members whose order can differ (objects and arrays, possibly wrapped) are visited.
            members: Object.values(shape as Record<string, unknown>).map(member =>
                member !== null && typeof member === 'object' && innerObjectOrArraySchema(member) ? member : undefined),
        } : null;
        declaredOrders.set(schema, order);
    }
    return order;
}

function orderValue(schema: object, value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    const inner = innerObjectOrArraySchema(schema);
    if (!inner) return value;
    if (inner.kind === 'array') return Array.isArray(value) ? orderArray(inner.schema, value) : value;
    return Array.isArray(value) ? value : orderObject(inner.schema, value as Record<string, unknown>);
}

function orderObject(schema: object, source: Record<string, unknown>): Record<string, unknown> {
    const order = declaredOrder(schema);
    if (!order) return source;
    // Members already in declared order (and unchanged below) keep the producer's object.
    let changed = false;
    let values: Map<string, unknown> | undefined;
    for (let index = 0; index < order.keys.length; index++) {
        const member = order.members[index];
        const key = order.keys[index]!;
        if (member === undefined || !Object.hasOwn(source, key)) continue;
        const value = orderValue(member, source[key]);
        if (value !== source[key]) { (values ??= new Map()).set(key, value); changed = true; }
    }
    if (!changed) {
        // Declared members must lead, in declaration order; pass-through members follow.
        let expected = 0;
        for (const key in source) {
            while (expected < order.keys.length && !Object.hasOwn(source, order.keys[expected]!)) expected++;
            if (expected === order.keys.length) break;
            if (key !== order.keys[expected]) { changed = true; break; }
            expected++;
        }
        if (!changed) return source;
    }
    const ordered: Record<string, unknown> = {};
    for (const key of order.keys) {
        if (Object.hasOwn(source, key)) ordered[key] = values?.has(key) ? values.get(key) : source[key];
    }
    for (const key of Object.keys(source)) if (!Object.hasOwn(ordered, key)) ordered[key] = source[key];
    return ordered;
}

function orderArray(schema: object, source: readonly unknown[]): readonly unknown[] {
    let ordered: unknown[] | undefined;
    for (let index = 0; index < source.length; index++) {
        const value = orderValue(schema, source[index]);
        if (value !== source[index]) (ordered ??= source.slice())[index] = value;
    }
    return ordered ?? source;
}

/**
 * A producer-admitted value with its members in the order the schema's parse emitted them:
 * declared members in declaration order (through objects, arrays and optional/nullable
 * wrappers), then pass-through members in their own order. Values are carried as they are;
 * nothing is validated here: the producer that built the value is its validation point.
 */
export function orderAsDeclared<T extends object>(schema: object, value: T): T {
    return orderValue(schema, value) as T;
}

const admittedResponseSerializerCompiler: typeof serializerCompiler = route => {
    const validateAndSerialize = serializerCompiler(route);
    const declared = route.schema !== null && typeof route.schema === 'object'
        ? declaredResponseSchemas.get(route.schema) ?? route.schema : route.schema;
    return data => data !== null && typeof data === 'object' && admittedResponses.get(data) === declared
        ? JSON.stringify(data)
        : validateAndSerialize(data);
};
