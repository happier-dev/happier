import { describe, expect, it, vi } from 'vitest';

import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

import { createManagedServicesInvocationAdapter } from './managedServicesAdapter';
import { createStablePluginEventsBroker } from './events';
import {
    createPluginInvocationServicesFactory,
    createLoggerAndEventsAvailablePluginInvocationServiceBinding,
} from './factory';
import { withPluginInvocationServiceBindingAvailability } from './unavailable';

const seed = Object.freeze({
    plugin: Object.freeze({ id: 'acme.providers', version: '1.0.0' }),
    contribution: Object.freeze({ id: 'gateway', qualifiedId: 'acme.providers:providers:gateway' }),
    generation: 'generation-1',
    correlationId: 'correlation-1',
    surface: 'background' as const,
    signal: new AbortController().signal,
    isGenerationCurrent: () => true,
});

describe('managed-services invocation adapter', () => {
    it('delegates construction to the injected canonical owner', () => {
        const service = Object.freeze({
            dependencies: Object.freeze({
                status: vi.fn(), ensure: vi.fn(), update: vi.fn(), remove: vi.fn(),
            }),
            supervise: vi.fn(),
        }) satisfies PluginServices['managedServices'];
        const bind = vi.fn(() => service);

        const adapter = createManagedServicesInvocationAdapter({
            isAvailable: () => true,
            bind,
        });

        expect(adapter.bind(seed)).toBe(service);
        expect(bind).toHaveBeenCalledWith(seed);
        expect(adapter.isAvailable({
            generation: seed.generation,
            contributionQualifiedId: seed.contribution.qualifiedId,
        })).toBe(true);
    });

    it('fails closed with the stable unavailable code when no owner is bound', async () => {
        const service = createManagedServicesInvocationAdapter().bind(seed);
        expect(createManagedServicesInvocationAdapter().isAvailable({
            generation: seed.generation,
            contributionQualifiedId: seed.contribution.qualifiedId,
        })).toBe(false);

        await expect(service.supervise({
            id: 'test-service',
            mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4321' },
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        await expect(service.dependencies.status('tool')).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
    });

    it('assembles only the service and declared-secret port supplied by an admitted canonical owner', () => {
        const service = createManagedServicesInvocationAdapter().bind(seed);
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn(),
            requestSelection: vi.fn(),
            materialize: vi.fn(),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn(),
        }) satisfies ConnectedAccountsService;
        const credentialFiles = Object.freeze({
            materialize: vi.fn(),
        });
        const declaredSecretReadPort = vi.fn(async () => null);
        const owner = {
            isAvailable: () => true,
            bind: vi.fn(() => service),
            bindWithExec: vi.fn(() => service),
        };
        const createServices = createPluginInvocationServicesFactory({
            loggerSink: { write() {} },
            events: {
                broker: createStablePluginEventsBroker(),
                declarationsByPluginId: new Map(),
                activePluginIds: new Set(),
            },
            managedServices: owner,
            managedServiceCredentialFiles: credentialFiles,
            managedServiceDeclaredSecretReadPort: Object.freeze({
                bind: () => declaredSecretReadPort,
            }),
            connectedAccounts: Object.freeze({
                bind: vi.fn(() => connectedAccounts),
                retire: vi.fn(),
            }),
        });
        const binding = withPluginInvocationServiceBindingAvailability(
            Object.freeze({
                ...createLoggerAndEventsAvailablePluginInvocationServiceBinding(
                    seed.generation,
                    'binding-1',
                ),
                connectedAccountScopes: Object.freeze([]),
            }),
            { serviceId: 'managedServices', availability: 'available' },
            { serviceId: 'connectedAccounts', availability: 'available' },
        );

        const services = createServices(seed, binding);
        expect(services.managedServices).toBe(service);
        expect(services.connectedAccounts).toBe(connectedAccounts);
        expect(owner.bindWithExec).toHaveBeenCalledWith(
            seed,
            expect.any(Object),
            {
                connectedAccounts,
                credentialFiles,
                declaredSecretReadPort,
                managedProvider: null,
                requestAuth: null,
            },
        );
        expect(owner.bind).not.toHaveBeenCalled();
    });
});
