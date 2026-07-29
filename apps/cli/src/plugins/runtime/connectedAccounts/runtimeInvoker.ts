import { randomUUID } from 'node:crypto';

import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import {
    type PluginConnectedAccountAuthenticationContext,
    type PluginConnectedAccountCredentialReader,
    type PluginConnectedAccountMaterializationRequest,
    type PluginConnectedAccountRuntime,
    type PluginConnectedAccountRuntimeConfiguration,
    type PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';

import { createPluginInvocationUi } from '@/plugins/runtime/invocation/services/ui';
import {
    withPluginInvocationServiceBindingAvailability,
} from '@/plugins/runtime/invocation/services/unavailable';
import type {
    PluginInvocationServicesSeed,
    PluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/types';
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
} from './configuredOrigins';
import type { ConnectedAccountRuntimeLease } from './contributionRegistry';

type MaybePromise<T> = T | Promise<T>;
type PluginConnectedAccountCredentialStore =
    PluginConnectedAccountAuthenticationContext['attemptCredentials'];
type PluginConnectedAccountReadContext =
    Parameters<PluginConnectedAccountRuntime['status']>[0];

export type ConnectedAccountRuntimeAuthenticationInvocation =
    ConnectedAccountAttemptProviderInvocation & Readonly<{
        isConfigurationCurrent(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): MaybePromise<boolean>;
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
        request: PluginConnectedAccountMaterializationRequest;
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
        credentials: PluginConnectedAccountCredentialReader;
    }>;
    isConfigurationCurrent(
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<boolean>;
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
        request.capability === 'network'
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
    status: 'available' | 'unavailable' | 'denied';
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
        { serviceId: 'fetch', availability: 'unavailable' },
    );
}

function authenticationUnavailable(code: string): Readonly<{
    status: 'unavailable';
    diagnostic: Readonly<{ code: string }>;
}> {
    return Object.freeze({
        status: 'unavailable',
        diagnostic: Object.freeze({ code }),
    });
}

