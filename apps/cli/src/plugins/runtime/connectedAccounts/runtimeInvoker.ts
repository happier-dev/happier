import { randomUUID } from 'node:crypto';
import { createSensitiveDiagnosticTextRedactor } from '@happier-dev/protocol/bugs/reports/redaction';
import { logger } from '@/ui/logger';
import { createConnectedAccountEstablishedRuntimeDispatcher, invokeConnectedAccountAuthenticationRuntime } from '@happier-dev/cli-common/connectedAccounts';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from '@/daemon/connectedServices/materialize/materializationPhase';

import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import {
    type ConnectedAccountCredentialStore as PluginConnectedAccountCredentialStore,
    type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
    type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
    type ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountPortableAuthenticationContext, ConnectedAccountPortableReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    type PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import { createPluginInvocationPresentation } from '@/plugins/runtime/invocation/services/interactions';
import type {
    PluginInvocationServicesSeed,
    PluginInvocationServiceBinding,
} from '@/plugins/runtime/invocation/services/types';
import {
    createPluginInvocationLifetime,
    type PluginInvocationLifetime,
} from '@/plugins/runtime/invocation/lifetime';
import type {
    ResolvePluginInvocationHostPolicy,
} from '@/plugins/runtime/hostAccess/resolve';

import type {
    ConnectedAccountAttemptProviderInvocation,
} from '@happier-dev/cli-common/connectedAccounts';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    type ConnectedAccountRuntimeLease,
    type ConnectedAccountHostRuntimeLease,
    type ConnectedAccountPluginRuntimeLease,
    type ConnectedAccountPortableRuntimeLease,
} from './contributionRegistry';
import type {
    HostConnectedAccountAuthenticationContext, HostConnectedAccountReadContext,
} from './hostRuntime';

type MaybePromise<T> = T | Promise<T>;
type PluginConnectedAccountReadContext =
    Parameters<PluginConnectedAccountRuntime['status']>[0];
type ConnectedAccountCredentialReader =
    PluginConnectedAccountReadContext['credentials'];
type ConnectedAccountCallbackCurrentnessPhase = 'beforeCallback' | 'afterCallback';
type InvocationContext<Context, Lease> = Readonly<{
    lease: Lease;
    context: Context;
    registerRawForRedaction(value: string): void;
    redactDiagnosticText?(value: string): string;
    assertCurrent(phase?: ConnectedAccountCallbackCurrentnessPhase): Promise<void>;
    lifetime: PluginInvocationLifetime;
}>;
type AuthenticationInvocationContext =
    | (InvocationContext<HostConnectedAccountAuthenticationContext, ConnectedAccountHostRuntimeLease> & { owner: 'host' })
    | (InvocationContext<ConnectedAccountPortableAuthenticationContext, ConnectedAccountPortableRuntimeLease> & { owner: 'portable' })
    | (InvocationContext<PluginConnectedAccountAuthenticationContext, ConnectedAccountPluginRuntimeLease> & { owner: 'plugin' });
type EstablishedInvocationContext =
    | (InvocationContext<HostConnectedAccountReadContext, ConnectedAccountHostRuntimeLease> & { owner: 'host' })
    | (InvocationContext<ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntimeLease> & { owner: 'portable' })
    | (InvocationContext<PluginConnectedAccountReadContext, ConnectedAccountPluginRuntimeLease> & { owner: 'plugin' });

export type ConnectedAccountRuntimeAuthenticationInvocation =
    ConnectedAccountAttemptProviderInvocation & Readonly<{
        /** The host retains the admitted executable; portable attempt custody is host agnostic. */
        lease?: ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease;
        isConfigurationCurrent(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): MaybePromise<boolean>;
        configurationRevocationSignal?(
            configuration: PluginConnectedAccountRuntimeConfiguration,
        ): AbortSignal | undefined;
    }>;

export type { ConnectedAccountRuntimeEstablishedTarget, ConnectedAccountRuntimeEstablishedOperation, ConnectedAccountRuntimeEstablishedInvocation } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountRuntimeEstablishedOperation, ConnectedAccountRuntimeEstablishedInvocation, ConnectedAccountRuntimeEstablishedResult as PortableEstablishedResult } from '@happier-dev/cli-common/connectedAccounts';

