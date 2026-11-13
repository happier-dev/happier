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

const admittedResponseSerializerCompiler: typeof serializerCompiler = route => {
    const validateAndSerialize = serializerCompiler(route);
    const declared = route.schema !== null && typeof route.schema === 'object'
        ? declaredResponseSchemas.get(route.schema) ?? route.schema : route.schema;
    return data => data !== null && typeof data === 'object' && admittedResponses.get(data) === declared
        ? JSON.stringify(data)
        : validateAndSerialize(data);
};
