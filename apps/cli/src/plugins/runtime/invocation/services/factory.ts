import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';

import type {
    CreatePluginInvocationServices,
    PluginFileSystemRoots,
    PluginInvocationServiceBinding,
} from './types';
import {
    createPluginInvocationServicesFromDescriptors,
    createPluginInvocationServiceBinding,
    createUnavailablePluginServices,
    type PluginInvocationServicesFactoryParams,
    PLUGIN_SERVICE_IDS,
    withPluginInvocationServiceBindingAvailability,
} from './unavailable';

export function createLoggerAndFilesystemServiceBinding(
    generation: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: import('@happier-dev/protocol').PluginHostAccessRequestV2 }>[]=[],
    filesystemRoots: PluginFileSystemRoots,
): PluginInvocationServiceBinding {
    const requests: Extract<PluginHostAccessRequestV2, { capability: 'filesystem' }>[] = [];
    for (const { request } of hostAccessRequests) {
        if (
            request.capability === 'filesystem'
            && request.scope.locations.every((location) => (
                location.root !== 'project'
                || (location.projectId !== undefined && filesystemRoots.projects.has(location.projectId))
            ))
        ) requests.push(request);
    }
    const scopes = requests.flatMap((request) => request.scope.locations.map((location) => Object.freeze({
        ...location,
        access: Object.freeze([...request.scope.access]),
    })));
    const binding = withPluginInvocationServiceBindingAvailability(
        createPluginInvocationServiceBinding(generation, id),
        { serviceId: 'logger', availability: 'available' },
        ...(scopes.length > 0
            ? [{ serviceId: 'fs' as const, availability: 'available' as const }]
            : []),
    );
    return Object.freeze({
        ...binding,
        ...(scopes.length > 0 ? { filesystemScopes: Object.freeze(scopes) } : {}),
        ...(requests.length > 0 ? { filesystemRequestIds: Object.freeze(requests.map((request) => request.id)) } : {}),
    });
}

export function createUnavailablePluginInvocationServiceBinding(
    generation: string,
    id: string,
): PluginInvocationServiceBinding {
    return createPluginInvocationServiceBinding(generation, id);
}

export function createLoggerAvailablePluginInvocationServiceBinding(
    generation: string,
    id: string,
): PluginInvocationServiceBinding {
    return withPluginInvocationServiceBindingAvailability(
        createPluginInvocationServiceBinding(generation, id),
        { serviceId: 'logger', availability: 'available' },
    );
}

export function createLoggerAndEventsAvailablePluginInvocationServiceBinding(
    generation: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
): PluginInvocationServiceBinding {
    const binding = createLoggerAvailablePluginInvocationServiceBinding(generation, id);
    return addNetworkFetchServiceBinding(addSecretsServiceBinding(
        withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'events', availability: 'available' },
        ),
        hostAccessRequests,
    ), hostAccessRequests);
}

function addNetworkFetchServiceBinding(
    binding: PluginInvocationServiceBinding,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[],
): PluginInvocationServiceBinding {
    const requests = hostAccessRequests.flatMap(({ request }) => (
        request.capability === 'network'
        && request.scope.targets.some((target) => (
            target.kind === 'fixedOrigin'
            || target.kind === 'connectedAccountOrigin'
        ))
            ? [request]
            : []
    ));
    if (requests.length === 0) return binding;
    const origins = new Set(requests.flatMap((request) => request.scope.targets.flatMap((target) => (
        target.kind === 'fixedOrigin' ? [target.origin] : []
    ))));
    const scopes = requests.map((request) => Object.freeze({
        accessId: request.id,
        required: hostAccessRequests.find((candidate) => candidate.request === request)?.required ?? true,
        origins: Object.freeze(request.scope.targets.flatMap((target) => (
            target.kind === 'fixedOrigin' ? [target.origin] : []
        ))),
        ...(request.scope.methods === undefined ? {} : { methods: Object.freeze([...request.scope.methods]) }),
        privateNetwork: request.scope.privateNetwork === true,
    }));
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'fetch', availability: 'available' },
        ),
        networkOrigins: Object.freeze([...origins].sort()),
        networkRequestIds: Object.freeze(requests.map((request) => request.id)),
        networkScopes: Object.freeze(scopes),
    });
}