export type ConnectedAccountRuntimeEstablishedResult<TOperation extends ConnectedAccountRuntimeEstablishedOperation> = PortableEstablishedResult<TOperation, Awaited<ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>>>;

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
    resolveRuntime(ref: PluginContributionRef): Promise<ConnectedAccountRuntimeLease | ConnectedAccountPortableRuntimeLease | null>;
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
    ): PluginConnectedAccountReadContext['services'];
    registerRawForRedaction(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): void;
    redactDiagnosticText?(
        seed: PluginInvocationServicesSeed,
        value: string,
    ): string;
}>): ConnectedAccountHostRuntimeInvoker {
    const { assertEstablishedTarget, assertEstablishedAuthorityCurrent, assertEstablishedFenceCurrent, invokeCurrentConnectedAccountCallback, guardStagedCredentials, invokeEstablishedRuntime } = createConnectedAccountEstablishedRuntimeDispatcher({
        observePhase: observeMaterializationPhase,
        onRecoveryCreditsUnavailable: service => logger.info('[ConnectedAccounts] recovery credit inventory unavailable', { service }),
    });
    function hostRedaction(lifetime: PluginInvocationLifetime) {
        const redactor = createSensitiveDiagnosticTextRedactor();
        return Object.freeze({
            registerRawForRedaction(value: string) {
                const lease = redactor.register([value]);
                lifetime.retainCleanup({ async dispose() { lease.close(); } });
            },
            redactDiagnosticText: redactor.redact,
        });
    }

    function guardConfiguration(
        source: PluginConnectedAccountRuntimeConfiguration,
        assertCurrent: () => Promise<void>,
        register: (value: string) => void,
    ): PluginConnectedAccountRuntimeConfiguration {
        return Object.freeze({ ...source, async getSecret(fieldId, options) {
            await assertCurrent();
            const value = await source.getSecret(fieldId, options);
            await assertCurrent();
            if (value !== null) register(value);
            return value;
        } });
    }

    async function createContext(input: ConnectedAccountRuntimeAuthenticationInvocation): Promise<AuthenticationInvocationContext> {
        const lease = input.lease
            ?? await params.resolveRuntime(input.admission.service);
        if (!lease) {
            throw new Error('Connected-account runtime is unavailable');
        }
        if (!sameService(lease.ref, input.admission.service)) {
            throw new Error('Connected-account runtime does not match the captured service');
        }
        if (lease.owner === 'host') {
            const lifetime = createPluginInvocationLifetime(input.signal);
            const redaction = hostRedaction(lifetime);
            const assertCurrent = async () => {
                if (lifetime.signal.aborted) throw lifetime.signal.reason ?? new Error('Connected-account authentication was aborted');
                if (!await input.isConfigurationCurrent(input.context.configuration)) {
                    throw new Error('Connected-account authentication configuration is no longer current');
                }
            };
            const context: HostConnectedAccountAuthenticationContext = Object.freeze({
                ...input.context,
                signal: lifetime.signal, invokedAtMs: lifetime.invokedAtMs,
                configuration: guardConfiguration(input.context.configuration, assertCurrent, redaction.registerRawForRedaction),
                attemptCredentials: guardStagedCredentials(input.context.attemptCredentials, assertCurrent, redaction.registerRawForRedaction),
                async stageAccountConfiguration(replacement) {
                    await assertCurrent();
                    const stage = input.context.stageAccountConfiguration;
                    if (!stage) throw new Error('Host account configuration staging is unavailable');
                    for (const value of Object.values(replacement.secretValues ?? {})) redaction.registerRawForRedaction(value);
                    await stage(replacement);
                    await assertCurrent();
                },
            });
            return Object.freeze({ owner: 'host', lease, context, ...redaction, assertCurrent, lifetime });
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
            occurrenceId: lease.occurrenceId,
            sourceCustody: lease.sourceCustody,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            // The daemon retains the registry lease through this invocation.
            // Reload publication does not retire an already-entered auth flow.
            isOccurrenceCurrent: () => !signal.aborted,
        });
        const assertCurrent = async (
            _phase: ConnectedAccountCallbackCurrentnessPhase = 'afterCallback',
        ): Promise<void> => {
            if (signal.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error('Connected-account authentication operation was aborted');
            }
            if (!await input.isConfigurationCurrent(input.context.configuration)) {
                throw new Error('Connected-account authentication runtime is no longer current');
            }
        };
        try {
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                occurrenceId: lease.occurrenceId,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const configurationRevocationSignal = input.configurationRevocationSignal?.(input.context.configuration);
            const serviceBinding = configurationRevocationSignal === undefined ? policy.serviceBinding : Object.freeze({
                ...policy.serviceBinding, networkRevocationSignal: configurationRevocationSignal,
            });
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
            const portableContext: ConnectedAccountPortableAuthenticationContext = Object.freeze({
                plugin: seed.plugin,
                contribution: seed.contribution,
                surface: seed.surface,
                invokedAtMs: lifetime.invokedAtMs,
                signal,
                services: Object.freeze({ http: services.http }),
                ...input.context,
                configuration,
                attemptCredentials,
            });
            const redaction = {
                registerRawForRedaction: (value: string) => params.registerRawForRedaction(seed, value),
                ...(params.redactDiagnosticText ? { redactDiagnosticText: (value: string) => params.redactDiagnosticText!(seed, value) } : {}),
            };
            if (lease.realm === 'account') return Object.freeze({
                owner: 'portable', lease, context: portableContext, assertCurrent, lifetime, ...redaction,
            });
            const context: PluginConnectedAccountAuthenticationContext = Object.freeze({
                ...portableContext,
                services,
                ui: createPluginInvocationPresentation({
                    currentSession: null,
                    signal,
                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
                }),
            });
            return Object.freeze({ owner: 'plugin', lease, context, assertCurrent, lifetime,
                ...redaction,
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    async function createEstablishedContext(
        input: ConnectedAccountRuntimeEstablishedInvocation,
    ): Promise<EstablishedInvocationContext> {
        assertEstablishedTarget(input);

        const lease = await observeMaterializationPhase('runtime_registry', () => params.resolveRuntime(input.target.account.service));
        if (lease?.owner === 'host') {
            if (!sameService(lease.ref, input.target.account.service)) throw new Error('Connected-account established runtime is unavailable');
            const lifetime = createPluginInvocationLifetime(input.signal);
            const redaction = hostRedaction(lifetime);
            const assertCurrent = (phase?: ConnectedAccountCallbackCurrentnessPhase) =>
                assertEstablishedFenceCurrent(input, lease, lifetime.signal, phase);
            try {
                await assertEstablishedAuthorityCurrent(input, lease, lifetime.signal);
                const context: HostConnectedAccountReadContext = Object.freeze({
                    ...input.context,
                    signal: lifetime.signal, invokedAtMs: lifetime.invokedAtMs,
                    configuration: guardConfiguration(input.context.configuration, assertCurrent, redaction.registerRawForRedaction),
                    credentials: Object.freeze({ async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
                        await assertCurrent();
                        const value = await input.context.credentials.get(key, options);
                        await assertCurrent();
                        if (value !== null) redaction.registerRawForRedaction(value);
                        return value;
                    } }),
                });
                return Object.freeze({
                    owner: 'host', lease, context, ...redaction,
                    assertCurrent, lifetime,
                });
            } catch (error) {
                await lifetime.complete();
                throw error;
            }
        }
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
            occurrenceId: lease.occurrenceId,
            sourceCustody: lease.sourceCustody,
            correlationId: randomUUID(),
            surface: 'cli',
            signal,
            redactionLifetimeSignal: lifetime.redactionLifetimeSignal,
            isOccurrenceCurrent: () => !signal.aborted && lease.isCurrent(),
        });
        const assertCurrent = (phase?: ConnectedAccountCallbackCurrentnessPhase) =>
            assertEstablishedFenceCurrent(input, lease, signal, phase);
        try {
            await assertEstablishedAuthorityCurrent(input, lease, signal);
            const policy = params.resolveHostPolicy({
                pluginId: lease.ref.pluginId,
                occurrenceId: lease.occurrenceId,
                qualifiedId,
            }, {
                hostAccessRequests: plugin.hostAccessRequests,
                surface: 'cli',
                signal,
            });
            const configurationRevocationSignal = input.configurationRevocationSignal?.(input.context.configuration);
            const serviceBinding = configurationRevocationSignal === undefined ? policy.serviceBinding : Object.freeze({
                ...policy.serviceBinding, networkRevocationSignal: configurationRevocationSignal,
            });
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
            if ('realm' in lease && lease.realm === 'account') {
                const context: ConnectedAccountPortableReadContext = Object.freeze({
                    plugin: seed.plugin,
                    contribution: seed.contribution,
                    surface: seed.surface,
                    invokedAtMs: lifetime.invokedAtMs,
                    signal,
                    services: Object.freeze({ http: services.http }),
                    account: input.context.account,
                    configuration,
                    credentials,
                });
                return Object.freeze({
                    owner: 'portable', lease, context, assertCurrent, lifetime,
                    registerRawForRedaction: (value: string) => params.registerRawForRedaction(seed, value),
                    ...(params.redactDiagnosticText ? { redactDiagnosticText: (value: string) => params.redactDiagnosticText!(seed, value) } : {}),
                });
            }
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
                    isOccurrenceCurrent: seed.isOccurrenceCurrent,
                }),
                account: input.context.account,
                configuration,
                credentials,
            });
            return Object.freeze({
                owner: 'plugin', lease, context, assertCurrent, lifetime,
                registerRawForRedaction: (value: string) => params.registerRawForRedaction(seed, value),
                ...(params.redactDiagnosticText ? { redactDiagnosticText: (value: string) => params.redactDiagnosticText!(seed, value) } : {}),
            });
        } catch (error) {
            lifetime.complete();
            throw error;
        }
    }

    return Object.freeze({
        async invokeAuthentication(input) {
            let invocation: AuthenticationInvocationContext;
            try {
                invocation = await createContext(input);
            } catch (error) {
                if (error instanceof ConnectedAccountRuntimeInvocationNotStartedError) throw error;
                return authenticationUnavailable('connected_account_producer_context_unavailable');
            }
            try {
                const common = {
                    descriptor: input.admission.descriptor,
                    operation: input.operation,
                    ...(input.signal ? { signal: input.signal } : {}),
                    registerRawForRedaction: invocation.registerRawForRedaction,
                    invokeCallback: <Result>(work: () => Result | Promise<Result>) =>
                        invokeCurrentConnectedAccountCallback(invocation.assertCurrent, work),
                    ...(invocation.redactDiagnosticText ? { redactDiagnosticText: invocation.redactDiagnosticText } : {}),
                };
                const output = invocation.owner === 'host'
                    ? await invokeConnectedAccountAuthenticationRuntime({ ...common,
                        mode: invocation.lease.runtime.authentication.modes[input.admission.modeId], context: invocation.context })
                    : invocation.owner === 'portable' ? await invokeConnectedAccountAuthenticationRuntime({ ...common,
                        mode: invocation.lease.runtime.authentication.modes[input.admission.modeId], context: invocation.context })
                    : await invokeConnectedAccountAuthenticationRuntime({ ...common,
                        mode: invocation.lease.runtime.authentication.modes[input.admission.modeId], context: invocation.context });
                await invocation.assertCurrent();
                return output;
            } finally {
                await invocation.lifetime.complete();
            }
        },
        async invokeEstablished<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(
            input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>,
        ): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation>> {
            const invocation = await createEstablishedContext(input);
            try {
                return invocation.owner === 'host'
                    ? await invokeEstablishedRuntime(
                        invocation.lease.runtime, invocation.lease.descriptor, invocation.context,
                        input, invocation.registerRawForRedaction, invocation.assertCurrent,
                        invocation.redactDiagnosticText,
                    )
                    : invocation.owner === 'portable' ? await invokeEstablishedRuntime(
                        invocation.lease.runtime, invocation.lease.descriptor, invocation.context,
                        input, invocation.registerRawForRedaction, invocation.assertCurrent,
                        invocation.redactDiagnosticText,
                    ) : await invokeEstablishedRuntime(
                        invocation.lease.runtime, invocation.lease.descriptor, invocation.context,
                        input, invocation.registerRawForRedaction, invocation.assertCurrent,
                        invocation.redactDiagnosticText,
                    );
            } finally {
                await invocation.lifetime.complete();
            }
        },
    });
}
