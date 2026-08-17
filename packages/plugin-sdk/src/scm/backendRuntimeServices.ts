import { AsyncLocalStorage } from 'node:async_hooks';

import type { BackendRuntimeServices } from './backend.js';

const SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY = Symbol.for(
    'happier.pluginSdk.scm.backendRuntimeServicesStorage',
);

function resolveScmBackendRuntimeServicesStorage(): AsyncLocalStorage<BackendRuntimeServices> {
    const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;
    const existing = globalScope[SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY];
    if (existing instanceof AsyncLocalStorage) {
        return existing as AsyncLocalStorage<BackendRuntimeServices>;
    }

    const storage = new AsyncLocalStorage<BackendRuntimeServices>();
    globalScope[SCM_BACKEND_RUNTIME_SERVICES_STORAGE_KEY] = storage;
    return storage;
}

const scmBackendRuntimeServicesStorage = resolveScmBackendRuntimeServicesStorage();

export function runWithBackendRuntimeServices<T>(
    services: BackendRuntimeServices,
    callback: () => T,
): T {
    return scmBackendRuntimeServicesStorage.run(services, callback);
}

export function readCurrentBackendRuntimeServices(): BackendRuntimeServices | null {
    return scmBackendRuntimeServicesStorage.getStore() ?? null;
}
