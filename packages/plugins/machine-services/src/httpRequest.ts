import { PluginError, SharedSavedSecretReferenceSelectionV1Schema, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
    defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const satisfies readonly HttpMethod[];
const [firstMethod, secondMethod, ...remainingMethods] = methods;

export const httpRequestInput = defineProtocolObject({
    destination: defineProtocolString({ pattern: '^https?://' }),
    method: defineProtocolUnion([
        defineProtocolLiteral(firstMethod), defineProtocolLiteral(secondMethod),
        ...remainingMethods.map(method => defineProtocolLiteral(method)),
    ]),
    headers: defineProtocolArray(defineProtocolObject({ name: defineProtocolString({ minLength: 1 }),
        secret: SharedSavedSecretReferenceSelectionV1Schema }, { policy: 'closed' })).optional(),
    body: defineProtocolString().optional(),
}, { policy: 'closed' });

export const httpRequestResult = defineProtocolObject({
    statusCode: defineProtocolNumber({ integer: true }),
    bodyExcerpt: defineProtocolString(),
    durationMs: defineProtocolNumber({ minimum: 0 }),
}, { policy: 'closed' });

/** Workflow Action leaves and direct callers share the same finite SDK request. */
export const httpRequestActions = {
    'http/request': {
        title: 'Send an HTTP request',
        description: 'Send to the explicit destination using Saved Secrets for header values. Returns status, the HTTP-service-bounded response text and elapsed milliseconds; non-2xx responses fail. Redirects are not followed.',
        execution: { target: 'daemon' as const }, scopes: ['global', 'machine'] as const,
        surfaces: ['ui', 'cli', 'agent', 'mcp', 'plugin'] as const, dangerLevel: 'writesRemote' as const,
        confirmation: { title: 'Send this HTTP request?', body: 'Send the request body and selected Saved Secret header values to the destination URL.' },
        inputSchema: httpRequestInput, resultSchema: httpRequestResult,
        inputHints: { fields: [
            { path: 'destination', title: 'Destination URL', widget: 'text' as const, required: true },
            { path: 'method', title: 'HTTP method', widget: 'select' as const, required: true,
                options: methods.map(method => ({ value: method, label: method })) },
            { path: 'headers', title: 'Saved Secret headers', widget: 'json' as const,
                description: 'Header entries contain name and secret: { ref, resourceRevision }. Use exact Saved Secret references and revisions.' },
            { path: 'body', title: 'Request body', widget: 'textarea' as const },
        ] },
        async run(input: unknown, context: PluginInvocationContext) {
            const draft = httpRequestInput.parse(input);
            const headers: Record<string, string> = Object.create(null);
            for (const header of draft.headers ?? []) {
                headers[header.name] = await context.services.secrets.readSavedSecret(header.secret.ref,
                    { resourceRevision: header.secret.resourceRevision, signal: context.signal });
            }
            const startedAt = performance.now();
            // No local budget: the HTTP service bounds the body and the invoking
            // Action/Workflow lifetime owns cancellation and timeout.
            const response = await context.services.http.request({ url: draft.destination, method: draft.method satisfies HttpMethod,
                headers, redirect: 'manual',
                ...(draft.body === undefined ? {} : { body: new TextEncoder().encode(draft.body) }),
            }, { signal: context.signal });
            const result = { statusCode: response.status, bodyExcerpt: new TextDecoder().decode(response.body),
                durationMs: performance.now() - startedAt };
            if (response.status < 200 || response.status >= 300) {
                throw new PluginError({ code: 'http_response_failed', message: 'The destination returned a non-success HTTP status.',
                    retryable: false, details: result });
            }
            return result;
        },
    },
};
