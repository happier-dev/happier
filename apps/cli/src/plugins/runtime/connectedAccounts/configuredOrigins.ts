import type {
    PluginConnectedAccountDescriptorContributionV2,
    PluginHostAccessRequestV2,
} from '@happier-dev/protocol';
import type {
    ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import {
    assessPluginNetworkOriginLocalities,
    type PluginNetworkAddressResolver,
} from '@/plugins/runtime/fetch/originLocality';
import {
    withPluginInvocationServiceBindingAvailability,
} from '@/plugins/runtime/invocation/services/unavailable';
import type {
    PluginInvocationServiceBinding,
    PluginNetworkClientBindingScope,
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
        Extract<PluginHostAccessRequestV2, { capability: 'network' | 'network.client' }>['scope']['targets'][number],
        { kind: 'connectedAccountOrigin' }
    >,
): boolean {
    const targetService = typeof target.service === 'string'
        ? { pluginId: requestPluginId, localId: target.service }
        : target.service;
    return sameService(targetService, service);
}

/**
 * The two configured facts of one Connected Account endpoint. `origin` is the
 * network origin HostAccess governs and always means `scheme://host[:port]`.
 * `base` is the configured service base a source routes by, which for a
 * path-prefixed deployment carries the path segment the account lives beneath.
 * They are one declaration seen from two sides: `base` always begins with
 * `origin`.
 *
 * Neither fact carries a private-network decision, because a hostname's text
 * cannot supply one: `assessPluginNetworkOriginLocality` owns that decision and
 * needs the origin's resolved addresses to make it.
 */
export type ConnectedAccountConfiguredEndpoint = Readonly<{
    origin: string;
    base: string;
}>;

export function normalizeConnectedAccountConfiguredOrigin(
    value: string,
): Readonly<{ origin: string }> {
    const url = new URL(value);
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.origin !== value.replace(/\/+$/, '')
    ) {
        throw new TypeError('Connected-account configured origin must be an exact credential-free HTTPS origin');
    }
    return Object.freeze({ origin: url.origin });
}

/**
 * Normalizes a configured service base. A base may live beneath a path segment
 * — an Azure DevOps organization or collection, a path-prefixed self-hosted
 * deployment — but is otherwise held to the same exactness as an origin: HTTPS
 * only, no credentials, no query, no fragment, and no reinterpretation of what
 * the user configured. Only a trailing slash is normalized away; path case is
 * preserved because a collection segment is case-bearing.
 */
export function normalizeConnectedAccountConfiguredBase(
    value: string,
): ConnectedAccountConfiguredEndpoint {
    // One rejection for every malformed base, so an unparseable value cannot be
    // told apart from a rejected one by the message it produced.
    const rejected = () => new TypeError(
        'Connected-account configured base must be an exact credential-free HTTPS service base',
    );
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw rejected();
    }
    const path = url.pathname.replace(/\/+$/, '');
    const base = `${url.origin}${path}`;
    if (
        url.protocol !== 'https:'
        || url.username !== ''
        || url.password !== ''
        || url.search !== ''
        || url.hash !== ''
        || base !== value.replace(/\/+$/, '')
    ) {
        throw rejected();
    }
    return Object.freeze({ origin: url.origin, base });
}

function originEndpoint(value: string): ConnectedAccountConfiguredEndpoint {
    const origin = normalizeConnectedAccountConfiguredOrigin(value).origin;
    return Object.freeze({ origin, base: origin });
}

function configurationService(
    configuration: RuntimeConfiguration,
): PluginContributionRef {
    return configuration.target.kind === 'account'
        ? configuration.target.account.service
        : configuration.target.service;
}

type ConnectedAccountDescriptorModeConfiguration = NonNullable<
    Extract<
        PluginConnectedAccountDescriptorContributionV2['authentication']['modes'][number],
        { configuration?: unknown }
    >['configuration']
>;

function readOwnEnumerableString(
    container: object,
    key: string,
): string | null {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    return typeof descriptor.value === 'string' ? descriptor.value : null;
}

/**
 * The one selector from descriptor-typed endpoint fields to their configured,
 * host-normalized facts. Endpoint-semantic fields are never secret — the
 * canonical configuration normalizer rejects a secret field supplied as
 * plaintext — so every configured endpoint lives in the plain `values` record
 * of the exact configuration.
 *
 * Three endpoint semantics are published, and all resolve here so no consumer
 * gains a second route table. `connectedAccountOrigin` persists the origin the
 * user typed. `connectedAccountFixedOrigin` persists a closed *choice* whose
 * route the descriptor already declared in `originByValue`: the persisted value
 * is never treated as a URL, so a stored value outside the declared choice set
 * resolves to no origin at all rather than to something a caller could reach.
 * `connectedAccountBase` persists a service base that may live beneath a path
 * segment, and projects both facts: the base a source routes by and the origin
 * HostAccess governs.
 */
