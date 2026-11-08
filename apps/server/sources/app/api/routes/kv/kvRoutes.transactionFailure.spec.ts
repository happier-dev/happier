import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol/account/authoringMemory';
import { createRouteTestBuilder } from '@/app/api/testkit/routeTestBuilder';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { TransactionDeadlineExceededError } from '@/storage/transactionErrors';
import { captureAccountStoredContentCompatibilityForHttpRequest } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));

// Only the database boundary fails; transaction classification and route projection stay real.
vi.mock('@/storage/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: { $transaction: database.transaction },
}));

import { kvRoutes } from './kvRoutes';
import { registerAuthoringMemoryRoutes } from '../account/registerAuthoringMemoryRoutes';
import { registerPluginAccountStorageRoutes } from '../account/registerPluginAccountStorageRoutes';
import { registerPluginAccountSettingsRoutes } from '../account/registerPluginAccountSettingsRoutes';

const routes = [
    { method: 'POST', path: '/v1/kv', register: kvRoutes,
        body: { mutations: [{ key: 'example', value: null, version: 0 }] },
        unavailable: { error: 'transaction-unavailable', retryAfterMs: 1_000 },
        internal: { error: 'Failed to mutate values' } },
    ...(['GET', 'POST'] as const).map(method => ({
        method, path: '/v1/account/plugin-storage/:pluginId', register: registerPluginAccountStorageRoutes,
        unavailable: { error: 'plugin_account_storage_unavailable' }, internal: { error: 'internal' },
    })),
    ...(['GET', 'POST'] as const).map(method => ({
        method, path: '/v1/account/plugin-settings/:pluginId', register: registerPluginAccountSettingsRoutes,
        unavailable: { error: 'plugin_account_settings_storage_unavailable' }, internal: { error: 'internal' },
    })),
    ...(['GET', 'POST'] as const).map(method => ({
        method, path: `${AUTHORING_MEMORY_ROUTE_V1}/:key`, register: registerAuthoringMemoryRoutes,
        unavailable: { error: 'authoring_memory_storage_unavailable' }, internal: { error: 'internal' },
    })),
    { method: 'GET', path: AUTHORING_MEMORY_ROUTE_V1, register: registerAuthoringMemoryRoutes,
        unavailable: { error: 'authoring_memory_storage_unavailable' }, internal: { error: 'internal' } },
] satisfies ReadonlyArray<{
    method: 'GET' | 'POST'; path: string; register: typeof kvRoutes;
    body?: object; unavailable: object; internal: object;
}>;

describe.each(routes)('$method $path transaction recovery', (route) => {
    afterEach(() => { vi.unstubAllEnvs(); database.transaction.mockReset(); });

    it.each([
        { failure: new TransactionDeadlineExceededError(null, 'kv'), status: 503 },
        { failure: Object.assign(new Error('Transaction rolled back'), { code: 'P2034' }), status: 503 },
        { failure: new Error('Private driver query and input'), status: 500 },
    ])('preserves the storage outcome ($status)', async ({ failure, status }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        database.transaction.mockRejectedValue(failure);
        if (route.path === '/v1/kv' && 'body' in route) {
            const app = createAuthenticatedTestApp();
            kvRoutes(app);
            try {
                const response = await app.inject({
                    method: 'POST', url: '/v1/kv', payload: route.body,
                    headers: { ...currentAccountStoredContentCompatibilityHeaders, 'x-test-user-id': 'account' },
                });
                expect(response.statusCode).toBe(status);
                expect(response.json()).toEqual(status === 503 ? route.unavailable : route.internal);
                if (status === 503) expect(response.headers['retry-after']).toBe('1');
                expect(database.transaction).toHaveBeenCalledTimes(1);
            } finally {
                await app.close();
            }
            return;
        }
        const builder = createRouteTestBuilder({
            method: route.method, path: route.path,
            registerRoutes(app) { route.register(app as unknown as Parameters<typeof kvRoutes>[0]); },
        });
        const request = builder.createAuthenticatedRequest({
            userId: 'account', headers: currentAccountStoredContentCompatibilityHeaders,
            params: { pluginId: 'example', key: 'example' },
            body: 'body' in route ? route.body : {},
        });
        captureAccountStoredContentCompatibilityForHttpRequest(request as unknown as Parameters<typeof captureAccountStoredContentCompatibilityForHttpRequest>[0]);
        const reply = builder.createReply();
        const response = await builder.handler(request, reply);
        expect(reply.statusCode).toBe(status);
        expect(response).toEqual(status === 503 ? route.unavailable : route.internal);
        // The request consumes the transaction owner's outcome without starting another attempt.
        expect(database.transaction).toHaveBeenCalledTimes(1);
    });
});
