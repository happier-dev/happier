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
    occurrenceId: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: import('@happier-dev/protocol').PluginHostAccessRequestV2 }>[]=[],
    filesystemRoots: PluginFileSystemRoots,
): PluginInvocationServiceBinding {
    const requests: Extract<PluginHostAccessRequestV2, { capability: 'filesystem' }>[] = [];
    for (const { request } of hostAccessRequests) {
        if (
            request.capability === 'filesystem'
            && request.scope.locations.some((location) => (
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
        createPluginInvocationServiceBinding(occurrenceId, id),
        { serviceId: 'logger', availability: 'available' },
        { serviceId: 'fs', availability: 'available' },
    );
    return Object.freeze({
        ...binding,
        filesystemScopes: Object.freeze(scopes),
        ...(requests.length > 0 ? { filesystemRequestIds: Object.freeze(requests.map((request) => request.id)) } : {}),
    });
}

export function createUnavailablePluginInvocationServiceBinding(
    occurrenceId: string,
    id: string,
): PluginInvocationServiceBinding {
    return createPluginInvocationServiceBinding(occurrenceId, id);
}

export function createLoggerAvailablePluginInvocationServiceBinding(
    occurrenceId: string,
    id: string,
): PluginInvocationServiceBinding {
    return withPluginInvocationServiceBindingAvailability(
        createPluginInvocationServiceBinding(occurrenceId, id),
        { serviceId: 'logger', availability: 'available' },
    );
}

export function createLoggerAndEventsAvailablePluginInvocationServiceBinding(
    occurrenceId: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
): PluginInvocationServiceBinding {
    const binding = createLoggerAvailablePluginInvocationServiceBinding(occurrenceId, id);
    return addNetworkHttpServiceBinding(
        withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'events', availability: 'available' },
        ),
        hostAccessRequests,
    );
}

type PluginNetworkTarget = Extract<
    PluginHostAccessRequestV2,
    { capability: 'network' | 'network.client' }
>['scope']['targets'][number];

/**
 * The declared targets an ambient (cooperative-disclosure) binding can carry on
 * its own. A `connectedAccountOrigin` target still needs the Connected Account
 * owner to resolve a concrete origin, so it only makes the request eligible.
 */
function isAmbientlyBoundNetworkTarget(target: PluginNetworkTarget): boolean {
    return target.kind === 'fixedOrigin'
        || target.kind === 'httpsHostSuffix'
        || target.kind === 'connectedAccountOrigin';
}

function readTargetOrigins(targets: readonly PluginNetworkTarget[]): readonly string[] {
    return targets.flatMap((target) => (target.kind === 'fixedOrigin' ? [target.origin] : []));
}

function readTargetHostSuffixes(targets: readonly PluginNetworkTarget[]): readonly string[] {
    return targets.flatMap((target) => (target.kind === 'httpsHostSuffix' ? [target.hostSuffix] : []));
}

/** Keeps `hostSuffixes` absent rather than empty for grants that declare none. */
function withHostSuffixes(
    targets: readonly PluginNetworkTarget[],
): Readonly<{ hostSuffixes?: readonly string[] }> {
    const hostSuffixes = readTargetHostSuffixes(targets);
    return hostSuffixes.length === 0 ? {} : { hostSuffixes: Object.freeze(hostSuffixes) };
}

function addNetworkHttpServiceBinding(
    binding: PluginInvocationServiceBinding,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[],
): PluginInvocationServiceBinding {
    const networkRequests: Extract<PluginHostAccessRequestV2, { capability: 'network' }>[] = [];
    const networkClientRequests: Extract<PluginHostAccessRequestV2, { capability: 'network.client' }>[] = [];
    for (const { request } of hostAccessRequests) {
        if (
            request.capability === 'network'
            && request.scope.targets.some(isAmbientlyBoundNetworkTarget)
        ) networkRequests.push(request);
        if (
            request.capability === 'network.client'
            && request.scope.transports.includes('websocket')
            && request.scope.targets.some(isAmbientlyBoundNetworkTarget)
        ) networkClientRequests.push(request);
    }
    if (networkRequests.length === 0 && networkClientRequests.length === 0) return binding;
    const origins = new Set(networkRequests.flatMap((request) => readTargetOrigins(request.scope.targets)));
    const hostSuffixes = new Set(networkRequests.flatMap((request) => readTargetHostSuffixes(request.scope.targets)));
    const clientOrigins = new Set(networkClientRequests.flatMap((request) => readTargetOrigins(request.scope.targets)));
    const clientHostSuffixes = new Set(networkClientRequests.flatMap((request) => (
        readTargetHostSuffixes(request.scope.targets)
    )));
    const scopes = networkRequests.map((request) => Object.freeze({
        authority: 'disclosure' as const,
        accessId: request.id,
        required: hostAccessRequests.find((candidate) => candidate.request === request)?.required ?? true,
        origins: Object.freeze(readTargetOrigins(request.scope.targets)),
        ...(withHostSuffixes(request.scope.targets)),
        ...(request.scope.methods === undefined ? {} : { methods: Object.freeze([...request.scope.methods]) }),
        privateNetwork: request.scope.privateNetwork === true,
    }));
    const clientScopes = networkClientRequests.map((request) => Object.freeze({
        authority: 'disclosure' as const,
        accessId: request.id,
        required: hostAccessRequests.find((candidate) => candidate.request === request)?.required ?? true,
        origins: Object.freeze(readTargetOrigins(request.scope.targets)),
        ...(withHostSuffixes(request.scope.targets)),
        transports: Object.freeze(request.scope.transports.filter((transport) => transport === 'websocket')),
        privateNetwork: request.scope.privateNetwork === true,
    }));
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'http', availability: 'available' },
        ),
        ...(networkRequests.length === 0 ? {} : {
            networkOrigins: Object.freeze([...origins].sort()),
            ...(hostSuffixes.size === 0
                ? {}
                : { networkHostSuffixes: Object.freeze([...hostSuffixes].sort()) }),
            networkRequestIds: Object.freeze(networkRequests.map((request) => request.id)),
            networkScopes: Object.freeze(scopes),
        }),
        ...(networkClientRequests.length === 0 ? {} : {
            networkClientOrigins: Object.freeze([...clientOrigins].sort()),
            ...(clientHostSuffixes.size === 0
                ? {}
                : { networkClientHostSuffixes: Object.freeze([...clientHostSuffixes].sort()) }),
            networkClientRequestIds: Object.freeze(networkClientRequests.map((request) => request.id)),
            networkClientScopes: Object.freeze(clientScopes),
        }),
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
    occurrenceId: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    filesystemRoots: PluginFileSystemRoots,
): PluginInvocationServiceBinding {
    const binding = createLoggerAndFilesystemServiceBinding(occurrenceId, id, hostAccessRequests, filesystemRoots);
    return addNetworkHttpServiceBinding(
        withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'events', availability: 'available' },
        ),
        hostAccessRequests,
    );
}