export function projectConnectedAccountConfiguredEndpoints(input: Readonly<{
    configuration: ConnectedAccountDescriptorModeConfiguration | undefined;
    values: Readonly<Record<string, unknown>>;
}>): readonly ConnectedAccountConfiguredEndpoint[] {
    if (!input.configuration) return Object.freeze([]);
    const endpoints: ConnectedAccountConfiguredEndpoint[] = [];
    for (const field of input.configuration.fields) {
        const semantic = Object.getOwnPropertyDescriptor(field, 'semantic');
        if (!semantic?.enumerable || !('value' in semantic)) continue;
        if (
            semantic.value !== 'connectedAccountOrigin'
            && semantic.value !== 'connectedAccountFixedOrigin'
            && semantic.value !== 'connectedAccountBase'
        ) {
            continue;
        }
        const configured = readOwnEnumerableString(input.values, field.id);
        if (configured === null) {
            throw new Error(
                `Connected-account configured endpoint field '${field.id}' is unavailable`,
            );
        }
        if (semantic.value === 'connectedAccountBase') {
            endpoints.push(normalizeConnectedAccountConfiguredBase(configured));
            continue;
        }
        if (semantic.value === 'connectedAccountOrigin') {
            endpoints.push(originEndpoint(configured));
            continue;
        }
        const originByValue = Object.getOwnPropertyDescriptor(field, 'originByValue');
        const routes = originByValue?.enumerable && 'value' in originByValue
            && typeof originByValue.value === 'object' && originByValue.value !== null
            ? originByValue.value
            : null;
        const routed = routes === null ? null : readOwnEnumerableString(routes, configured);
        if (routed === null) {
            throw new Error(
                `Connected-account configured endpoint field '${field.id}' declares no origin for its configured choice`,
            );
        }
        endpoints.push(originEndpoint(routed));
    }
    return Object.freeze(endpoints);
}

/**
 * Projects only descriptor-typed endpoint fields from the already normalized
 * host configuration snapshot. The descriptor supplies field semantics, never
 * an endpoint value or HostAccess grant.
 */
export function resolveHostOwnedConnectedAccountConfiguredEndpoints(input: Readonly<{
    service: PluginContributionRef;
    descriptor: PluginConnectedAccountDescriptorContributionV2;
    configuration: RuntimeConfiguration;
}>): readonly ConnectedAccountConfiguredEndpoint[] {
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
    return projectConnectedAccountConfiguredEndpoints({
        configuration: descriptorConfiguration,
        values: input.configuration.values,
    });
}

/**
 * The network-origin view of the same projection. HostAccess governs by origin
 * alone, so a path-prefixed base narrows to the origin it was derived from
 * rather than widening or splitting the admitted network target.
 */
export function resolveHostOwnedConnectedAccountConfiguredOrigins(input: Readonly<{
    service: PluginContributionRef;
    descriptor: PluginConnectedAccountDescriptorContributionV2;
    configuration: RuntimeConfiguration;
}>): readonly string[] {
    return Object.freeze(
        resolveHostOwnedConnectedAccountConfiguredEndpoints(input)
            .map((endpoint) => endpoint.origin),
    );
}

