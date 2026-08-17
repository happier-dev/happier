import { describe, expect, it, vi } from 'vitest';

import {
    createPluginWebhookAdministrationHttpClient,
    createPluginWebhookEndpointHttpActionExecutor,
} from './endpointActions';

describe('plugin webhook endpoint HTTP Action executor', () => {
    it('uses the canonical present-user path and validates the strict response', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
            revision: 1,
            contribution: { pluginId: 'acme.github', localId: 'issues' },
            targetMaterialization: {
                machineId: 'machine-1',
                materializationId: 'materialization-1',
                pluginId: 'acme.github',
            },
            sourceInstanceId: 'source-1',
            routing: 'accountEndpoint',
            readiness: 'ready',
            publicUrl: 'https://server.example/v1/plugins/webhooks/opaque',
            createdAt: 1,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const execute = createPluginWebhookEndpointHttpActionExecutor({ request: request as never });

        const result = await execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        });

        expect(result).toMatchObject({ revision: 1, readiness: 'ready' });
        expect(request).toHaveBeenCalledWith(
            '/v1/plugins/webhooks/endpoints/read',
            expect.objectContaining({ method: 'POST' }),
            { includeAuth: true },
        );
    });

    it('rejects malformed success payloads instead of presenting partial endpoint state', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({ revision: 1 }), { status: 200 }));
        const execute = createPluginWebhookEndpointHttpActionExecutor({ request: request as never });

        await expect(execute('plugin.webhook.endpoint.read', {
            webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        })).rejects.toThrow();
    });
});

describe('plugin webhook Account administration HTTP client', () => {
    it('reads only the strict bounded status projection through the authenticated server client', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            endpoints: [{
                webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
                revision: 1,
                contribution: { pluginId: 'acme.github', localId: 'issues' },
                targetMaterialization: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                    pluginId: 'acme.github',
                },
                sourceInstanceId: 'source-1',
                routing: 'accountEndpoint',
                readiness: 'ready',
                targetStatus: 'current',
                publicUrl: 'https://server.example/v1/plugins/webhooks/opaque',
                createdAt: 1,
                queue: { queued: 1, retrying: 0, claimed: 0, deadLetter: 0, oldestPendingAtMs: 1 },
            }],
            nextEndpointCursor: null,
            deadLetters: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const client = createPluginWebhookAdministrationHttpClient({ request: request as never });

        await expect(client.readStatus({ pageSize: 50, deadLetterPageSize: 50 }))
            .resolves.toMatchObject({ endpoints: [{ readiness: 'ready' }] });
        expect(request).toHaveBeenCalledWith(
            '/v1/plugins/webhooks/status/read',
            expect.objectContaining({ method: 'POST' }),
            { includeAuth: true },
        );
    });

    it('rejects status responses that leak a raw delivery payload', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({
            endpoints: [],
            nextEndpointCursor: null,
            deadLetters: [],
            rawBody: '{}',
        }), { status: 200 }));
        const client = createPluginWebhookAdministrationHttpClient({ request: request as never });

        await expect(client.readStatus({ pageSize: 50, deadLetterPageSize: 50 })).rejects.toThrow();
    });
});