export function createConnectedAccountHostRuntimeInvoker(params: Readonly<{
    resolveRuntime(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease>;
    resolvePlugin(pluginId: string): Readonly<{
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
    resolveHostOwnedConfiguredOrigins(
        service: PluginContributionRef,
        configuration: PluginConnectedAccountRuntimeConfiguration,
    ): MaybePromise<readonly string[]>;
}>): ConnectedAccountHostRuntimeInvoker {
    async function createContext(input: ConnectedAccountRuntimeAuthenticationInvocation): Promise<Readonly<{
        lease: ConnectedAccountRuntimeLease;
        context: PluginConnectedAccountAuthenticationContext;
    }>> {
        const lease = await params.resolveRuntime(input.admission.service);
        if (
            lease.generation !== input.admission.generation
            || lease.immutableGenerationId !== input.admission.immutableGenerationId
            || !sameService(lease.ref, input.admission.service)
        ) {
            throw new Error('Connected-account runtime admission is no longer current');
        }
        const plugin = params.resolvePlugin(lease.ref.pluginId);
        if (!plugin) {
            throw new Error('Connected-account plugin package identity is unavailable');
        }
        const signal = input.signal ?? new AbortController().signal;
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
            isGenerationCurrent: () => !signal.aborted && lease.isCurrent(),
        });
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
            const resolution = await resolveConnectedAccountConfiguredOrigins({
                pluginId: lease.ref.pluginId,
                service: lease.ref,
                generation: lease.generation,
                configuration: input.context.configuration,
                hostAccessRequests: resolveHostAccessEntries(
                    plugin.hostAccessRequests,
                    policy,
                ),
                resolveHostOwnedConfiguredOrigins: async (configuration) => (
                    await params.resolveHostOwnedConfiguredOrigins(lease.ref, configuration)
                ),
                isConfigurationCurrent: input.isConfigurationCurrent,
                isGenerationCurrent: () => lease.isCurrent(),
            });
            serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
        }
        const services = params.createServices(seed, serviceBinding);
        const context: PluginConnectedAccountAuthenticationContext = Object.freeze({
            plugin: seed.plugin,
            contribution: seed.contribution,
            surface: seed.surface,
            signal,
            services,
            ui: createPluginInvocationUi({
                currentSession: null,
                signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            }),
            ...input.context,
        });
        return Object.freeze({ lease, context });
    }

    function assertSameAccount(
        left: ConnectedAccountRuntimeEstablishedTarget['account'],
        right: ConnectedAccountRuntimeEstablishedTarget['account'],
    ): void {
        if (
            !sameService(left.service, right.service)
            || left.accountId !== right.accountId
        ) {
            throw new Error('Connected-account established context does not match its exact target');
        }
    }

    async function createEstablishedContext(
        input: ConnectedAccountRuntimeEstablishedInvocation,
    ): Promise<Readonly<{
        lease: ConnectedAccountRuntimeLease;
        context: PluginConnectedAccountReadContext;
        assertCurrent(): Promise<void>;
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
        const plugin = params.resolvePlugin(lease.ref.pluginId);
        if (!plugin || !sameService(lease.ref, input.target.account.service)) {
            throw new Error('Connected-account established runtime is unavailable');
        }
        const signal = input.signal ?? new AbortController().signal;
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
            isGenerationCurrent: () => !signal.aborted && lease.isCurrent(),
        });
        const assertCurrent = async (): Promise<void> => {
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
                throw new Error('Connected-account established runtime target is no longer current');
            }
        };
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
            const resolution = await resolveConnectedAccountConfiguredOrigins({
                pluginId: lease.ref.pluginId,
                service: lease.ref,
                generation: lease.generation,
                configuration: input.context.configuration,
                hostAccessRequests: resolveHostAccessEntries(
                    plugin.hostAccessRequests,
                    policy,
                ),
                resolveHostOwnedConfiguredOrigins: async (configuration) => (
                    await params.resolveHostOwnedConfiguredOrigins(lease.ref, configuration)
                ),
                isConfigurationCurrent: input.isConfigurationCurrent,
                isGenerationCurrent: () => lease.isCurrent(),
            });
            serviceBinding = bindConnectedAccountConfiguredOrigins(serviceBinding, resolution);
        }
        await assertCurrent();
        const services = params.createServices(seed, serviceBinding);
        const credentials: PluginConnectedAccountCredentialReader = Object.freeze({
            async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                const value = await input.context.credentials.get(key, options);
                await assertCurrent();
                return value;
            },
        });
        const configuration: PluginConnectedAccountRuntimeConfiguration = Object.freeze({
            ...input.context.configuration,
            async getSecret(fieldId, options) {
                await assertCurrent();
                const value = await input.context.configuration.getSecret(fieldId, options);
                await assertCurrent();
                return value;
            },
        });
        const context: PluginConnectedAccountReadContext = Object.freeze({
            plugin: seed.plugin,
            contribution: seed.contribution,
            surface: seed.surface,
            signal,
            services,
            ui: createPluginInvocationUi({
                currentSession: null,
                signal,
                isGenerationCurrent: seed.isGenerationCurrent,
            }),
            account: input.context.account,
            configuration,
            credentials,
        });
        return Object.freeze({ lease, context, assertCurrent });
    }

    function guardStagedCredentials(
        source: PluginConnectedAccountCredentialStore,
        assertCurrent: () => Promise<void>,
    ): PluginConnectedAccountCredentialStore {
        return Object.freeze({
            async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                await assertCurrent();
                const value = await source.get(key, options);
                await assertCurrent();
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
            const { lease, context } = invocationContext;
            const mode = lease.runtime.authentication.modes[input.admission.modeId];
            if (!mode || mode.kind !== input.admission.descriptor.kind) {
                return authenticationUnavailable(
                    'connected_account_authentication_mode_unavailable',
                );
            }
            const options = input.signal ? { signal: input.signal } : undefined;
            switch (input.operation.kind) {
                case 'beginOAuth':
                    if (mode.kind !== 'oauthAuthorizationCode') break;
                    return await mode.begin(input.operation.request, context, options);
                case 'beginDevice':
                    if (mode.kind !== 'oauthDeviceCode') break;
                    return await mode.begin(context, options);
                case 'submitManual':
                    if (mode.kind !== 'manual') break;
                    return await mode.complete(
                        Object.freeze({ fields: input.operation.fields }),
                        context,
                        options,
                    );
                case 'completeOAuth':
                    if (mode.kind !== 'oauthAuthorizationCode') break;
                    return await mode.complete(input.operation.completion, context, options);
                case 'pollDevice':
                    if (mode.kind !== 'oauthDeviceCode') break;
                    return await mode.poll(context, options);
                case 'reconcile':
                    if (typeof mode.reconcile !== 'function') break;
                    return await mode.reconcile(context, options);
                case 'cancel':
                    if (mode.kind === 'manual') return undefined;
                    return await mode.cancel(context);
            }
            return authenticationUnavailable(
                'connected_account_authentication_operation_unavailable',
            );
        },
        async invokeEstablished<
            TOperation extends ConnectedAccountRuntimeEstablishedOperation,
        >(
            input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
            const { lease, context, assertCurrent } = await createEstablishedContext(input);
            const options = input.signal ? { signal: input.signal } : undefined;
            let result: unknown;
            switch (input.operation.kind) {
                case 'refresh':
                    result = await lease.runtime.refresh(Object.freeze({
                        ...context,
                        operation: Object.freeze({
                            operationId: input.operation.operationId,
                            configurationRevision:
                                input.target.expectedRuntimeConfigurationRevision,
                        }),
                        stagedCredentials: guardStagedCredentials(
                            input.operation.stagedCredentials,
                            assertCurrent,
                        ),
                    }), options);
                    break;
                case 'status':
                    result = await lease.runtime.status(context, options);
                    break;
                case 'quota':
                    result = lease.runtime.quota
                        ? await lease.runtime.quota(context, options)
                        : null;
                    break;
                case 'revoke':
                    result = await lease.runtime.revoke(context, options);
                    break;
                case 'materialize':
                    result = await lease.runtime.materialize(
                        input.operation.request,
                        context,
                        options,
                    );
                    break;
            }
            await assertCurrent();
            return result as ConnectedAccountRuntimeEstablishedResult<TOperation>;
        },
    });
}