export type ConnectedAccountConfiguredOriginResolution = Readonly<{
    service: PluginContributionRef;
    generation: string;
    configurationRevision: string;
    origins: readonly string[];
    networkScopes: readonly PluginNetworkBindingScope[];
    networkClientOrigins: readonly string[];
    networkClientScopes: readonly PluginNetworkClientBindingScope[];
    networkRevocationSignal?: AbortSignal;
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
        status: 'available' | 'unavailable' | 'denied' | 'notApplicable';
    }>[];
    resolveHostOwnedConfiguredOrigins(
        configuration: RuntimeConfiguration,
    ): readonly string[] | Promise<readonly string[]>;
    isConfigurationCurrent(configuration: RuntimeConfiguration): boolean | Promise<boolean>;
    /** Push revocation from the exact host-owned configuration snapshot. */
    configurationRevocationSignal?: AbortSignal;
    isGenerationCurrent(generation: string): boolean | Promise<boolean>;
    /** DNS boundary for the private-network decision; defaults to the host resolver. */
    resolveNetworkAddresses?: PluginNetworkAddressResolver;
}>): Promise<ConnectedAccountConfiguredOriginResolution> {
    if (input.pluginId !== input.service.pluginId) {
        throw new TypeError('Connected-account producer network requests must be same-plugin');
    }
    const matching = input.hostAccessRequests.flatMap(({ request, required, status }) => {
        if (
            status !== 'available'
            || (request.capability !== 'network' && request.capability !== 'network.client')
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
    // One private-network decision for every origin this resolution can admit,
    // literal and resolved alike. A configured hostname that resolves inside a
    // private range is private here exactly as a private literal is, so the
    // account's credential cannot leave for it under a grant that never declared
    // private-network access.
    const localityByOrigin = await assessPluginNetworkOriginLocalities(
        [
            ...configured.map((endpoint) => endpoint.origin),
            ...matching.flatMap(({ request }) => request.scope.targets.flatMap((target) => (
                target.kind === 'fixedOrigin'
                    ? [normalizeConnectedAccountConfiguredOrigin(target.origin).origin]
                    : []
            ))),
        ],
        input.resolveNetworkAddresses
            ? { resolveAddresses: input.resolveNetworkAddresses }
            : {},
    );
    const admits = (origin: string, privateNetwork: boolean | undefined): boolean => (
        localityByOrigin.get(origin) === 'public' || privateNetwork === true
    );
    if (!await input.isConfigurationCurrent(input.configuration)) {
        throw new Error('Connected-account configuration changed during origin resolution');
    }
    if (!await input.isGenerationCurrent(input.generation)) {
        throw new Error('Connected-account plugin generation changed during origin resolution');
    }
    const networkScopes = matching.flatMap(({ request, required }) => {
        if (request.capability !== 'network') return [];
        const fixed = request.scope.targets.flatMap((target) => (
            target.kind === 'fixedOrigin'
                ? [normalizeConnectedAccountConfiguredOrigin(target.origin)]
                : []
        ));
        const origins = [...fixed, ...configured]
            .map((endpoint) => endpoint.origin)
            .filter((origin) => admits(origin, request.scope.privateNetwork));
        const scope = Object.freeze({
            authority: 'selectedResource' as const,
            accessId: request.id,
            required,
            origins: Object.freeze([...new Set(origins)].sort()),
            ...(request.scope.methods === undefined
                ? {}
                : { methods: Object.freeze([...request.scope.methods].sort()) }),
            privateNetwork: request.scope.privateNetwork === true,
            connectedAccountService: input.service,
        });
        return scope.origins.length > 0 ? [scope] : [];
    });
    const networkClientScopes = matching.flatMap(({ request, required }) => {
        if (request.capability !== 'network.client') return [];
        const fixed = request.scope.targets.flatMap((target) => (
            target.kind === 'fixedOrigin'
                ? [normalizeConnectedAccountConfiguredOrigin(target.origin)]
                : []
        ));
        const origins = [...fixed, ...configured]
            .map((endpoint) => endpoint.origin)
            .filter((origin) => admits(origin, request.scope.privateNetwork));
        const scope = Object.freeze({
            authority: 'selectedResource' as const,
            accessId: request.id,
            required,
            origins: Object.freeze([...new Set(origins)].sort()),
            transports: Object.freeze([...request.scope.transports].sort()),
            privateNetwork: request.scope.privateNetwork === true,
            connectedAccountService: input.service,
        });
        return scope.origins.length > 0 ? [scope] : [];
    });
    if (networkScopes.length === 0 && networkClientScopes.length === 0) {
        throw new Error('Connected-account producer network access resolved no allowed origin');
    }
    const origins = Object.freeze([...new Set(networkScopes.flatMap((scope) => scope.origins))].sort());
    const networkClientOrigins = Object.freeze([
        ...new Set(networkClientScopes.flatMap((scope) => scope.origins)),
    ].sort());
    return Object.freeze({
        service: input.service,
        generation: input.generation,
        configurationRevision: input.configuration.revision,
        origins,
        networkScopes: Object.freeze(networkScopes),
        networkClientOrigins,
        networkClientScopes: Object.freeze(networkClientScopes),
        ...(input.configurationRevocationSignal === undefined
            ? {}
            : { networkRevocationSignal: input.configurationRevocationSignal }),
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
            { serviceId: 'http', availability: 'available' },
        ),
        ...(resolution.networkScopes.length === 0 ? {} : {
            networkOrigins: resolution.origins,
            networkRequestIds: Object.freeze(resolution.networkScopes.map((scope) => scope.accessId)),
            networkScopes: resolution.networkScopes,
        }),
        ...(resolution.networkClientScopes.length === 0 ? {} : {
            networkClientOrigins: resolution.networkClientOrigins,
            networkClientRequestIds: Object.freeze(resolution.networkClientScopes.map((scope) => scope.accessId)),
            networkClientScopes: resolution.networkClientScopes,
        }),
        networkCurrentness: resolution.isCurrent,
        ...(resolution.networkRevocationSignal === undefined
            ? {}
            : { networkRevocationSignal: resolution.networkRevocationSignal }),
    });
}
