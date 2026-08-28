import { randomUUID } from 'node:crypto';

import {
    sameQualifiedConnectedAccountRef,
    type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';
import {
    type ConnectedAccountMaterializationRequest,
    type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
    type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
    type ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    type PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import type { PluginNetworkAddressResolver } from '@/plugins/runtime/fetch/originLocality';
import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import {
    withPluginInvocationServiceBindingAvailability,
} from '@/plugins/runtime/invocation/services/unavailable';
import type {
    PluginInvocationServicesSeed,
    PluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/types';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from '@/plugins/runtime/invocation/lifetime';
import type {
    PluginInvocationHostPolicy,
    ResolvePluginInvocationHostPolicy,
} from '@/plugins/runtime/hostAccess/resolve';

import type {
    ConnectedAccountAttemptProviderInvocation,
} from './authenticationAttemptOwner';
import {
    bindConnectedAccountConfiguredOrigins,
    matchesConnectedAccountOriginTarget,
    resolveConnectedAccountConfiguredOrigins,
    type ConnectedAccountConfiguredEndpoint,
} from './configuredOrigins';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    type ConnectedAccountRuntimeLease,
} from './contributionRegistry';
import {
    redactConnectedAccountAuthenticationResultDiagnostic,
    snapshotConnectedAccountEstablishedResult,
    staleConnectedAccountProducerResult,
} from './producerResultSnapshot';

type MaybePromise<T> = T | Promise<T>;
type PluginConnectedAccountCredentialStore =
    PluginConnectedAccountAuthenticationContext['attemptCredentials'];
type PluginConnectedAccountReadContext =
    Parameters<PluginConnectedAccountRuntime['status']>[0];
type ConnectedAccountCredentialReader =
    PluginConnectedAccountReadContext['credentials'];
type ConnectedAccountCallbackCurrentnessPhase = 'beforeCallback' | 'afterCallback';

/**
 * The typed invocation boundary, rather than a recursive runtime wrapper,
 * owns the generation/currentness fence around every plugin callback. The
 * callback's own rejection stays visible while current; a retirement while it
 * is pending wins over that stale producer result just as every other host
 * currentness boundary does.
 */
async function invokeCurrentConnectedAccountCallback<TResult>(
    assertCurrent: (phase: ConnectedAccountCallbackCurrentnessPhase) => Promise<void>,
    callback: () => MaybePromise<TResult>,
): Promise<TResult> {
    await assertCurrent('beforeCallback');
    try {
        return await callback();
    } finally {
        await assertCurrent('afterCallback');
    }
}

export type ConnectedAccountRuntimeAuthenticationInvocation =
    ConnectedAccountAttemptProviderInvocation & Readonly<{
        isConfigurationCurrent(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): MaybePromise<boolean>;
        configurationRevocationSignal?(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): AbortSignal | undefined;
    }>;

export type ConnectedAccountRuntimeEstablishedTarget = Readonly<{
    account: Readonly<{
        service: PluginContributionRef;
        accountId: string;
    }>;
    expectedCredentialRevision: string;
    expectedRuntimeConfigurationRevision: string;
}>;

export type ConnectedAccountRuntimeEstablishedOperation =
    | Readonly<{
        kind: 'refresh';
        operationId: string;
        stagedCredentials: PluginConnectedAccountCredentialStore;
    }>
    | Readonly<{ kind: 'status' }>
    | Readonly<{ kind: 'quota' }>
    | Readonly<{ kind: 'revoke' }>
    | Readonly<{
        kind: 'materialize';
        request: ConnectedAccountMaterializationRequest;
    }>;

export type ConnectedAccountRuntimeEstablishedInvocation<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation =
        ConnectedAccountRuntimeEstablishedOperation,
> = Readonly<{
    target: ConnectedAccountRuntimeEstablishedTarget;
    operation: TOperation;
    context: Readonly<{
        account: ConnectedAccountRuntimeEstablishedTarget['account'];
        configuration: PluginConnectedAccountRuntimeConfiguration;
        credentials: ConnectedAccountCredentialReader;
    }>;
    isConfigurationCurrent(
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<boolean>;
    configurationRevocationSignal?(
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): AbortSignal | undefined;
    isCredentialRevisionCurrent(): MaybePromise<boolean>;
    signal?: AbortSignal;
}>;

export type ConnectedAccountRuntimeEstablishedResult<
    TOperation extends ConnectedAccountRuntimeEstablishedOperation,
> =
    TOperation['kind'] extends 'refresh'
        ? Awaited<ReturnType<PluginConnectedAccountRuntime['refresh']>>
        : TOperation['kind'] extends 'status'
            ? Awaited<ReturnType<PluginConnectedAccountRuntime['status']>>
            : TOperation['kind'] extends 'quota'
                ? Awaited<
                    ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>
                > | null
                : TOperation['kind'] extends 'revoke'
                    ? Awaited<ReturnType<PluginConnectedAccountRuntime['revoke']>>
                    : Awaited<ReturnType<PluginConnectedAccountRuntime['materialize']>>;

export type ConnectedAccountHostRuntimeInvoker = Readonly<{
    invokeAuthentication(
        input: ConnectedAccountRuntimeAuthenticationInvocation,
    ): Promise<unknown>;
    invokeEstablished<
        TOperation extends ConnectedAccountRuntimeEstablishedOperation,
    >(
        input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
    ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>>;
}>;

function sameService(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function hasConnectedAccountOriginRequest(
    pluginId: string,
    service: PluginContributionRef,
    entries: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[],
): boolean {
    return entries.some(({ request }) => (
        (request.capability === 'network' || request.capability === 'network.client')
        && request.scope.targets.some((target) => (
            target.kind === 'connectedAccountOrigin'
            && matchesConnectedAccountOriginTarget(
                pluginId,
                service,
                target,
            )
        ))
    ));
}

function resolveHostAccessEntries(
    requests: readonly Readonly<{
        request: PluginHostAccessRequestV2;
        required: boolean;
    }>[],
    policy: PluginInvocationHostPolicy,
): readonly Readonly<{
    request: PluginHostAccessRequestV2;
    required: boolean;
    status: PluginInvocationHostPolicy['hostAccess'][number]['status'];
}>[] {
    if (policy.hostAccess.length !== requests.length) {
        throw new Error('Connected-account HostAccess policy result is incomplete');
    }
    return Object.freeze(requests.map((entry, index) => Object.freeze({
        ...entry,
        status: policy.hostAccess[index]!.status,
    })));
}

function removeUnqualifiedProducerNetworkAuthority(
    binding: PluginInvocationServiceBinding,
): PluginInvocationServiceBinding {
    return withPluginInvocationServiceBindingAvailability(
        binding,
        { serviceId: 'http', availability: 'unavailable' },
    );
}

function authenticationUnavailable(code: string): Readonly<{
    status: 'unavailable';
    diagnostic: Readonly<{ code: string; severity: 'error' }>;
}> {
    return Object.freeze({
        status: 'unavailable',
        diagnostic: Object.freeze({ code, severity: 'error' }),
    });
}

export function createConnectedAccountHostRuntimeInvoker(params: Readonly<{
    resolveRuntime(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | null>;
    resolvePlugin(ref: PluginContributionRef): Readonly<{
        version: string;
        hostAccessRequests: readonly Readonly<{
            request: PluginHostAccessRequestV2;
            required: boolean;
        }>[];
    }> | null;
    resolveHostPolicy: ResolvePluginInvocationHostPolicy;
    createServices(
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
    ): PluginConnectedAccountAuthenticationContext['services'];
    registerRawForRedaction(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): void;
    redactDiagnosticText?(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): string;
    resolveHostOwnedConfiguredEndpoints(
        service: PluginContributionRef,
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<readonly ConnectedAccountConfiguredEndpoint[]>;
    /** DNS boundary for the private-network decision; defaults to the host resolver. */
    resolveNetworkAddresses?: PluginNetworkAddressResolver;
}>): ConnectedAccountHostRuntimeInvoker {
    async function createContext(input: ConnectedAccountRuntimeAuthenticationInvocation): Promise<Readonly<{
        lease: ConnectedAccountRuntimeLease;
        seed: PluginInvocationServicesSeed;
        context: PluginConnectedAccountAuthenticationContext;
        assertCurrent(phase?: ConnectedAccountCallbackCurrentnessPhase): Promise<void>;
        lifetime: PluginInvocationLifetime;
    }>> {
        const lease = await params.resolveRuntime(input.admission.service);
        if (!lease) {
            throw new Error('Connected-account runtime is unavailable');
        }
        if (
            lease.generation !== input.admission.generation
            || lease.immutableGenerationId !== input.admission.immutableGenerationId
            || !sameService(lease.ref, input.admission.service)
        ) {
            throw new Error('Connected-account runtime admission is no longer current');
        }
        const plugin = params.resolvePlugin(lease.ref);
        if (!plugin) {
            throw new Error('Connected-account plugin package identity is unavailable');
        }
        const lifetime = createPluginInvocationLifetime(input.signal);
        const signal = lifetime.signal;
        const qualifiedId = `${lease.ref.pluginId}/connectedAccountDescriptors/${lease.ref.localId}`;
        const seed: PluginInvocationServicesSeed = Object.freeze({
            plugin: Object.freeze({ id: lease.ref.pluginId, version: plugin.version }),
            contribution: Object.freeze({
                id: lease.ref.localId,
                qualifiedId,
            }),
            generation: lease.generation,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isGenerationCurrent: () => !signal.aborted && lease.isCurrent(),
        });
        const assertCurrent = async (
            phase: ConnectedAccountCallbackCurrentnessPhase = 'afterCallback',
        ): Promise<void> => {
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Connected-account authentication operation was aborted');
            }
            if (!lease.isCurrent()) {
                if (phase === 'beforeCallback') {
                    throw new ConnectedAccountRuntimeInvocationNotStartedError();
                }
                throw new Error('Connected-account authentication runtime is no longer current');
            }
            if (!await input.isConfigurationCurrent(input.context.configuration)) {
                throw new Error('Connected-account authentication runtime is no longer current');
            }
            if (!lease.isCurrent()) {
                if (phase === 'beforeCallback') {
                    throw new ConnectedAccountRuntimeInvocationNotStartedError();
                }
                throw new Error('Connected-account authentication runtime is no longer current');
            }
        };
        try {
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                generation: lease.generation,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const hasQualifiedProducerNetworkAuthority = hasConnectedAccountOriginRequest(
                lease.ref.pluginId,
                lease.ref,
                plugin.hostAccessRequests,
            );
            let serviceBinding = hasQualifiedProducerNetworkAuthority
                ? policy.serviceBinding
                : removeUnqualifiedProducerNetworkAuthority(policy.serviceBinding);
            if (hasQualifiedProducerNetworkAuthority) {
                const configurationRevocationSignal = input.configurationRevocationSignal?.(
                    input.context.configuration,
                );
                const resolution = await resolveConnectedAccountConfiguredOrigins({
                    pluginId: lease.ref.pluginId,
                    service: lease.ref,
                    generation: lease.generation,
                    configuration: input.context.configuration,
                    hostAccessRequests: resolveHostAccessEntries(
                        plugin.hostAccessRequests,
                        policy,
                    ),
                    resolveHostOwnedConfiguredEndpoints: async (configuration) => (
                        await params.resolveHostOwnedConfiguredEndpoints(lease.ref, configuration)
                    ),
                    isConfigurationCurrent: input.isConfigurationCurrent,
                    ...(configurationRevocationSignal === undefined
                        ? {}
                        : { configurationRevocationSignal }),
                    isGenerationCurrent: () => lease.isCurrent(),
                    ...(params.resolveNetworkAddresses
                        ? { resolveNetworkAddresses: params.resolveNetworkAddresses }
                        : {}),
                });
                serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
            }
            const services = params.createServices(seed, serviceBinding);
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                ...input.context.configuration,
                async getSecret(fieldId, options) {
                    await assertCurrent();
                    const value = await input.context.configuration.getSecret(fieldId, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const attemptCredentials: PluginConnectedAccountCredentialStore = Object.freeze({
                async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertCurrent();
                    const value = await input.context.attemptCredentials.get(key, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
                async set(
                    key: string,
                    value: string,
                    options?: Readonly<{ signal?: AbortSignal }>,
                ) {
                    await assertCurrent();
                    await input.context.attemptCredentials.set(key, value, options);
                    await assertCurrent();
                    params.registerRawForRedaction(seed, value);
                },
                async delete(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertCurrent();
                    await input.context.attemptCredentials.delete(key, options);
                    await assertCurrent();
                },
            });
            const context: PluginConnectedAccountAuthenticationContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal,
                    isGenerationCurrent: seed.isGenerationCurrent,
                }),
                ...input.context,
                configuration,
                attemptCredentials,
            });
            return Object.freeze({ lease, seed, context, assertCurrent, lifetime });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    function assertSameAccount(
        left: ConnectedAccountRuntimeEstablishedTarget['account'],
        right: ConnectedAccountRuntimeEstablishedTarget['account'],
    ): void {
        if (!sameQualifiedConnectedAccountRef(left, right)) {
            throw new Error('Connected-account established context does not match its exact target');
        }
    }

    async function createEstablishedContext(
        input: ConnectedAccountRuntimeEstablishedInvocation,
    ): Promise<Readonly<{
        lease: ConnectedAccountRuntimeLease;
        seed: PluginInvocationServicesSeed;
        context: PluginConnectedAccountReadContext;
        assertCurrent(phase?: ConnectedAccountCallbackCurrentnessPhase): Promise<void>;
        lifetime: PluginInvocationLifetime;
    }>> {
        assertSameAccount(input.target.account, input.context.account);
        const configurationTarget = input.context.configuration.target;
        if (
            configurationTarget.kind === 'attempt'
            || input.context.configuration.revision
                !== input.target.expectedRuntimeConfigurationRevision
        ) {
            throw new Error('Connected-account established configuration revision is unavailable');
        }
        if (configurationTarget.kind === 'account') {
            assertSameAccount(input.target.account, configurationTarget.account);
        } else if (!sameService(
            input.target.account.service,
            configurationTarget.service,
        )) {
            throw new Error('Connected-account established context does not match its exact service target');
        }

        const lease = await params.resolveRuntime(input.target.account.service);
        const plugin = lease ? params.resolvePlugin(lease.ref) : null;
        if (!lease || !plugin || !sameService(lease.ref, input.target.account.service)) {
            throw new Error('Connected-account established runtime is unavailable');
        }
        const lifetime = createPluginInvocationLifetime(input.signal);
        const signal = lifetime.signal;
        const qualifiedId = `${lease.ref.pluginId}/connectedAccountDescriptors/${lease.ref.localId}`;
        const seed: PluginInvocationServicesSeed = Object.freeze({
            plugin: Object.freeze({ id: lease.ref.pluginId, version: plugin.version }),
            contribution: Object.freeze({
                id: lease.ref.localId,
                qualifiedId,
            }),
            generation: lease.generation,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isGenerationCurrent: () => !signal.aborted && lease.isCurrent(),
        });
        const assertCurrent = async (
            _phase: ConnectedAccountCallbackCurrentnessPhase = 'afterCallback',
        ): Promise<void> => {
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Connected-account established operation was aborted');
            }
            if (
                !lease.isCurrent()
                || !await input.isConfigurationCurrent(input.context.configuration)
                || !await input.isCredentialRevisionCurrent()
            ) {
                throw staleConnectedAccountProducerResult(
                    input.operation.kind,
                );
            }
        };
        try {
            await assertCurrent();
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                generation: lease.generation,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const hasQualifiedProducerNetworkAuthority = hasConnectedAccountOriginRequest(
                lease.ref.pluginId,
                lease.ref,
                plugin.hostAccessRequests,
            );
            let serviceBinding = hasQualifiedProducerNetworkAuthority
                ? policy.serviceBinding
                : removeUnqualifiedProducerNetworkAuthority(policy.serviceBinding);
            if (hasQualifiedProducerNetworkAuthority) {
                const configurationRevocationSignal = input.configurationRevocationSignal?.(
                    input.context.configuration,
                );
                const resolution = await resolveConnectedAccountConfiguredOrigins({
                    pluginId: lease.ref.pluginId,
                    service: lease.ref,
                    generation: lease.generation,
                    configuration: input.context.configuration,
                    hostAccessRequests: resolveHostAccessEntries(
                        plugin.hostAccessRequests,
                        policy,
                    ),
                    resolveHostOwnedConfiguredEndpoints: async (configuration) => (
                        await params.resolveHostOwnedConfiguredEndpoints(lease.ref, configuration)
                    ),
                    isConfigurationCurrent: input.isConfigurationCurrent,
                    ...(configurationRevocationSignal === undefined
                        ? {}
                        : { configurationRevocationSignal }),
                    isGenerationCurrent: () => lease.isCurrent(),
                    ...(params.resolveNetworkAddresses
                        ? { resolveNetworkAddresses: params.resolveNetworkAddresses }
                        : {}),
                });
                serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
            }
            await assertCurrent();
            const services = params.createServices(seed, serviceBinding);
            const credentials: ConnectedAccountCredentialReader = Object.freeze({
                async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                    await assertCurrent();
                    const value = await input.context.credentials.get(key, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
                ...input.context.configuration,
                async getSecret(fieldId, options) {
                    await assertCurrent();
                    const value = await input.context.configuration.getSecret(fieldId, options);
                    await assertCurrent();
                    if (value !== null) params.registerRawForRedaction(seed, value);
                    return value;
                },
            });
            const context: PluginConnectedAccountReadContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal,
                    isGenerationCurrent: seed.isGenerationCurrent,
                }),
                account: input.context.account,
                configuration,
                credentials,
            });
            return Object.freeze({ lease, seed, context, assertCurrent, lifetime });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    function guardStagedCredentials(
        source: PluginConnectedAccountCredentialStore,
        assertCurrent: () => Promise<void>,
        registerRawForRedaction: (value: string) => void,
    ): PluginConnectedAccountCredentialStore {
        return Object.freeze({
            async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                const value = await source.get(key, options);
                await assertCurrent();
                if (value !== null) registerRawForRedaction(value);
                return value;
            },
            async set(
                key: string,
                value: string,
                options?: Readonly<{ signal?: AbortSignal }>,
            ) {
                await assertCurrent();
                await source.set(key, value, options);
                await assertCurrent();
                registerRawForRedaction(value);
            },
            async delete(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                await source.delete(key, options);
                await assertCurrent();
            },
        });
    }

    return Object.freeze({
        async invokeAuthentication(input) {
            let invocationContext: Awaited<ReturnType<typeof createContext>>;
            try {
                invocationContext = await createContext(input);
            } catch {
                return authenticationUnavailable(
                    'connected_account_producer_context_unavailable',
                );
            }
            const { lease, seed, context, assertCurrent, lifetime } = invocationContext;
            try {
                const mode = lease.runtime.authentication.modes[input.admission.modeId];
                if (!mode || mode.kind !== input.admission.descriptor.kind) {
                    return authenticationUnavailable(
                        'connected_account_authentication_mode_unavailable',
                    );
                }
                const options = input.signal ? { signal: input.signal } : undefined;
                const operation = input.operation;
                let result: unknown;
                let invoked = false;
                switch (operation.kind) {
                    case 'beginOAuth':
                        if (mode.kind !== 'oauthAuthorizationCode') break;
                        params.registerRawForRedaction(seed, operation.request.state);
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.begin(operation.request, context, options),
                        );
                        invoked = true;
                        break;
                    case 'beginDevice':
                        if (mode.kind !== 'oauthDeviceCode') break;
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.begin(context, options),
                        );
                        invoked = true;
                        break;
                    case 'submitManual':
                        if (
                            mode.kind !== 'manual'
                            || input.admission.descriptor.kind !== 'manual'
                        ) break;
                        for (const field of input.admission.descriptor.fields) {
                            if (!field.secret) continue;
                            const value = operation.fields[field.id];
                            if (value !== undefined) {
                                params.registerRawForRedaction(seed, value);
                            }
                        }
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.complete(
                                Object.freeze({ fields: operation.fields }),
                                context,
                                options,
                            ),
                        );
                        invoked = true;
                        break;
                    case 'completeOAuth':
                        if (mode.kind !== 'oauthAuthorizationCode') break;
                        params.registerRawForRedaction(seed, operation.completion.code);
                        params.registerRawForRedaction(seed, operation.completion.callbackUrl);
                        params.registerRawForRedaction(seed, operation.completion.state);
                        params.registerRawForRedaction(seed, operation.completion.pkceVerifier);
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.complete(operation.completion, context, options),
                        );
                        invoked = true;
                        break;
                    case 'pollDevice':
                        if (mode.kind !== 'oauthDeviceCode') break;
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.poll(context, options),
                        );
                        invoked = true;
                        break;
                    case 'reconcile':
                        if (typeof mode.reconcile !== 'function') break;
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.reconcile!(context, options),
                        );
                        invoked = true;
                        break;
                    case 'cancel':
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => mode.kind === 'manual'
                                ? undefined
                                : mode.cancel(context),
                        );
                        invoked = true;
                        break;
                }
                if (!invoked) {
                    return authenticationUnavailable(
                        'connected_account_authentication_operation_unavailable',
                    );
                }
                const redactDiagnosticText = params.redactDiagnosticText;
                const output = redactDiagnosticText === undefined
                    ? result
                    : redactConnectedAccountAuthenticationResultDiagnostic(
                        result,
                        (value) => redactDiagnosticText(seed, value),
                    );
                await assertCurrent();
                return output;
            } finally {
                lifetime.complete();
            }
        },
        async invokeEstablished<
            TOperation extends ConnectedAccountRuntimeEstablishedOperation,
        >(
            input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
            const { lease, seed, context, assertCurrent, lifetime } = await createEstablishedContext(input);
            try {
                const options = input.signal ? { signal: input.signal } : undefined;
                const operation = input.operation;
                let result: unknown;
                let quotaLeafUnavailable = false;
                switch (operation.kind) {
                    case 'refresh':
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => lease.runtime.refresh(Object.freeze({
                                ...context,
                                operation: Object.freeze({
                                    operationId: operation.operationId,
                                    configurationRevision:
                                        input.target.expectedRuntimeConfigurationRevision,
                                }),
                                stagedCredentials: guardStagedCredentials(
                                    operation.stagedCredentials,
                                    assertCurrent,
                                    (value) => params.registerRawForRedaction(seed, value),
                                ),
                            }), options),
                        );
                        break;
                    case 'status':
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => lease.runtime.status(context, options),
                        );
                        break;
                    case 'quota':
                        if (lease.runtime.quota) {
                            result = await invokeCurrentConnectedAccountCallback(
                                assertCurrent,
                                () => lease.runtime.quota!(
                                    context,
                                    options,
                                ),
                            );
                        } else {
                            quotaLeafUnavailable = true;
                            result = await invokeCurrentConnectedAccountCallback(
                                assertCurrent,
                                () => null,
                            );
                        }
                        break;
                    case 'revoke':
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => lease.runtime.revoke(context, options),
                        );
                        break;
                    case 'materialize':
                        result = await invokeCurrentConnectedAccountCallback(
                            assertCurrent,
                            () => lease.runtime.materialize(
                                operation.request,
                                context,
                                options,
                            ),
                        );
                        break;
                }
                const redactDiagnosticText = params.redactDiagnosticText;
                const snapshot = snapshotConnectedAccountEstablishedResult(
                    operation,
                    result,
                    Object.freeze({
                        quotaLeafUnavailable,
                        ...(redactDiagnosticText === undefined
                            ? {}
                            : {
                                redactDiagnosticText: (value: string) =>
                                    redactDiagnosticText(seed, value),
                            }),
                    }),
                );
                await assertCurrent();
                return snapshot;
            } finally {
                lifetime.complete();
            }
        },
    });
}
