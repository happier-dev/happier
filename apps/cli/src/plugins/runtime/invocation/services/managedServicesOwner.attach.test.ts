import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';
import type { ManagedServiceHandle, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

import {
    createUnavailableManagedServices,
    type ManagedProviderEndpointAccessProjection,
    type ManagedProviderRuntimeInvocationBinding,
} from './managedServicesAdapter';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createManagedServicesOwner } from './managedServicesOwner';
import { createUnavailablePluginServices } from './unavailable';

describe('managed Provider attached endpoint lifetime', () => {
    it('keeps retired access unavailable when a fresh attachment uses the same URL and null start time', async () => {
        const requests: string[] = [];
        const unexpectedRequests: string[] = [];
        const server = createServer((request, response) => {
            const route = `${request.method} ${request.url}`;
            requests.push(route);
            if (route === 'GET /health') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ ready: true }));
            } else if (route === 'GET /v1/models') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ models: [] }));
            } else {
                unexpectedRequests.push(route);
                response.writeHead(500).end();
            }
        });
        const lifetime = new AbortController();
        // These are caller-lifetime inputs to the SVC09 owner, not evidence of
        // plugin admission, Account authorization or Provider purpose custody.
        const isCurrent = () => !lifetime.signal.aborted;
        const owner = createManagedServicesOwner({
            processSupervisorHost: createManagedServiceProcessSupervisorHost({
                custodyOwner: 'daemon',
            }),
            // Attach has no executable or dependency authority. Use the real
            // fail-closed owners rather than supplying fake service methods.
            dependencies: createUnavailableManagedServices().dependencies,
            resolveScope: (seed) => seed,
        });
        let originalProjection: ManagedProviderEndpointAccessProjection | null = null;
        let freshProjection: ManagedProviderEndpointAccessProjection | null = null;
        let original: ManagedServiceHandle | undefined;
        let fresh: ManagedServiceHandle | undefined;
        let mainFailure: unknown;
        let hasMainFailure = false;
        const cleanupFailures: unknown[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    server.removeListener('error', reject);
                    resolve();
                });
            });
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Expected the owned loopback HTTP listener');
            }
            const baseUrl = `http://127.0.0.1:${address.port}`;
            const binding = {
                realm: 'managedProviderStart',
                providerLocalId: 'gateway',
                isCurrent,
            } satisfies ManagedProviderRuntimeInvocationBinding;
            const services = owner.bindScope({
                occurrenceId: 'attached-endpoint-occurrence',
                pluginId: 'acme.attach',
                contributionQualifiedId: 'acme.attach/providers/gateway',
                operationId: 'attached-endpoint-operation',
                signal: lifetime.signal,
                isOccurrenceCurrent: isCurrent,
            }, createUnavailablePluginServices().exec, { managedProvider: binding });
            const spec = {
                id: 'gateway',
                mode: { kind: 'attach', baseUrl },
                clientAccess: { kind: 'none' },
                healthCheck: {
                    kind: 'http',
                    target: { kind: 'servicePath', path: '/health' },
                },
            } satisfies ManagedServiceSpec;
            original = await services.supervise(spec);
            await original.waitUntilHealthy();
            expect(original.snapshot()).toMatchObject({
                state: 'healthy', mode: 'attach', baseUrl, startedAtMs: null,
            });
            const project = owner.projectManagedProviderEndpointAccess;
            if (!project) throw new Error('Expected the canonical endpoint projection owner');
            originalProjection = await project({
                service: original,
                endpoints: [{ endpointTemplateId: 'models', servicePath: '/v1' }],
                signal: lifetime.signal,
                isCurrent,
            });
            expect(originalProjection).not.toBeNull();
            if (!originalProjection) throw new Error('Expected healthy attached endpoint access');
            expect(originalProjection.access.endpointUrl('models')).toBe(`${baseUrl}/v1`);
            const originalResponse = await originalProjection.access.request({ pathAndQuery: '/v1/models' });
            expect(originalResponse.status).toBe(200);
            expect(await new Response(originalResponse.body).json()).toEqual({ models: [] });

            await expect(original.stop()).resolves.toEqual({ status: 'detached' });
            expect(original.snapshot().state).toBe('stopped');
            fresh = await services.supervise(spec);
            expect(fresh).not.toBe(original);
            await fresh.waitUntilHealthy();
            expect(fresh.snapshot()).toMatchObject({
                state: 'healthy', mode: 'attach', baseUrl, startedAtMs: null,
            });
            freshProjection = await project({
                service: fresh,
                endpoints: [{ endpointTemplateId: 'models', servicePath: '/v1' }],
                signal: lifetime.signal,
                isCurrent,
            });
            expect(freshProjection).not.toBeNull();
            if (!freshProjection) throw new Error('Expected fresh attached endpoint access');
            expect(freshProjection.isCurrent()).toBe(true);
            const freshResponse = await freshProjection.access.request({ pathAndQuery: '/v1/models' });
            expect(freshResponse.status).toBe(200);
            expect(await new Response(freshResponse.body).json()).toEqual({ models: [] });

            // The caller and URL are still current. Only the exact old handle
            // retired, so neither a URL lookup nor a nullable timestamp may
            // let that old projection borrow the new attachment's authority.
            expect(isCurrent()).toBe(true);
            expect(originalProjection.isCurrent()).toBe(false);
            expect(originalProjection.access.endpointUrl('models')).toBeNull();
            // Readiness polls belong to the supervisor, not this endpoint
            // request. Observe the domain request so a healthy watchdog does
            // not masquerade as egress from the retired projection.
            const requestsBeforeRefusal = requests.filter((route) => route === 'GET /v1/models').length;
            await expect(originalProjection.access.request({ pathAndQuery: '/v1/models' }))
                .rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
            expect(requests.filter((route) => route === 'GET /v1/models')).toHaveLength(requestsBeforeRefusal);
            expect(requests.filter((route) => route === 'GET /v1/models')).toHaveLength(2);
        } catch (error) {
            hasMainFailure = true;
            mainFailure = error;
        } finally {
            const outcomes = await Promise.allSettled([
                Promise.resolve().then(() => originalProjection?.cleanup()),
                Promise.resolve().then(() => freshProjection?.cleanup()),
                owner.dispose(),
            ]);
            for (const outcome of outcomes) {
                if (outcome.status === 'rejected') cleanupFailures.push(outcome.reason);
            }
            lifetime.abort();
            server.closeAllConnections();
            if (server.listening) {
                try {
                    await new Promise<void>((resolve, reject) => {
                        server.close((error) => error ? reject(error) : resolve());
                    });
                } catch (error) {
                    cleanupFailures.push(error);
                }
            }
        }
        // Report strict HTTP boundary failures only after the owned supervisor
        // and listener are closed, without replacing an earlier main failure.
        const failures = [
            ...(hasMainFailure ? [mainFailure] : []),
            ...cleanupFailures,
            ...(unexpectedRequests.length > 0
                ? [new Error(`Unexpected attached HTTP routes: ${unexpectedRequests.join(', ')}`)]
                : []),
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, 'Attached endpoint keeper and boundary cleanup failed',
                hasMainFailure ? { cause: mainFailure } : undefined);
        }
        expect(unexpectedRequests).toEqual([]);
        expect(server.listening).toBe(false);
        expect(original?.snapshot().state).toBe('stopped');
        expect(fresh?.snapshot().state).toBe('stopped');
        expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
    });
});