export function addExecServiceBinding(
    binding: PluginInvocationServiceBinding,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[],
    managedServicesAvailable = false,
    publicExecAvailable = true,
): PluginInvocationServiceBinding {
    const requests = hostAccessRequests
        .map(({ request }) => request)
        .filter((request): request is Extract<PluginHostAccessRequestV2, { capability: 'process' }> => request.capability === 'process');
    const environmentRequests = hostAccessRequests
        .map(({ request }) => request)
        .filter((request): request is Extract<PluginHostAccessRequestV2, { capability: 'environment' }> => (
            request.capability === 'environment'
        ));
    const executableByKey = new Map<string, (typeof requests)[number]['scope']['executables'][number]>();
    const envKeys = new Set<string>();
    for (const request of requests) {
        for (const executable of request.scope.executables) executableByKey.set(JSON.stringify(executable), executable);
        for (const key of request.scope.envKeys ?? []) envKeys.add(key);
    }
    for (const request of environmentRequests) {
        for (const key of request.scope.keys) envKeys.add(key);
    }
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            ...(publicExecAvailable
                ? [{ serviceId: 'exec' as const, availability: 'available' as const }]
                : []),
            ...(managedServicesAvailable
                ? [{ serviceId: 'managedServices' as const, availability: 'available' as const }]
                : []),
        ),
        processExecutables: Object.freeze([...executableByKey.values()]),
        processEnvKeys: Object.freeze([...envKeys]),
        ...(requests.length > 0
            ? { processRequestIds: Object.freeze(requests.map((request) => request.id)) }
            : {}),
        ...(environmentRequests.length > 0
            ? { environmentRequestIds: Object.freeze(environmentRequests.map((request) => request.id)) }
            : {}),
    });
}

export function createLoggerFilesystemEventsAndExecServiceBinding(
    occurrenceId: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    filesystemRoots: PluginFileSystemRoots,
    managedServicesAvailable = false,
    publicExecAvailable = true,
): PluginInvocationServiceBinding {
    const binding = createLoggerFilesystemAndEventsServiceBinding(
        occurrenceId,
        id,
        hostAccessRequests,
        filesystemRoots,
    );
    return addExecServiceBinding(
        binding,
        hostAccessRequests,
        managedServicesAvailable,
        publicExecAvailable,
    );
}

export function createLoggerEventsAndExecServiceBinding(
    occurrenceId: string,
    id: string,
    hostAccessRequests: readonly Readonly<{ request: PluginHostAccessRequestV2; required: boolean }>[] = [],
    managedServicesAvailable = false,
    publicExecAvailable = true,
): PluginInvocationServiceBinding {
    const binding = createLoggerAndEventsAvailablePluginInvocationServiceBinding(occurrenceId, id, hostAccessRequests);
    return addExecServiceBinding(
        binding,
        hostAccessRequests,
        managedServicesAvailable,
        publicExecAvailable,
    );
}

export function createUnavailablePluginServicesFactory(): CreatePluginInvocationServices {
    return (seed, binding) => {
        if (binding.occurrenceId !== seed.occurrenceId) {
            throw new Error('Plugin invocation service binding occurrence does not match the invocation context');
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

export { createPluginInvocationServiceBinding } from './unavailable';
