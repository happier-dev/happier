import type {
    PluginConnectedAccountDescriptorContributionV2,
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';
import type {
    PluginConnectedAccountAuthenticationContext,
    PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';

import { isLiteralPrivateNetworkHostname } from '@/plugins/runtime/fetch/service';
import {
    withPluginInvocationServiceBindingAvailability,
} from '@/plugins/runtime/invocation/services/unavailable';
import type {
    PluginInvocationServiceBinding,
    PluginNetworkBindingScope,
} from '@/plugins/runtime/invocation/services/types';

type RuntimeConfiguration = PluginConnectedAccountAuthenticationContext['configuration'];

function sameService(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function matchesConnectedAccountOriginTarget(
    requestPluginId: string,
    service: PluginContributionRef,
    target: Extract<
        Extract<PluginHostAccessRequestV2, { capability: 'network' }>['scope']['targets'][number],
        { kind: 'connectedAccountOrigin' }
    >,
): boolean {
    const targetService = typeof target.service === 'string'
        ? { pluginId: requestPluginId, localId: target.service }
        : target.service;
    return sameService(targetService, service);
}

export function normalizeConnectedAccountConfiguredOrigin(
    value: string,
): Readonly<{ origin: string; privateNetwork: boolean }> {
    const url = new URL(value);
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.origin !== value.replace(/\/+$/, '')
    ) {
        throw new TypeError('Connected-account configured origin must be an exact credential-free HTTPS origin');
    }
    return Object.freeze({
        origin: url.origin,
        privateNetwork: isLiteralPrivateNetworkHostname(url.hostname),
    });
}

function configurationService(
    configuration: RuntimeConfiguration,
): PluginContributionRef {
    return configuration.target.kind === 'account'
        ? configuration.target.account.service
        : configuration.target.service;
}

/**
 * Projects only descriptor-typed origin fields from the already normalized
 * host configuration snapshot. The descriptor supplies field semantics, never
 * an origin value or HostAccess grant.
 */
export function resolveHostOwnedConnectedAccountConfiguredOrigins(input: Readonly<{
    service: PluginContributionRef;
    descriptor: PluginConnectedAccountDescriptorContributionV2;
    configuration: RuntimeConfiguration;
}>): readonly string[] {
    if (
        input.descriptor.id !== input.service.localId
        || !sameService(configurationService(input.configuration), input.service)
    ) {
        throw new Error(
            'Connected-account configured origin descriptor does not match the exact configuration target',
        );
    }
    const mode = input.descriptor.authentication.modes.find(
        (candidate) => candidate.id === input.configuration.target.modeId,
    );
    if (!mode) {
        throw new Error(
            'Connected-account configured origin authentication mode is unavailable',
        );
    }
    const descriptorConfiguration =
        'configuration' in mode ? mode.configuration : undefined;
    if (!descriptorConfiguration) return Object.freeze([]);
    if (
        (descriptorConfiguration.scope === 'service'
            && input.configuration.target.kind !== 'service')
        || (descriptorConfiguration.scope === 'account'
            && input.configuration.target.kind === 'service')
    ) {
        throw new Error(
            'Connected-account configured origin scope does not match the exact configuration target',
        );
    }
    const origins: string[] = [];
    for (const field of descriptorConfiguration.fields) {
        const semantic = Object.getOwnPropertyDescriptor(field, 'semantic');
        if (
            !semantic?.enumerable
            || !('value' in semantic)
            || semantic.value !== 'connectedAccountOrigin'
        ) {
            continue;
        }
        const configured = Object.getOwnPropertyDescriptor(
            input.configuration.values,
            field.id,
        );
        if (
            !configured?.enumerable
            || !('value' in configured)
            || typeof configured.value !== 'string'
        ) {
            throw new Error(
                `Connected-account configured origin field '${field.id}' is unavailable`,
            );
        }
        origins.push(configured.value);
    }
    return Object.freeze(origins);
}

export type ConnectedAccountConfiguredOriginResolution = Readonly<{
    service: PluginContributionRef;
    generation: string;
    configurationRevision: string;
    origins: readonly string[];
    networkScopes: readonly PluginNetworkBindingScope[];
    isCurrent(): boolean | Promise<boolean>;
}>;

/**
 * Resolves the semantic connectedAccountOrigin target once. The injected configured-origin
 * projection is host-owned; plugin-returned URLs never enter this path.
 */
export async function resolveConnectedAccountConfiguredOrigins(input: Readonly<{
    pluginId: string;
    service: PluginContributionRef;
    generation: string;
    configuration: RuntimeConfiguration;
    hostAccessRequests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
        status: 'available' | 'unavailable' | 'denied';
    }>[];
    resolveHostOwnedConfiguredOrigins(
        configuration: RuntimeConfiguration,
    ): readonly string[] | Promise<readonly string[]>;
    isConfigurationCurrent(configuration: RuntimeConfiguration): boolean | Promise<boolean>;
    isGenerationCurrent(generation: string): boolean | Promise<boolean>;
}>): Promise<ConnectedAccountConfiguredOriginResolution> {
    if (input.pluginId !== input.service.pluginId) {
        throw new TypeError('Connected-account producer network requests must be same-plugin');
    }
    const matching = input.hostAccessRequests.flatMap(({ request, required, status }) => {
        if (
            status !== 'available'
            || request.capability !== 'network'
            || !request.scope.targets.some((target) => (
                target.kind === 'connectedAccountOrigin'
                && matchesConnectedAccountOriginTarget(
                    input.pluginId,
                    input.service,
                    target,
                )
            ))
        ) return [];
        return [{ request, required }];
    });
    if (matching.length === 0) {
        throw new Error('Connected-account producer network access is unavailable');
    }
    const configured = (await input.resolveHostOwnedConfiguredOrigins(input.configuration))
        .map(normalizeConnectedAccountConfiguredOrigin);
    if (!await input.isConfigurationCurrent(input.configuration)) {
        throw new Error('Connected-account configuration changed during origin resolution');
    }
    if (!await input.isGenerationCurrent(input.generation)) {
        throw new Error('Connected-account plugin generation changed during origin resolution');
    }
    const scopes = matching.map(({ request, required }) => {
        const fixed = request.scope.targets.flatMap((target) => (
            target.kind === 'fixedOrigin'
                ? [normalizeConnectedAccountConfiguredOrigin(target.origin)]
                : []
        ));
        const origins = [...fixed, ...configured]
            .filter((origin) => !origin.privateNetwork || request.scope.privateNetwork === true)
            .map((origin) => origin.origin);
        return Object.freeze({
            accessId: request.id,
            required,
            origins: Object.freeze([...new Set(origins)].sort()),
            ...(request.scope.methods === undefined
                ? {}
                : { methods: Object.freeze([...request.scope.methods].sort()) }),
            privateNetwork: request.scope.privateNetwork === true,
            connectedAccountService: input.service,
        });
    }).filter((scope) => scope.origins.length > 0);
    if (scopes.length === 0) {
        throw new Error('Connected-account producer network access resolved no allowed origin');
    }
    const origins = Object.freeze([...new Set(scopes.flatMap((scope) => scope.origins))].sort());
    return Object.freeze({
        service: input.service,
        generation: input.generation,
        configurationRevision: input.configuration.revision,
        origins,
        networkScopes: Object.freeze(scopes),
        isCurrent: async () => (
            await input.isConfigurationCurrent(input.configuration)
            && await input.isGenerationCurrent(input.generation)
        ),
    });
}

export function bindConnectedAccountConfiguredOrigins(
    binding: PluginInvocationServiceBinding,
    resolution: ConnectedAccountConfiguredOriginResolution,
): PluginInvocationServiceBinding {
    return Object.freeze({
        ...withPluginInvocationServiceBindingAvailability(
            binding,
            { serviceId: 'fetch', availability: 'available' },
        ),
        networkOrigins: resolution.origins,
        networkRequestIds: Object.freeze(resolution.networkScopes.map((scope) => scope.accessId)),
        networkScopes: resolution.networkScopes,
        networkCurrentness: resolution.isCurrent,
    });
}