export function addMcpAvailablePluginInvocationServiceBinding(
    binding: PluginInvocationServiceBinding,
): PluginInvocationServiceBinding {
    return withPluginInvocationServiceBindingAvailability(
        binding,
        { serviceId: 'mcp', availability: 'available' },
    );
}

export function addConnectedAccountsAvailablePluginInvocationServiceBinding(
    binding: PluginInvocationServiceBinding,
): PluginInvocationServiceBinding {
    return withPluginInvocationServiceBindingAvailability(
        binding,
        { serviceId: 'connectedAccounts', availability: 'available' },
    );
}

export function createLoggerFilesystemAndEventsServiceBinding(
    generation: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    filesystemRoots: PluginFileSystemRoots,
): PluginInvocationServiceBinding {
    const binding = createLoggerAndFilesystemServiceBinding(generation, id, hostAccessRequests, filesystemRoots);
    return addNetworkFetchServiceBinding(addSecretsServiceBinding(
        withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'events', availability: 'available' },
        ),
        hostAccessRequests,
    ), hostAccessRequests);
}

function addSecretsServiceBinding(
    binding: PluginInvocationServiceBinding,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[],
): PluginInvocationServiceBinding {
    const scopes = hostAccessRequests.flatMap(({ request, required }) => request.capability === 'secrets'
        ? [Object.freeze({
            accessId: request.id,
            required,
            secretIds: Object.freeze([...request.scope.secretIds]),
            access: Object.freeze([...request.scope.access]),
        })]
        : []);
    if (scopes.length === 0) return binding;
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'secrets', availability: 'available' },
        ),
        secretScopes: Object.freeze(scopes),
    });
}

function addExecServiceBinding(
    binding: PluginInvocationServiceBinding,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[],
    managedAvailable = false,
): PluginInvocationServiceBinding {
    const requests = hostAccessRequests
        .map(({ request }) => request)
        .filter((request): request is Extract<PluginHostAccessRequestV2, { capability: 'process' }> => request.capability === 'process');
    const executableByKey = new Map<string, (typeof requests)[number]['scope']['executables'][number]>();
    const envKeys = new Set<string>();
    for (const request of requests) {
        for (const executable of request.scope.executables) executableByKey.set(JSON.stringify(executable), executable);
        for (const key of request.scope.envKeys ?? []) envKeys.add(key);
    }
    if (executableByKey.size === 0) return binding;
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'exec', availability: 'available' },
            ...(managedAvailable
                ? [{ serviceId: 'managed' as const, availability: 'available' as const }]
                : []),
        ),
        processExecutables: Object.freeze([...executableByKey.values()]),
        processEnvKeys: Object.freeze([...envKeys]),
        processRequestIds: Object.freeze(requests.map((request) => request.id)),
    });
}

export function createLoggerFilesystemEventsAndExecServiceBinding(
    generation: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    filesystemRoots: PluginFileSystemRoots,
    managedAvailable = false,
): PluginInvocationServiceBinding {
    const binding = createLoggerFilesystemAndEventsServiceBinding(
        generation,
        id,
        hostAccessRequests,
        filesystemRoots,
    );
    return addExecServiceBinding(binding, hostAccessRequests, managedAvailable);
}

export function createLoggerEventsAndExecServiceBinding(
    generation: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    managedAvailable = false,
): PluginInvocationServiceBinding {
    const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(generation, id, hostAccessRequests);
    return addExecServiceBinding(binding, hostAccessRequests, managedAvailable);
}

export function createUnavailablePluginServicesFactory(): CreatePluginInvocationServices {
    return (seed, binding) => {
        if (binding.generation !== seed.generation) {
            throw new Error('Plugin invocation service binding generation does not match the invocation context');
        }
        if (PLUGIN_SERVICE_IDS.some((serviceId) => binding.availability[serviceId] !== 'unavailable')) {
            throw new Error('Plugin invocation service binding availability does not match the unavailable services factory');
        }
        return createUnavailablePluginServices();
    };
}

export function createPluginInvocationServicesFactory(
    params: PluginInvocationServicesFactoryParams,
): CreatePluginInvocationServices {
    return (seed, binding) => createPluginInvocationServicesFromDescriptors(seed, binding, params);
}
