import { AsyncLocalStorage } from 'node:async_hooks';

import type { HostingProviderRuntimeServices } from './hostingProvider.js';

const SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY = Symbol.for(
    'happier.pluginSdk.scm.hostingProviderRuntimeServicesStorage',
);

function resolveScmHostingProviderRuntimeServicesStorage(): AsyncLocalStorage<HostingProviderRuntimeServices> {
    const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;
    const existing = globalScope[SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY];
    if (existing instanceof AsyncLocalStorage) {
        return existing as AsyncLocalStorage<HostingProviderRuntimeServices>;
    }

    const storage = new AsyncLocalStorage<HostingProviderRuntimeServices>();
    globalScope[SCM_HOSTING_PROVIDER_RUNTIME_SERVICES_STORAGE_KEY] = storage;
    return storage;
}

const scmHostingProviderRuntimeServicesStorage = resolveScmHostingProviderRuntimeServicesStorage();
const scmHostingProviderOperationSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function runWithHostingProviderRuntimeServices<T>(
    services: HostingProviderRuntimeServices,
    callback: () => T,
    options?: Readonly<{ signal?: AbortSignal }>,
): T {
    return scmHostingProviderRuntimeServicesStorage.run(services, () => (
        options?.signal
            ? scmHostingProviderOperationSignalStorage.run(options.signal, callback)
            : callback()
    ));
}

export function readCurrentHostingProviderRuntimeServices(): HostingProviderRuntimeServices | null {
    const services = scmHostingProviderRuntimeServicesStorage.getStore() ?? null;
    const signal = scmHostingProviderOperationSignalStorage.getStore();
    if (!services || !signal) return services;
    return Object.freeze({
        ...services,
        ...(services.resolveScmHostingTokenMaterialization ? {
            resolveScmHostingTokenMaterialization: (
                input: Parameters<NonNullable<HostingProviderRuntimeServices['resolveScmHostingTokenMaterialization']>>[0],
                options?: Parameters<NonNullable<HostingProviderRuntimeServices['resolveScmHostingTokenMaterialization']>>[1],
            ) => services.resolveScmHostingTokenMaterialization!(
                input,
                options ?? { signal },
            ),
        } : {}),
        ...(services.resolveScmHostingBasicAuthMaterialization ? {
            resolveScmHostingBasicAuthMaterialization: (
                input: Parameters<NonNullable<HostingProviderRuntimeServices['resolveScmHostingBasicAuthMaterialization']>>[0],
                options?: Parameters<NonNullable<HostingProviderRuntimeServices['resolveScmHostingBasicAuthMaterialization']>>[1],
            ) => services.resolveScmHostingBasicAuthMaterialization!(
                input,
                options ?? { signal },
            ),
        } : {}),
        ...(services.executeCommand ? {
            executeCommand: (
                input: Parameters<NonNullable<HostingProviderRuntimeServices['executeCommand']>>[0],
                options?: Parameters<NonNullable<HostingProviderRuntimeServices['executeCommand']>>[1],
            ) => services.executeCommand!(input, options ?? { signal }),
        } : {}),
    });
}
