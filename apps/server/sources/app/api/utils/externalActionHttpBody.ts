import type { Fastify } from '../types';
import {
    decodeExternalActionHttpBodyV1,
    EXTERNAL_ACTION_HTTP_BODY_HEADER_V1,
    EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1,
    EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

/** Restore the logical signed request before its existing schema and authentication. */
export function enableExternalActionHttpBody(app: Fastify): void {
    // Constrained aliases keep signed reads in their original route scope while
    // allowing ordinary POST routes at the same URL to retain their semantics.
    app.addConstraintStrategy({
        name: 'externalActionRead',
        mustMatchWhenDerived: true,
        storage() {
            type Storage = ReturnType<Parameters<typeof app.addConstraintStrategy>[0]['storage']>;
            const handlers = new Map<unknown, Parameters<Storage['set']>[1]>();
            return {
                get: value => handlers.get(value) ?? null,
                set: (value, handler) => { handlers.set(value, handler); },
            };
        },
        deriveConstraint(request) {
            return request.method === 'POST'
                && request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1
                ? 'v1'
                : undefined;
        },
    });
    app.addHook('onRoute', function (route) {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        if (!methods.includes('GET')) return;
        this.route({
            ...route,
            method: 'POST',
            url: route.url.slice(this.prefix.length) || '/',
            constraints: { ...route.constraints, externalActionRead: 'v1' },
            schema: { ...route.schema, hide: true },
        });
    });

    app.addHook('preValidation', async (request, reply) => {
        const marker = request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1];
        if (marker === undefined) return;
        const isRead = marker === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1;
        if ((marker !== 'v1' && !isRead)
            || (isRead && request.method !== 'POST')
            || EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1.some(header => request.headers[header] !== undefined)) {
            return reply.serializer(JSON.stringify).code(400).send({ error: 'invalid_request' });
        }
        const decoded = decodeExternalActionHttpBodyV1(request.body);
        if (decoded === null || (isRead && decoded.body !== undefined)) {
            return reply.serializer(JSON.stringify).code(400).send({ error: 'invalid_request' });
        }
        if (isRead) request.raw.method = 'GET';
        Object.assign(request.headers, decoded.headers);
        request.body = decoded.body;
    });
}
