import { describe, expect, it, vi } from 'vitest';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import {
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import {
    encodeRunnerDaemonPluginServiceWireValueV1,
    RunnerDaemonManagedProviderBootstrapV1Schema,
    RunnerDaemonPluginServiceOperationV1Schema,
    type RunnerDaemonPluginServiceOperationV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import {
    EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
} from '@/session/external/hostOperationOwner';
import {
    EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS,
} from '@/session/external/followListenerSettlement';
import {
    prepareRunnerDaemonPluginServices,
} from './runnerDaemonPluginServices';

const daemonWitness = Object.freeze({
    inputId: 'input-1',
    turnId: 'turn-1',
    userMessageSeq: 7,
    userMessageSeqs: Object.freeze([7]),
});
const witness = Object.freeze({
    ...daemonWitness,
    causalPermissionAuthority: Object.freeze({
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'read-only',
    }),
});

function createSeparatelyBundledPluginError(input: Readonly<{
    code: string;
    message: string;
    retryable?: boolean;
}>): Error & Readonly<{
    code: string;
    retryable: boolean;
    data: Readonly<{
        name: 'PluginError';
        code: string;
        message: string;
        retryable?: boolean;
    }>;
}> {
    const retryable = input.retryable ?? false;
    return Object.assign(new Error(input.message), {
        name: 'PluginError',
        code: input.code,
        retryable,
        data: Object.freeze({
            name: 'PluginError' as const,
            code: input.code,
            message: input.message,
            ...(input.retryable === undefined ? {} : { retryable }),
        }),
    });
}

function preparedSnapshot() {
    return {
        availability: {
            storage: { status: 'available' },
            settings: { status: 'available' },
            secrets: {
                status: 'denied',
                code: 'plugin_service_resource_not_selected',
            },
            events: { status: 'available' },
            fetch: { status: 'available' },
            fs: { status: 'available' },
            exec: { status: 'available' },
            actions: { status: 'available' },
            providers: { status: 'available' },
            resources: { status: 'available' },
            mcp: { status: 'available' },
            notifications: { status: 'available' },
            connectedAccounts: { status: 'available' },
        },
        storageConsistency: {
            ephemeral: { kind: 'authoritativeSerializable' },
            daemonSession: { kind: 'authoritativeSerializable' },
            daemon: { kind: 'authoritativeSerializable' },
        },
        settingsDescriptors: {
            account: [],
            daemon: [],
        },
        resourceDescriptors: {},
        subscriptionCapabilities: {
            settingsWatch: true,
            eventSubscriptions: [{
                pluginId: 'fixture.plugin',
                localId: 'changed',
            }],
            resourceWatches: ['prompt'],
            notificationPreferencesWatch: true,
        },
    };
}

function managedProviderBootstrap(
    activationGeneration: string,
) {
    return RunnerDaemonManagedProviderBootstrapV1Schema.parse({
        v: 1,
        scope: {
            v: 1,
            sessionId: 'session-1',
            runtimeBindingBasis: {
                v: 1,
                agentTargetKey: 'fixture.agent',
                connectionId: 'provider-connection-1',
                contributionKey: 'provider.plugin/gateway',
                runtimeCredentialTransport: null,
                prepared: { v: 1, materialization: 'spawnEnv' },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['anthropic'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv',
                    applyPolicy: 'restart_session',
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal',
                    implementationIdentity: {
                        pluginId: 'provider.plugin',
                        localId: 'gateway',
                    },
                    managedRuntime: {
                        kind: 'managed',
                        dependencies: [],
                        endpointTemplateIds: ['messages'],
                        connectedAccounts: [],
                        requestAuthUses: [],
                    },
                    purposeBindings: { v: 1, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: 'messages',
                    protocol: 'anthropic',
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'connection-security',
                    grantFingerprint: 'grant',
                },
            },
            pluginId: 'provider.plugin',
            providerLocalId: 'gateway',
            activationGeneration,
            immutableGenerationId:
                `provider-generation-${activationGeneration}`,
            manifestAuthority: 'external',
            operationClaimId:
                `session-provider-claim-${activationGeneration}`,
        },
        requestAuth: null,
        providerPluginHardRevocationRevisionAtAdmission: 3,
    });
}

describe('runner daemon PluginServices proxy', () => {
    it('preserves runner-local composer content services', async () => {
        const unavailable = createUnavailablePluginServices();
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-composer-content',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions:
                    unavailable.targetedContributions,
            },
        });

        expect(services.availability('composerContent')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(services.composerContent)
            .toBe(unavailable.composerContent);
    });

    it('does not retry a bare service-bag error merely because it has a refusal code', async () => {
        const unavailable = createUnavailablePluginServices();
        const bareRefusal = Object.assign(
            new Error('bare daemon refusal'),
            { code: 'plugin_services_invocation_unavailable' },
        );
        let prepareCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-bare-refusal',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_storage.get_v1') {
                    throw bareRefusal;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.storage.daemon.get('bare-refusal'))
            .rejects.toBe(bareRefusal);
        expect(prepareCount).toBe(1);
    });

    it('reprepares for a separately bundled canonical PluginError refusal', async () => {
        const unavailable = createUnavailablePluginServices();
        const refusal = createSeparatelyBundledPluginError({
            code: 'plugin_services_invocation_unavailable',
            message: 'separately bundled daemon refusal',
        });
        expect(refusal).not.toBeInstanceOf(PluginError);
        expect(isPluginError(refusal)).toBe(true);
        let prepareCount = 0;
        let storageAttempts = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-cross-copy-refusal',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_storage.get_v1') {
                    storageAttempts += 1;
                    if (storageAttempts === 1) throw refusal;
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.storage.daemon.get('cross-copy-refusal'))
            .resolves.toBeNull();
        expect(prepareCount).toBe(2);
        expect(storageAttempts).toBe(2);
    });

    it('acknowledges External Sessions follow listeners before awaiting idempotent disposal', async () => {
        const unavailable = createUnavailablePluginServices();
        let nextCount = 0;
        let closeCount = 0;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        let resolveTerminalAcknowledged!: () => void;
        const terminalAcknowledged = new Promise<void>((resolve) => {
            resolveTerminalAcknowledged = resolve;
        });
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_sessions.external.follow_transcript.open_v1'
            ) {
                return {
                    status: 'opening',
                };
            }
            if (
                operation.kind
                === 'plugin_services.subscription.next_v1'
            ) {
                nextCount += 1;
                if (nextCount === 1) {
                    expect(Reflect.get(
                        operation,
                        'acknowledgement',
                    )).toBeUndefined();
                    return {
                        kind:
                            'plugin_sessions.external.follow_transcript.event_v1',
                        invocationId: 'invocation-external-follow',
                        subscriptionId: operation.subscriptionId,
                        event:
                            encodeRunnerDaemonPluginServiceWireValueV1({
                                kind: 'data',
                                items: [],
                                fromCursor: null,
                                nextCursor: 'cursor-1',
                            }),
                    };
                }
                if (nextCount === 2) {
                    expect(Reflect.get(
                        operation,
                        'acknowledgement',
                    )).toBe('settled');
                    return {
                        kind:
                            'plugin_sessions.external.follow_transcript.opened_v1',
                        invocationId: 'invocation-external-follow',
                        subscriptionId: operation.subscriptionId,
                        result: {
                            status: 'following',
                            startingCursor: 'cursor-1',
                        },
                    };
                }
                if (nextCount === 3) {
                    expect(Reflect.get(
                        operation,
                        'acknowledgement',
                    )).toBe('settled');
                    return null;
                }
                if (nextCount === 4) {
                    expect(Reflect.get(
                        operation,
                        'acknowledgement',
                    )).toBeUndefined();
                    await closeRequested;
                    return {
                        kind:
                            'plugin_sessions.external.follow_transcript.event_v1',
                        invocationId: 'invocation-external-follow',
                        subscriptionId: operation.subscriptionId,
                        event:
                            encodeRunnerDaemonPluginServiceWireValueV1({
                                kind: 'terminated',
                                reason: 'disposed',
                                cursor: 'cursor-1',
                            }),
                    };
                }
                expect(Reflect.get(
                    operation,
                    'acknowledgement',
                )).toBe('settled');
                resolveTerminalAcknowledged();
                throw new PluginError({
                    code: 'plugin_service_subscription_closed',
                    message: 'Subscription closed after acknowledgement',
                });
            }
            if (
                operation.kind
                === 'plugin_services.subscription.close_v1'
            ) {
                closeCount += 1;
                resolveCloseRequested();
                await terminalAcknowledged;
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-follow',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn(async () => undefined);
        const followed = await services.sessions.external
            .followTranscript({
                agentId: 'fixture.agent',
                sourceId: 'source-1',
                remoteSessionId: 'remote-1',
            }, {}, listener);
        if (followed.status !== 'following') {
            throw new Error('Expected External Sessions follow');
        }
        await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());

        let disposalSettled = false;
        const firstDisposal = Promise.resolve(
            followed.subscription.dispose(),
        ).then(() => {
            disposalSettled = true;
        });
        const secondDisposal = Promise.resolve(
            followed.subscription.dispose(),
        );
        await Promise.resolve();
        expect(disposalSettled).toBe(false);

        await expect(firstDisposal).resolves.toBeUndefined();
        await expect(secondDisposal).resolves.toBeUndefined();
        expect(closeCount).toBe(1);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener).toHaveBeenLastCalledWith({
            kind: 'terminated',
            reason: 'disposed',
            cursor: 'cursor-1',
        });
    });

    it('rejects an author follow listener that settles after its five-second deadline instead of wedging acquisition', async () => {
        const unavailable = createUnavailablePluginServices();
        const acknowledgements: Array<string | undefined> = [];
        let closeCount = 0;
        let nextCount = 0;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-listener-deadline',
            signal: new AbortController().signal,
            dispatch: async (operation): Promise<unknown> => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    acknowledgements.push(
                        Reflect.get(operation, 'acknowledgement') as
                            | string
                            | undefined,
                    );
                    if (nextCount === 1) {
                        // A replay event before the acquisition result: the
                        // listener is awaited while `followTranscript()` is
                        // still unsettled.
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.event_v1',
                            invocationId:
                                'invocation-external-listener-deadline',
                            subscriptionId: operation.subscriptionId,
                            event:
                                encodeRunnerDaemonPluginServiceWireValueV1({
                                    kind: 'data',
                                    items: [],
                                    fromCursor: null,
                                    nextCursor: 'cursor-1',
                                }),
                        };
                    }
                    if (nextCount === 2) return null;
                    if (nextCount === 3) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId:
                                'invocation-external-listener-deadline',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'following',
                                startingCursor: 'cursor-1',
                            },
                        };
                    }
                    if (nextCount === 4) return null;
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn(async () => await new Promise<void>((resolve) => {
            setTimeout(
                resolve,
                EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS + 1,
            );
        }));

        vi.useFakeTimers();
        try {
            const followed = services.sessions.external.followTranscript({
                agentId: 'fixture.agent',
                sourceId: 'source-1',
                remoteSessionId: 'remote-1',
            }, {}, listener);
            const observed = followed.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
            );
            let settled = false;
            void observed.finally(() => { settled = true; });

            await vi.advanceTimersByTimeAsync(
                EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS - 1,
            );
            expect(settled).toBe(false);
            expect(acknowledgements).toEqual([undefined]);

            await vi.advanceTimersByTimeAsync(1);
            await expect(followed).rejects.toMatchObject({
                code: 'plugin_external_follow_listener_failed',
            });
            // The deadline is the delivery answer, so the pump acknowledges
            // `rejected` instead of silently never acknowledging at all.
            expect(acknowledgements[1]).toBe('rejected');
            expect(closeCount).toBe(1);
            expect(listener).toHaveBeenCalledOnce();

            // A listener that settles after its author deadline cannot advance
            // delivery or reopen the follow.
            await vi.advanceTimersByTimeAsync(1);
            expect(closeCount).toBe(1);
            expect(listener).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('abandons a pending follow listener when the caller cancels and ignores its late rejection', async () => {
        const unavailable = createUnavailablePluginServices();
        const acknowledgements: Array<string | undefined> = [];
        let closeCount = 0;
        let nextCount = 0;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-listener-abort',
            signal: new AbortController().signal,
            dispatch: async (operation): Promise<unknown> => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    acknowledgements.push(
                        Reflect.get(operation, 'acknowledgement') as
                            | string
                            | undefined,
                    );
                    if (nextCount === 1) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.event_v1',
                            invocationId: 'invocation-external-listener-abort',
                            subscriptionId: operation.subscriptionId,
                            event:
                                encodeRunnerDaemonPluginServiceWireValueV1({
                                    kind: 'data',
                                    items: [],
                                    fromCursor: null,
                                    nextCursor: 'cursor-1',
                                }),
                        };
                    }
                    if (nextCount === 2) return null;
                    if (nextCount === 3) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId: 'invocation-external-listener-abort',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'following',
                                startingCursor: 'cursor-1',
                            },
                        };
                    }
                    if (nextCount === 4) return null;
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const caller = new AbortController();
        let rejectListener!: (error: unknown) => void;
        const listener = vi.fn(async () => await new Promise<void>((_, reject) => {
            rejectListener = reject;
        }));

        vi.useFakeTimers();
        try {
            const followed = services.sessions.external.followTranscript({
                agentId: 'fixture.agent',
                sourceId: 'source-1',
                remoteSessionId: 'remote-1',
            }, { signal: caller.signal }, listener);
            const observed = followed.then(
                (value) => ({ value }),
                (error: unknown) => ({ error }),
            );
            let settled = false;
            void observed.finally(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(listener).toHaveBeenCalledOnce();

            caller.abort();
            // Cancellation is what settles this follow. The clock deliberately
            // never reaches the listener ceiling, so a version that only bounds
            // the callback by its deadline leaves this unsettled.
            await vi.advanceTimersByTimeAsync(
                EXTERNAL_SESSION_FOLLOW_LISTENER_TIMEOUT_MS - 1,
            );
            expect(settled).toBe(true);
            expect(await observed).toEqual({
                value: {
                    status: 'unavailable',
                    code: 'plugin_operation_aborted',
                },
            });
            expect(acknowledgements[1]).toBe('rejected');
            expect(closeCount).toBe(1);

            // An abandoned listener that rejects later must not surface as an
            // unhandled rejection in the runner process.
            rejectListener(new Error('late listener rejection'));
            await vi.advanceTimersByTimeAsync(0);
            expect(listener).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('acknowledges unavailable External Sessions acquisition before closing once', async () => {
        const unavailable = createUnavailablePluginServices();
        let closeCount = 0;
        let resolveAcknowledged!: () => void;
        const acknowledged = new Promise<void>((resolve) => {
            resolveAcknowledged = resolve;
        });
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        let nextCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-unavailable',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    if (nextCount === 1) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId:
                                'invocation-external-unavailable',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'unavailable',
                                code: 'plugin_operation_aborted',
                            },
                        };
                    }
                    if (nextCount === 2) {
                        expect(operation.acknowledgement)
                            .toBe('settled');
                        resolveAcknowledged();
                        return null;
                    }
                    expect(operation.acknowledgement)
                        .toBeUndefined();
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    await acknowledged;
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn();

        await expect(services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, listener)).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_operation_aborted',
        });
        expect(listener).not.toHaveBeenCalled();
        expect(closeCount).toBe(1);
    });

    it('bounds every follow close and detaches the invocation abort listener on each unavailable attempt', async () => {
        const unavailable = createUnavailablePluginServices();
        const invocation = new AbortController();
        const added = vi.spyOn(invocation.signal, 'addEventListener');
        const removed = vi.spyOn(invocation.signal, 'removeEventListener');
        const closeTimeouts: Array<number | null | undefined> = [];
        type SubscriptionState = Readonly<{
            resolveClose: () => void;
            closed: Promise<void>;
        }> & { emitted: boolean };
        const states = new Map<string, SubscriptionState>();
        const stateFor = (subscriptionId: string): SubscriptionState => {
            const existing = states.get(subscriptionId);
            if (existing) return existing;
            let resolveClose!: () => void;
            const closed = new Promise<void>((resolve) => {
                resolveClose = resolve;
            });
            const created: SubscriptionState = Object.assign(
                { emitted: false },
                { resolveClose, closed },
            );
            states.set(subscriptionId, created);
            return created;
        };
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-listener-leak',
            signal: invocation.signal,
            dispatch: async (
                operation,
                options?: Readonly<{
                    signal?: AbortSignal;
                    timeoutMs?: number | null;
                }>,
            ): Promise<unknown> => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    const state = stateFor(operation.subscriptionId);
                    if (operation.acknowledgement === 'settled') return null;
                    if (!state.emitted) {
                        state.emitted = true;
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId:
                                'invocation-external-listener-leak',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'unavailable',
                                code: 'plugin_external_follow_unavailable',
                            },
                        };
                    }
                    await state.closed;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeTimeouts.push(options?.timeoutMs);
                    stateFor(operation.subscriptionId).resolveClose();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        added.mockClear();
        removed.mockClear();

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(services.sessions.external.followTranscript({
                agentId: 'fixture.agent',
                sourceId: 'source-1',
                remoteSessionId: `remote-${attempt}`,
            }, {}, vi.fn())).resolves.toEqual({
                status: 'unavailable',
                code: 'plugin_external_follow_unavailable',
            });
        }

        // A follow that never became a subscription still terminalizes: one
        // abort listener attached, one detached, per attempt. Detaching only on
        // successful disposal accumulated one listener per unavailable attempt
        // on the invocation-scoped signal.
        expect(added).toHaveBeenCalledTimes(3);
        expect(removed).toHaveBeenCalledTimes(3);
        // `timeoutMs: null` waits for the platform default — minutes — not the
        // disposal boundary this subscription promises. The literal ceiling is
        // deliberate: comparing only against the exported constant would pass
        // for any value that constant ever takes.
        expect(closeTimeouts).toHaveLength(3);
        for (const timeoutMs of closeTimeouts) {
            expect(typeof timeoutMs).toBe('number');
            expect(timeoutMs).toBeGreaterThan(0);
            expect(timeoutMs).toBeLessThanOrEqual(10_000);
            expect(timeoutMs)
                .toBe(EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS);
        }
    });

    it('retries the exact same follow close after it fails once', async () => {
        const unavailable = createUnavailablePluginServices();
        let closeCount = 0;
        let emitted = false;
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-close-retry',
            signal: new AbortController().signal,
            dispatch: async (operation): Promise<unknown> => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    if (operation.acknowledgement === 'settled' && emitted) {
                        return null;
                    }
                    if (!emitted) {
                        emitted = true;
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId: 'invocation-external-close-retry',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'following',
                                startingCursor: 'cursor-0',
                            },
                        };
                    }
                    await closed;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    if (closeCount === 1) {
                        throw new PluginError({
                            code: 'plugin_service_transport_failed',
                            message: 'transport failed',
                        });
                    }
                    resolveClosed();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        const followed = await services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, vi.fn());
        if (followed.status !== 'following') {
            throw new Error('expected a following subscription');
        }

        await expect(followed.subscription.dispose()).rejects.toMatchObject({
            code: 'plugin_service_transport_failed',
        });
        // Caching the rejected attempt would make the exact same cleanup
        // permanently unreachable.
        await expect(followed.subscription.dispose()).resolves.toBeUndefined();
        expect(closeCount).toBe(2);
    });

    it('keeps cancelled External Sessions acquisition open until its unavailable result is acknowledged', async () => {
        const unavailable = createUnavailablePluginServices();
        const cancellation = new AbortController();
        let openedSignal: AbortSignal | undefined;
        let acquisitionAcknowledged = false;
        let prematureClose = false;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        let nextCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-cancelled',
            signal: new AbortController().signal,
            dispatch: async (operation, options) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    openedSignal = options?.signal;
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    if (nextCount === 1) {
                        await vi.waitFor(() => {
                            expect(openedSignal?.aborted).toBe(true);
                        });
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId:
                                'invocation-external-cancelled',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'unavailable',
                                code: 'plugin_operation_aborted',
                            },
                        };
                    }
                    if (nextCount === 2) {
                        expect(operation.acknowledgement)
                            .toBe('settled');
                        acquisitionAcknowledged = true;
                        return null;
                    }
                    expect(operation.acknowledgement)
                        .toBeUndefined();
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    prematureClose ||= !acquisitionAcknowledged;
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        const followed = services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, { signal: cancellation.signal }, vi.fn());
        cancellation.abort();

        await expect(followed).resolves.toEqual({
            status: 'unavailable',
            code: 'plugin_operation_aborted',
        });
        expect(acquisitionAcknowledged).toBe(true);
        expect(prematureClose).toBe(false);
    });

    it('acknowledges failed External Sessions acquisition before rejecting and closing once', async () => {
        const unavailable = createUnavailablePluginServices();
        let acquisitionAcknowledged = false;
        let closeCount = 0;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        let nextCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-failed',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    if (nextCount === 1) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId: 'invocation-external-failed',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'failed',
                                code: 'plugin_external_follow_failed',
                                message: 'follow acquisition failed',
                            },
                        };
                    }
                    if (nextCount === 2) {
                        expect(operation.acknowledgement)
                            .toBe('settled');
                        acquisitionAcknowledged = true;
                        return null;
                    }
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    expect(acquisitionAcknowledged).toBe(true);
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, vi.fn())).rejects.toMatchObject({
            code: 'plugin_external_follow_failed',
            message: 'follow acquisition failed',
        });
        expect(acquisitionAcknowledged).toBe(true);
        expect(closeCount).toBe(1);
    });

    it('preserves a separately bundled PluginError when External Sessions follow fails before acquisition', async () => {
        const unavailable = createUnavailablePluginServices();
        const failure = createSeparatelyBundledPluginError({
            code: 'plugin_external_follow_failed',
            message: 'separately bundled follow failure',
        });
        expect(failure).not.toBeInstanceOf(PluginError);
        expect(isPluginError(failure)).toBe(true);
        let closeCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-cross-copy-failure',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    throw failure;
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, vi.fn())).rejects.toBe(failure);
        expect(closeCount).toBe(1);
    });

    it('settles External Sessions acquisition before closing after a pre-open listener rejection', async () => {
        const unavailable = createUnavailablePluginServices();
        let acquisitionAcknowledged = false;
        let prematureClose = false;
        let closeCount = 0;
        let resolveCloseRequested!: () => void;
        const closeRequested = new Promise<void>((resolve) => {
            resolveCloseRequested = resolve;
        });
        let nextCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-pre-open-rejection',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    if (nextCount === 1) {
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.event_v1',
                            invocationId:
                                'invocation-external-pre-open-rejection',
                            subscriptionId: operation.subscriptionId,
                            event:
                                encodeRunnerDaemonPluginServiceWireValueV1({
                                    kind: 'data',
                                    items: [],
                                    fromCursor: null,
                                    nextCursor: 'cursor-rejected',
                                }),
                        };
                    }
                    if (nextCount === 2) {
                        expect(operation.acknowledgement)
                            .toBe('rejected');
                        return null;
                    }
                    if (nextCount === 3) {
                        expect(operation.acknowledgement)
                            .toBeUndefined();
                        return {
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId:
                                'invocation-external-pre-open-rejection',
                            subscriptionId: operation.subscriptionId,
                            result: {
                                status: 'failed',
                                code:
                                    'plugin_external_follow_listener_failed',
                                message:
                                    'External Sessions follow listener rejected delivery',
                            },
                        };
                    }
                    if (nextCount === 4) {
                        expect(operation.acknowledgement)
                            .toBe('settled');
                        acquisitionAcknowledged = true;
                        return null;
                    }
                    await closeRequested;
                    throw new PluginError({
                        code: 'plugin_service_subscription_closed',
                        message: 'Subscription closed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    prematureClose ||= !acquisitionAcknowledged;
                    if (prematureClose) {
                        throw new Error(
                            'CLOSE preceded acquisition acknowledgement',
                        );
                    }
                    resolveCloseRequested();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, vi.fn(async () => {
            throw new Error('author listener rejected');
        }))).rejects.toMatchObject({
            code: 'plugin_external_follow_listener_failed',
        });
        expect(acquisitionAcknowledged).toBe(true);
        expect(prematureClose).toBe(false);
        expect(closeCount).toBe(1);
    });

    it('rejects a duplicate External Sessions acquisition control before exposing a follow', async () => {
        const unavailable = createUnavailablePluginServices();
        let closeCount = 0;
        let nextCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-external-duplicate-opened',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_sessions.external.follow_transcript.open_v1'
                ) {
                    return { status: 'opening' };
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    nextCount += 1;
                    const opened = {
                        kind:
                            'plugin_sessions.external.follow_transcript.opened_v1',
                        invocationId:
                            'invocation-external-duplicate-opened',
                        subscriptionId: operation.subscriptionId,
                        result: {
                            status: 'following',
                            startingCursor: null,
                        },
                    } as const;
                    if (nextCount === 1) return opened;
                    expect(operation.acknowledgement).toBe('settled');
                    return opened;
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    closeCount += 1;
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.sessions.external.followTranscript({
            agentId: 'fixture.agent',
            sourceId: 'source-1',
            remoteSessionId: 'remote-1',
        }, {}, vi.fn())).rejects.toMatchObject({
            code: 'plugin_external_follow_acquisition_invalid',
        });
        expect(closeCount).toBe(1);
    });

    it('requires a strict manifest authority in exact managed Provider custody', () => {
        const bootstrap = managedProviderBootstrap('activation-1');
        expect(bootstrap.scope.manifestAuthority).toBe('external');
        const { manifestAuthority: _authority, ...withoutAuthority } =
            bootstrap.scope;
        expect(RunnerDaemonManagedProviderBootstrapV1Schema.safeParse({
            ...bootstrap,
            scope: withoutAuthority,
        }).success).toBe(false);
        expect(RunnerDaemonManagedProviderBootstrapV1Schema.safeParse({
            ...bootstrap,
            scope: {
                ...bootstrap.scope,
                manifestAuthority: 'plugin-id-inferred',
            },
        }).success).toBe(false);
    });
    it('prepares truthful availability and routes daemon-owned methods through explicit operations', async () => {
        const calls: RunnerDaemonPluginServiceOperationV1[] = [];
        let providerDispatchSignal: AbortSignal | undefined;
        let actionDispatchSignal: AbortSignal | undefined;
        let externalCapabilitiesDispatchSignal: AbortSignal | undefined;
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            calls.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (operation.kind === 'plugin_storage.get_v1') {
                return { owner: 'daemon', key: operation.key };
            }
            if (operation.kind === 'plugin_fetch.request_v1') {
                return {
                    status: 200,
                    finalUrl: operation.request.url,
                    headers: { 'content-type': 'text/plain' },
                    body: new Uint8Array([111, 107]),
                };
            }
            if (operation.kind === 'plugin_providers.invoke_v1') {
                providerDispatchSignal = options?.signal;
                return {
                    status: 'success',
                    connections: [],
                    available: [],
                    availableTruncated: false,
                    discoveryCandidates: [],
                    discoveryCandidatesTruncated: false,
                    localInstallations: [],
                    diagnostics: [],
                    diagnosticsTruncated: false,
                };
            }
            if (operation.kind === 'plugin_actions.execute_v1') {
                actionDispatchSignal = options?.signal;
                return [];
            }
            if (operation.kind === 'plugin_sessions.external.capabilities_v1') {
                externalCapabilitiesDispatchSignal = options?.signal;
                const unavailable = Object.freeze({
                    status: 'unavailable' as const,
                    code: 'plugin_external_sources_unavailable',
                });
                return Object.freeze({
                    list: unavailable,
                    attach: unavailable,
                    takeover: unavailable,
                    transcript: unavailable,
                    follow: unavailable,
                });
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const unavailable = createUnavailablePluginServices();
        const subagent = Object.freeze({
            id: 'subagent-1',
            parentSessionId: 'session-1',
            status: 'running' as const,
            updatedAtMs: 1,
        });
        const canonicalSubagents = Object.freeze({
            capabilities: () => ({
                list: { status: 'available' as const },
                observe: { status: 'available' as const },
                watch: { status: 'available' as const },
            }),
            list: vi.fn(async () => ({ items: [subagent] })),
            get: vi.fn(async (id: string) => (
                id === subagent.id ? subagent : null
            )),
            observe: vi.fn(async () => subagent),
            watch: vi.fn(() => ({ dispose() {} })),
        }) satisfies PluginServices['sessions']['subagents'];
        const canonicalSessions = Object.freeze({
            ...unavailable.sessions,
            subagents: canonicalSubagents,
        });
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            diagnostic: vi.fn(),
        };
        const reboundManagedServices = Object.freeze({
            dependencies: unavailable.managedServices.dependencies,
            supervise: vi.fn(),
        });
        const bindManagedServices = vi.fn(
            () => reboundManagedServices,
        );
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-1',
            signal: new AbortController().signal,
            dispatch,
            readActiveTurnAdmissionWitness: () => witness,
            bindManagedServices,
            local: {
                availability: unavailable.availability,
                logger,
                sessions: canonicalSessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        services.logger.info('retained runner log', {
            owner: 'generation-g',
        });
        services.logger.diagnostic({
            code: 'retained_runner_diagnostic',
            severity: 'warning',
            details: { owner: 'generation-g' },
        });
        expect(() => Reflect.apply(
            services.logger.info,
            services.logger,
            ['invalid fields stay failure-isolated', {
                invalid: undefined,
            }],
        )).not.toThrow();
        await vi.waitFor(() => expect(
            calls.filter((call) =>
                call.kind === 'plugin_logger.write_v1'),
        ).toHaveLength(2));
        expect(services.logger).not.toBe(logger);
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.diagnostic).not.toHaveBeenCalled();
        expect(services.sessions).not.toBe(unavailable.sessions);
        expect(services.sessions.current)
            .toBe(unavailable.sessions.current);
        expect(services.sessions.list)
            .toBe(unavailable.sessions.list);
        expect(services.sessions.get)
            .toBe(unavailable.sessions.get);
        expect(services.sessions.watch)
            .toBe(unavailable.sessions.watch);
        expect(services.sessions.subagents)
            .toBe(canonicalSubagents);
        expect(services.sessions.external)
            .not.toBe(unavailable.sessions.external);
        const externalCapabilitiesController = new AbortController();
        expect(await services.sessions.external.capabilities({
            signal: externalCapabilitiesController.signal,
        })).toEqual({
            list: {
                status: 'unavailable',
                code: 'plugin_external_sources_unavailable',
            },
            attach: {
                status: 'unavailable',
                code: 'plugin_external_sources_unavailable',
            },
            takeover: {
                status: 'unavailable',
                code: 'plugin_external_sources_unavailable',
            },
            transcript: {
                status: 'unavailable',
                code: 'plugin_external_sources_unavailable',
            },
            follow: {
                status: 'unavailable',
                code: 'plugin_external_sources_unavailable',
            },
        });
        expect(externalCapabilitiesDispatchSignal)
            .toBe(externalCapabilitiesController.signal);
        expect(calls.filter((call) =>
            call.kind === 'plugin_sessions.external.capabilities_v1',
        )).toHaveLength(1);
        expect(services.managedServices).toBe(reboundManagedServices);
        expect(bindManagedServices).toHaveBeenCalledWith({
            connectedAccounts: services.connectedAccounts,
            exec: unavailable.exec,
            managedProvider: null,
        });
        expect(services.availability('actions')).toEqual({
            status: 'available',
        });
        expect(services.interactions).toBe(unavailable.interactions);
        expect(services.availability('storage')).toEqual({
            status: 'available',
        });
        expect(services.availability('secrets')).toEqual({
            status: 'denied',
            code: 'plugin_service_resource_not_selected',
        });
        expect(services.availability('providers')).toEqual({
            status: 'available',
        });
        expect(await services.storage.daemon.get('state')).toEqual({
            owner: 'daemon',
            key: 'state',
        });
        await expect(services.storage.daemon.database('index', {
            incumbentQueryFixture: {
                id: 'index-v1',
                run: async () => undefined,
            },
        })).rejects.toMatchObject({
            code: 'daemon_database_unavailable',
        });
        expect(services.storage.account).toBeUndefined();
        expect(await services.http.request({
            url: 'https://example.com/data',
            redirect: 'error',
        })).toEqual({
            status: 200,
            finalUrl: 'https://example.com/data',
            headers: { 'content-type': 'text/plain' },
            body: new Uint8Array([111, 107]),
        });
        const providerCaller = new AbortController();
        await expect(services.providers.connections.describe(
            {},
            { signal: providerCaller.signal },
        )).resolves.toMatchObject({ status: 'success' });
        const subagentCaller = new AbortController();
        await expect(services.sessions.subagents.list({
            parentSessionId: 'session-1',
            signal: subagentCaller.signal,
        })).resolves.toEqual({ items: [subagent] });
        expect(canonicalSubagents.list).toHaveBeenCalledWith({
            parentSessionId: 'session-1',
            signal: subagentCaller.signal,
        });
        const actionCaller = new AbortController();
        await expect(services.actions.execute(
            'session.transcript.get',
            {
                sessionId: 'session-1',
                projection: 'externalShareableV1',
            },
            { signal: actionCaller.signal },
        )).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
        });
        await expect(services.actions.execute(
            { pluginId: 'fixture.plugin', localId: 'private-action' },
            {},
        )).rejects.toMatchObject({
            code: 'plugin_action_generation_private_unavailable',
        });
        expect(providerDispatchSignal).toBe(providerCaller.signal);
        expect(actionDispatchSignal).toBe(actionCaller.signal);
        expect(calls.every((call) => (
            RunnerDaemonPluginServiceOperationV1Schema.safeParse(call).success
        ))).toBe(true);
        expect(calls).toEqual([
            {
                kind: 'plugin_services.prepare_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                witness: daemonWitness,
            },
            {
                kind: 'plugin_logger.write_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                witness: daemonWitness,
                entry: {
                    kind: 'log',
                    level: 'info',
                    message: 'retained runner log',
                    fields: {
                        t: 'object',
                        value: {
                            owner: {
                                t: 'string',
                                value: 'generation-g',
                            },
                        },
                    },
                },
            },
            {
                kind: 'plugin_logger.write_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                witness: daemonWitness,
                entry: {
                    kind: 'diagnostic',
                    data: {
                        code: 'retained_runner_diagnostic',
                        severity: 'warning',
                        details: {
                            t: 'object',
                            value: {
                                owner: {
                                    t: 'string',
                                    value: 'generation-g',
                                },
                            },
                        },
                    },
                },
            },
            {
                kind: 'plugin_sessions.external.capabilities_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                witness: daemonWitness,
            },
            {
                kind: 'plugin_storage.get_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                scope: 'daemon',
                key: 'state',
                witness: daemonWitness,
            },
            {
                kind: 'plugin_fetch.request_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                request: {
                    url: 'https://example.com/data',
                    redirect: 'error',
                },
                witness: daemonWitness,
            },
            {
                kind: 'plugin_providers.invoke_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                operation: 'connections.describe',
                request: { t: 'object', value: {} },
                witness: daemonWitness,
            },
            {
                kind: 'plugin_actions.execute_v1',
                requestId: expect.any(String),
                invocationId: 'invocation-1',
                actionId: 'session.transcript.get',
                input: {
                    t: 'object',
                    value: {
                        projection: {
                            t: 'string',
                            value: 'externalShareableV1',
                        },
                        sessionId: {
                            t: 'string',
                            value: 'session-1',
                        },
                    },
                },
                witness: daemonWitness,
            },
        ]);
    });

    it('routes retained Session Host Event subscriptions through the daemon broker lifecycle', async () => {
        const unavailable = createUnavailablePluginServices();
        let delivered = false;
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            const kind = Reflect.get(operation, 'kind');
            if (kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (kind === 'plugin_events.host.subscribe.open_v1') {
                return null;
            }
            if (kind === 'plugin_services.subscription.next_v1') {
                if (!delivered) {
                    delivered = true;
                    return {
                        kind:
                            'plugin_events.host.subscribe.event_v1',
                        invocationId: 'invocation-host-events',
                        subscriptionId:
                            Reflect.get(operation, 'subscriptionId'),
                        event: {
                            eventId:
                                '@happier/runtime/turn-complete',
                            scope: {
                                kind: 'session',
                                sessionId: 'session-host-events',
                            },
                            payload:
                                encodeRunnerDaemonPluginServiceWireValueV1({
                                    sequence: 1,
                                    sessionId: 'session-host-events',
                                    emittedAtMs: 2,
                                    kind: 'turn-complete',
                                    turnId: 'turn-host-events',
                                }),
                        },
                    };
                }
                return await new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener(
                        'abort',
                        () => reject(options.signal?.reason),
                        { once: true },
                    );
                });
            }
            if (kind === 'plugin_services.subscription.close_v1') {
                return null;
            }
            throw new Error(`Unexpected ${String(kind)}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-host-events',
            signal: new AbortController().signal,
            dispatch,
            readActiveTurnAdmissionWitness: () => witness,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const received: unknown[] = [];

        const subscription = services.events.host.subscribe({
            eventId: '@happier/runtime/turn-complete',
            scope: {
                kind: 'session',
                sessionId: 'session-host-events',
            },
        }, async (event) => {
            received.push(event);
        });
        await vi.waitFor(() => expect(received).toHaveLength(1));
        await subscription.dispose();

        expect(received).toEqual([{
            eventId: '@happier/runtime/turn-complete',
            scope: {
                kind: 'session',
                sessionId: 'session-host-events',
            },
            payload: {
                sequence: 1,
                sessionId: 'session-host-events',
                emittedAtMs: 2,
                kind: 'turn-complete',
                turnId: 'turn-host-events',
            },
        }]);
        expect(dispatch.mock.calls.map(([operation]) =>
            Reflect.get(operation, 'kind'))).toEqual([
            'plugin_services.prepare_v1',
            'plugin_events.host.subscribe.open_v1',
            'plugin_services.subscription.next_v1',
            'plugin_services.subscription.next_v1',
            'plugin_services.subscription.close_v1',
        ]);
    });

    it.each([
        {
            name: 'a different explicit Session',
            deliveryScope: {
                kind: 'session' as const,
                sessionId: 'session-other',
            },
            payloadSessionId: 'session-other',
        },
        {
            name: 'Account scope for a runtime event',
            deliveryScope: { kind: 'account' as const },
            payloadSessionId: 'session-host-events',
        },
    ])('rejects a retained runtime Host Event delivered for $name', async ({
        deliveryScope,
        payloadSessionId,
    }) => {
        const unavailable = createUnavailablePluginServices();
        let nextCount = 0;
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (operation.kind === 'plugin_events.host.subscribe.open_v1') {
                return null;
            }
            if (operation.kind === 'plugin_services.subscription.next_v1') {
                nextCount += 1;
                if (nextCount > 1) return Object.freeze({ invalid: true });
                return {
                    kind: 'plugin_events.host.subscribe.event_v1',
                    invocationId: 'invocation-host-events-mismatch',
                    subscriptionId: operation.subscriptionId,
                    event: {
                        eventId: '@happier/runtime/turn-complete',
                        scope: deliveryScope,
                        payload: encodeRunnerDaemonPluginServiceWireValueV1({
                            sequence: 1,
                            sessionId: payloadSessionId,
                            emittedAtMs: 2,
                            kind: 'turn-complete',
                            turnId: 'turn-host-events',
                        }),
                    },
                };
            }
            if (operation.kind === 'plugin_services.subscription.close_v1') {
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-host-events-mismatch',
            signal: new AbortController().signal,
            dispatch,
            readActiveTurnAdmissionWitness: () => witness,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn();

        const subscription = services.events.host.subscribe({
            eventId: '@happier/runtime/turn-complete',
            scope: {
                kind: 'session',
                sessionId: 'session-host-events',
            },
        }, listener);

        await vi.waitFor(() => {
            expect(operations.some((operation) =>
                operation.kind === 'plugin_services.subscription.close_v1')).toBe(true);
        });
        expect(listener).not.toHaveBeenCalled();
        subscription.dispose();
    });

    it('returns the canonical parsed Action output after the daemon wire boundary', async () => {
        const unavailable = createUnavailablePluginServices();
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-action-output',
            signal: new AbortController().signal,
            readActiveTurnAdmissionWitness: () => witness,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_actions.execute_v1') {
                    return { owner: 'current-daemon' };
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices:
                    unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        const output = await services.actions.execute(
            'session.list',
            {},
        );

        expect(output).toEqual({ owner: 'current-daemon' });
        expect(Object.getPrototypeOf(output)).toBeNull();
    });

    it('binds the exact managed Provider bootstrap and refreshes it without replaying an ambiguous child effect', async () => {
        const unavailable = createUnavailablePluginServices();
        const reboundManagedServices = Object.freeze({
            dependencies: unavailable.managedServices.dependencies,
            supervise: vi.fn(),
        });
        const bindInputs: Array<Readonly<{
            connectedAccounts: PluginServices['connectedAccounts'];
            exec: PluginServices['exec'];
            managedProvider: Readonly<{
                bootstrap: ReturnType<
                    typeof managedProviderBootstrap
                >;
                connectedAccounts:
                    PluginServices['connectedAccounts'];
                exec: PluginServices['exec'];
                isCurrent(): boolean;
            }> | null;
        }>> = [];
        let prepareCount = 0;
        const prepareRetentions: unknown[] = [];
        let storageAttempts = 0;
        const connectedAccountScopes: Array<
            'agent' | 'managedProvider'
        > = [];
        const managedProviderStarts: unknown[] = [];
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-managed-provider',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    if (prepareCount === 2) {
                        expect(
                            bindInputs[0]?.managedProvider?.isCurrent(),
                        ).toBe(true);
                    }
                    prepareRetentions.push(
                        operation.managedProviderRetention,
                    );
                    return {
                        ...preparedSnapshot(),
                        managedProvider:
                            managedProviderBootstrap(
                                prepareCount <= 2 ? '1' : '2',
                            ),
                    };
                }
                if (
                    operation.kind
                    === 'plugin_connected_accounts.get_binding_v1'
                ) {
                    connectedAccountScopes.push(
                        operation.serviceScope
                            ?? 'agent',
                    );
                    return null;
                }
                if (
                    operation.kind
                    === 'plugin_services.managed_provider.start_v1'
                ) {
                    expect(bindInputs).toHaveLength(
                        managedProviderStarts.length + 1,
                    );
                    managedProviderStarts.push(operation.retained);
                    return null;
                }
                if (operation.kind === 'plugin_storage.get_v1') {
                    storageAttempts += 1;
                    if (
                        storageAttempts === 1
                        || storageAttempts === 3
                    ) {
                        throw new PluginError({
                            code:
                                'plugin_services_invocation_unavailable',
                            message:
                                'Daemon successor requires reprepare',
                        });
                    }
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            bindManagedServices(input) {
                bindInputs.push(input);
                return reboundManagedServices;
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        expect(bindInputs).toHaveLength(1);
        expect(managedProviderStarts).toHaveLength(1);
        expect(bindInputs[0]?.managedProvider?.bootstrap.scope
            .activationGeneration).toBe('1');
        expect(bindInputs[0]?.managedProvider?.isCurrent())
            .toBe(true);
        await services.connectedAccounts.getBinding('agent-purpose');
        await bindInputs[0]?.managedProvider?.connectedAccounts
            .getBinding('provider-purpose');
        expect(connectedAccountScopes).toEqual([
            'agent',
            'managedProvider',
        ]);

        await services.storage.daemon.get('rotate-authority');
        expect(storageAttempts).toBe(2);
        expect(prepareRetentions[0]).toBeUndefined();
        expect(prepareRetentions[1]).toEqual({
            v: 1,
            scope: bindInputs[0]?.managedProvider?.bootstrap.scope,
            providerPluginHardRevocationRevisionAtAdmission: 3,
        });
        expect(JSON.stringify(prepareRetentions[1]))
            .not.toContain('capabilityPath');
        expect(bindInputs).toHaveLength(2);
        expect(managedProviderStarts).toHaveLength(2);
        expect(bindInputs[0]?.managedProvider?.isCurrent())
            .toBe(false);
        expect(bindInputs[1]?.managedProvider?.bootstrap.scope
            .activationGeneration).toBe('1');
        expect(bindInputs[1]?.managedProvider?.isCurrent())
            .toBe(true);

        await expect(
            services.storage.daemon.get('reject-current-q'),
        ).rejects.toMatchObject({
            code:
                'plugin_services_managed_provider_retention_mismatch',
        });
        expect(bindInputs).toHaveLength(2);
        expect(bindInputs[1]?.managedProvider?.isCurrent())
            .toBe(false);
    });

    it('keeps the retained managed Provider current when a successor returns an invalid preparation snapshot', async () => {
        const unavailable = createUnavailablePluginServices();
        const bindingCurrentness: Array<() => boolean> = [];
        let prepareCount = 0;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-invalid-successor-prepare',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    if (prepareCount === 2) {
                        return {
                            ...preparedSnapshot(),
                            managedProvider: { invalid: true },
                        };
                    }
                    return {
                        ...preparedSnapshot(),
                        managedProvider: managedProviderBootstrap('1'),
                    };
                }
                if (
                    operation.kind
                    === 'plugin_services.managed_provider.start_v1'
                ) {
                    return null;
                }
                if (operation.kind === 'plugin_storage.get_v1') {
                    throw new PluginError({
                        code: 'plugin_services_invocation_unavailable',
                        message:
                            'Daemon successor requires reprepare',
                    });
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            bindManagedServices(input) {
                if (input.managedProvider) {
                    bindingCurrentness.push(
                        input.managedProvider.isCurrent,
                    );
                }
                return unavailable.managedServices;
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        expect(bindingCurrentness).toHaveLength(1);
        expect(bindingCurrentness[0]?.()).toBe(true);
        await expect(
            services.storage.daemon.get('invalid-successor-prepare'),
        ).rejects.toMatchObject({
            code: 'plugin_services_prepare_invalid',
        });
        expect(bindingCurrentness).toHaveLength(1);
        expect(bindingCurrentness[0]?.()).toBe(true);
    });

    it('returns the decoded managed Provider Agent materialization unchanged', async () => {
        const unavailable = createUnavailablePluginServices();
        const bootstrap = managedProviderBootstrap('1');
        const materialization = Object.freeze({
            v: 1 as const,
            kind: 'spawnEnv' as const,
            env: Object.freeze([Object.freeze({
                name: 'PROVIDER_TOKEN',
                value: 'runner-owned-token',
                source: 'provider' as const,
            })]),
        });
        let observedMaterialization: unknown;
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return {
                    ...preparedSnapshot(),
                    managedProvider: bootstrap,
                };
            }
            if (
                operation.kind
                    === 'plugin_services.managed_provider.start_v1'
            ) {
                return null;
            }
            if (
                operation.kind
                    === 'plugin_services.managed_provider.materialize_agent_binding_v1'
            ) {
                return materialization;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });

        await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-managed-provider-materialization',
            signal: new AbortController().signal,
            dispatch,
            bindManagedServices: () => unavailable.managedServices,
            onManagedProviderStarted: async ({ materialize }) => {
                observedMaterialization = await materialize({
                    endpointUrl: 'http://127.0.0.1:4312/v1',
                    credentialPlaceholder: 'p'.repeat(32),
                });
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        expect(observedMaterialization).toBe(materialization);
        expect(dispatch.mock.calls.map(([operation]) => operation.kind))
            .toEqual([
                'plugin_services.prepare_v1',
                'plugin_services.managed_provider.start_v1',
                'plugin_services.managed_provider.materialize_agent_binding_v1',
            ]);
    });

    it('recovers adopted Provider custody after the initial daemon loses the start response', async () => {
        const unavailable = createUnavailablePluginServices();
        const bootstrap = managedProviderBootstrap('1');
        const retained = {
            v: 1 as const,
            scope: bootstrap.scope,
            providerPluginHardRevocationRevisionAtAdmission:
                bootstrap
                    .providerPluginHardRevocationRevisionAtAdmission,
        };
        let custodyRetention: typeof retained | null = null;
        let initialStarts = 0;
        const dispatch = async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                if (operation.managedProviderRetention) {
                    expect(operation.managedProviderRetention)
                        .toEqual(retained);
                }
                return {
                    ...preparedSnapshot(),
                    managedProvider: bootstrap,
                };
            }
            if (
                operation.kind
                === 'plugin_services.managed_provider.start_v1'
            ) {
                if (initialStarts === 0) {
                    initialStarts += 1;
                    custodyRetention = retained;
                    throw new PluginError({
                        code: 'agent_runtime_daemon_service_unavailable',
                        message:
                            'Daemon A exited after runner custody adopted P',
                    });
                }
                expect(operation.retained).toEqual(retained);
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        };
        const input = {
            invocationId: 'invocation-lost-initial-prepare',
            signal: new AbortController().signal,
            dispatch,
            readManagedProviderRetention: () => custodyRetention,
            bindManagedServices: () =>
                unavailable.managedServices,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        };

        await expect(
            prepareRunnerDaemonPluginServices(input),
        ).rejects.toMatchObject({
            code: 'agent_runtime_daemon_service_unavailable',
        });
        await expect(
            prepareRunnerDaemonPluginServices(input),
        ).resolves.toMatchObject({
            managedServices: unavailable.managedServices,
        });
        expect(initialStarts).toBe(1);
    });

    it('threads materialization cancellation through the daemon Connected Accounts proxy', async () => {
        const unavailable = createUnavailablePluginServices();
        const materializationController = new AbortController();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.materialize_v1'
            ) {
                return {
                    kind: 'environment' as const,
                    env: { TOKEN: 'secret' },
                };
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-materialize',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await services.connectedAccounts.materialize(
            'provider.inference',
            { kind: 'environment', keys: ['TOKEN'] },
            {
                signal: materializationController.signal,
                expectedAccount: {
                    service: {
                        pluginId: 'fixture.accounts',
                        localId: 'provider',
                    },
                    accountId: 'expected-account',
                },
            },
        );

        expect(dispatch).toHaveBeenLastCalledWith(
            expect.objectContaining({
                kind: 'plugin_connected_accounts.materialize_v1',
                expectedAccount: {
                    service: {
                        pluginId: 'fixture.accounts',
                        localId: 'provider',
                    },
                    accountId: 'expected-account',
                },
            }),
            { signal: materializationController.signal },
        );
    });

    it('forwards each service call\'s own cancellation signal through the runner dispatch', async () => {
        const unavailable = createUnavailablePluginServices();
        const forwarded: Array<Readonly<{
            kind: RunnerDaemonPluginServiceOperationV1['kind'];
            signal: AbortSignal | undefined;
        }>> = [];
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<unknown> => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return {
                    ...preparedSnapshot(),
                    availability: {
                        ...preparedSnapshot().availability,
                        secrets: { status: 'available' },
                    },
                    resourceDescriptors: {
                        prompt: {
                            id: 'prompt',
                            kind: 'prompt',
                            contentType: 'text/plain',
                            digest: 'resource-1',
                            size: 2,
                        },
                    },
                };
            }
            forwarded.push({ kind: operation.kind, signal: options?.signal });
            return undefined;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-per-call-cancellation',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const path = { root: 'workspace' as const, relativePath: 'fixture.txt' };
        const calls = [
            ['plugin_secrets.get_v1', (signal: AbortSignal) => services.secrets.get('secret', { signal })],
            ['plugin_secrets.set_v1', (signal: AbortSignal) => services.secrets.set('secret', 'value', { signal })],
            ['plugin_secrets.delete_v1', (signal: AbortSignal) => services.secrets.delete('secret', { signal })],
            ['plugin_events.emit_v1', (signal: AbortSignal) => services.events.plugin.emit('changed', { value: true }, { signal })],
            ['plugin_fetch.request_v1', (signal: AbortSignal) => services.http.request({
                url: 'https://example.test/resource',
                redirect: 'manual',
            }, { signal })],
            ['plugin_fs.read_file_v1', (signal: AbortSignal) => services.fs.readFile(path, { signal })],
            ['plugin_fs.write_file_v1', (signal: AbortSignal) => services.fs.writeFile(path, new Uint8Array([1]), { signal })],
            ['plugin_fs.stat_v1', (signal: AbortSignal) => services.fs.stat(path, { signal })],
            ['plugin_fs.list_v1', (signal: AbortSignal) => services.fs.list(path, { signal })],
            ['plugin_fs.remove_v1', (signal: AbortSignal) => services.fs.remove(path, { signal })],
            ['plugin_resources.read_v1', (signal: AbortSignal) => services.resources.read('prompt', { signal })],
            ['plugin_notifications.send_v1', (signal: AbortSignal) => services.notifications.send({
                clientRequestId: 'notification-1',
                categoryId: 'updates',
                title: 'Update',
            }, { signal })],
            ['plugin_notifications.list_channels_v1', (signal: AbortSignal) => services.notifications.listChannels({ signal })],
            ['plugin_notifications.list_categories_v1', (signal: AbortSignal) => services.notifications.listCategories({ signal })],
            ['plugin_notifications.preferences_v1', (signal: AbortSignal) => services.notifications.preferences('updates', { signal })],
        ] as const;

        for (const [index, [kind, invoke]] of calls.entries()) {
            const controller = new AbortController();
            await invoke(controller.signal);
            expect(forwarded[index]).toEqual({ kind, signal: controller.signal });
        }
        expect(forwarded).toHaveLength(calls.length);
    });

    it('rejects a legacy caller-selected account before Connected Accounts dispatch', async () => {
        const unavailable = createUnavailablePluginServices();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.materialize_v1'
            ) {
                return {
                    kind: 'environment' as const,
                    env: { TOKEN: 'secret' },
                };
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-legacy-account-materialize',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const legacyOptions = {
            account: {
                service: {
                    pluginId: 'fixture.accounts',
                    localId: 'provider',
                },
                accountId: 'caller-selected',
            },
        } as unknown as Parameters<
            typeof services.connectedAccounts.materialize
        >[2];

        await expect(services.connectedAccounts.materialize(
            'provider.inference',
            { kind: 'environment', keys: ['TOKEN'] },
            legacyOptions,
        )).rejects.toMatchObject({
            code: 'plugin_connected_account_binding_out_of_scope',
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('never exposes daemon-unavailable services or a runner-local filesystem fallback', async () => {
        const unavailable = createUnavailablePluginServices();
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-2',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind !== 'plugin_services.prepare_v1') {
                    throw new Error('No operation expected');
                }
                return {
                    ...preparedSnapshot(),
                    availability: {
                        ...preparedSnapshot().availability,
                        fs: {
                            status: 'unavailable',
                            code: 'plugin_service_unavailable',
                        },
                    },
                };
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        expect(services.availability('fs')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        await expect(services.fs.readFile({
            root: 'workspace',
            relativePath: 'secret.txt',
        })).rejects.toMatchObject({
            code: 'plugin_service_unavailable',
        });
    });

    it('keeps targeted contribution observation canonically unavailable in the isolated runner', async () => {
        const unavailable = createUnavailablePluginServices();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            if (operation.kind !== 'plugin_services.prepare_v1') {
                throw new Error(`Unexpected runner dispatch ${operation.kind}`);
            }
            return preparedSnapshot();
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-runner-targeted-contributions',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                targetedContributions: unavailable.targetedContributions,
                interactions: unavailable.interactions,
            },
        });

        expect(services.availability('targetedContributions')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(services.targetedContributions)
            .toBe(unavailable.targetedContributions);
        expect(() => services.targetedContributions.observeForSelf(
            {
                targetPluginId: 'fixture.target',
                id: 'providers',
                protocol: { id: 'fixture-providers', version: 1 },
            },
            { onInvalidated: vi.fn() },
        )).toThrow(expect.objectContaining({
            code: 'plugin_service_unavailable',
            details: { serviceId: 'targetedContributions' },
        }));
        // Runner-local services that already have a defined owner retain it.
        expect(services.interactions).toBe(unavailable.interactions);
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it('keeps network.client WebSockets unavailable in the isolated Agent/session runner without adding a daemon wire operation', async () => {
        const unavailable = createUnavailablePluginServices();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            throw new Error(`Unexpected runner dispatch ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-runner-websocket',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        // HTTP requests retain their existing daemon proxy. This is the
        // isolated Agent/session process runner, not an in-daemon background
        // service such as Discord's gateway supervisor.
        expect(services.availability('http')).toEqual({ status: 'available' });
        await expect(services.http.openWebSocket({
            url: 'wss://gateway.example.test/socket',
        })).rejects.toMatchObject({
            code: 'plugin_service_unavailable',
            details: { serviceId: 'http' },
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('fails synchronous watch admission from the daemon-authored preparation snapshot', async () => {
        const unavailable = createUnavailablePluginServices();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            if (operation.kind !== 'plugin_services.prepare_v1') {
                throw new Error(
                    `Unexpected async watch dispatch ${operation.kind}`,
                );
            }
            return {
                ...preparedSnapshot(),
                resourceDescriptors: {
                    prompt: {
                        id: 'prompt',
                        kind: 'prompt',
                        contentType: 'text/plain',
                        digest: 'resource-1',
                        size: 2,
                    },
                },
                subscriptionCapabilities: {
                    settingsWatch: false,
                    eventSubscriptions: [{
                        pluginId: 'fixture.plugin',
                        localId: 'declared',
                    }],
                    resourceWatches: [],
                    notificationPreferencesWatch: false,
                },
            };
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-watch-policy',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        expect(() => services.settings.forScope({ kind: 'daemon' }).watch(() => undefined))
            .toThrow(expect.objectContaining({
                code: 'plugin_service_subscription_unavailable',
            }));
        expect(() => services.events.plugin.subscribe({
            pluginId: 'fixture.plugin',
            localId: 'undeclared',
        }, () => undefined)).toThrow(expect.objectContaining({
            code: 'plugin_service_subscription_unavailable',
        }));
        expect(() => services.resources.watch(
            'prompt',
            () => undefined,
        )).toThrow(expect.objectContaining({
            code: 'plugin_service_subscription_unavailable',
        }));
        expect(() => services.notifications.watchPreferences(
            'build',
            () => undefined,
        )).toThrow(expect.objectContaining({
            code: 'plugin_service_subscription_unavailable',
        }));
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it('runs storage transaction callbacks inside one explicit daemon transaction handle', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_storage.transaction.get_v1'
            ) {
                return 'before';
            }
            if (
                operation.kind
                    .startsWith('plugin_storage.transaction.')
            ) {
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-transaction',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.storage.daemonSession.transaction(
            async (transaction) => {
                const previous =
                    await transaction.get<string>('state');
                await transaction.set('state', 'after');
                return previous;
            },
        )).resolves.toBe('before');
        await expect(services.storage.daemonSession.transaction(
            async (transaction) => {
                await transaction.delete('state');
                throw new Error('rollback');
            },
        )).rejects.toThrow('rollback');

        const transactionIds = operations.flatMap((operation) =>
            'transactionId' in operation
                ? [operation.transactionId]
                : []);
        expect(new Set(transactionIds).size).toBe(2);
        expect(operations.map((operation) => operation.kind))
            .toEqual([
                'plugin_services.prepare_v1',
                'plugin_storage.transaction.open_v1',
                'plugin_storage.transaction.get_v1',
                'plugin_storage.transaction.set_v1',
                'plugin_storage.transaction.commit_v1',
                'plugin_storage.transaction.open_v1',
                'plugin_storage.transaction.delete_v1',
                'plugin_storage.transaction.rollback_v1',
            ]);
    });

    it('preserves unknown-after-dispatch outcomes without retrying mutations', async () => {
        const unavailable = createUnavailablePluginServices();
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            throw new PluginError({
                code: 'native_agent_session_effect_outcome_unknown',
                message: 'Outcome unknown after dispatch',
                details: {
                    outcome: 'unknown_after_dispatch',
                },
            });
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-3',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(
            services.storage.daemonSession.set('state', {
                attempted: true,
            }),
        ).rejects.toMatchObject({
            code: 'native_agent_session_effect_outcome_unknown',
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
            kind: 'plugin_storage.set_v1',
            value: encodeRunnerDaemonPluginServiceWireValueV1({
                attempted: true,
            }),
        });
    });

    it('resyncs connected-account watches after authority loss and aborts the active wait on dispose', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        const abortedSubscriptionIds: string[] = [];
        let openedSubscriptionCount = 0;
        const nextCountBySubscription = new Map<string, number>();
        let resolveSecondResync!: () => void;
        const secondResync = new Promise<void>((resolve) => {
            resolveSecondResync = resolve;
        });
        let resolveSecondWaitStarted!: () => void;
        const secondWaitStarted = new Promise<void>((resolve) => {
            resolveSecondWaitStarted = resolve;
        });
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
            options?: Readonly<{
                signal?: AbortSignal;
                timeoutMs?: number | null;
            }>,
        ): Promise<unknown> => {
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.watch.open_v1'
            ) {
                openedSubscriptionCount += 1;
                return null;
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.watch.next_v1'
            ) {
                const nextCount =
                    (nextCountBySubscription.get(
                        operation.subscriptionId,
                    ) ?? 0) + 1;
                nextCountBySubscription.set(
                    operation.subscriptionId,
                    nextCount,
                );
                if (openedSubscriptionCount === 1 && nextCount === 2) {
                    throw new PluginError({
                        code:
                            'runner_daemon_service_authority_transition',
                        message: 'Daemon authority changed from A to B',
                    });
                }
                if (nextCount === 1) {
                    return {
                        kind:
                            'plugin_connected_accounts.watch.event_v1',
                        invocationId: 'invocation-watch',
                        subscriptionId:
                            operation.subscriptionId,
                        event: { kind: 'resync' },
                    };
                }
                resolveSecondWaitStarted();
                return await new Promise<never>((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => {
                        abortedSubscriptionIds.push(
                            operation.subscriptionId,
                        );
                        reject(options.signal?.reason);
                    }, { once: true });
                });
            }
            if (
                operation.kind
                === 'plugin_services.subscription.close_v1'
            ) {
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-watch',
            signal: new AbortController().signal,
            dispatch,
            isAuthorityTransitionError: (error) =>
                isPluginError(error)
                && error.code
                    === 'runner_daemon_service_authority_transition',
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const events: Array<{ kind: 'resync' }> = [];
        const subscription = services.connectedAccounts.watch(
            'upstream',
            (event) => {
                events.push(event);
                if (events.length === 2) resolveSecondResync();
            },
        );

        await secondResync;
        await secondWaitStarted;
        subscription.dispose();
        await Promise.resolve();

        expect(events).toEqual([
            { kind: 'resync' },
            { kind: 'resync' },
        ]);
        const opens = operations.filter((operation) =>
            operation.kind
            === 'plugin_connected_accounts.watch.open_v1'
        );
        expect(opens).toHaveLength(2);
        expect(opens[0]?.subscriptionId)
            .not.toBe(opens[1]?.subscriptionId);
        const nextOperations = operations.filter((operation) =>
            operation.kind
            === 'plugin_connected_accounts.watch.next_v1'
        );
        expect(new Set(
            nextOperations.map((operation) => operation.requestId),
        ).size).toBe(nextOperations.length);
        expect(abortedSubscriptionIds).toEqual([
            opens[1]?.subscriptionId,
        ]);
        expect(operations).toContainEqual({
            kind: 'plugin_services.subscription.close_v1',
            requestId: expect.any(String),
            invocationId: 'invocation-watch',
            subscriptionId: opens[1]?.subscriptionId,
        });
    });

    it('does not retain generic subscription listener failures in plugin logs', async () => {
        const unavailable = createUnavailablePluginServices();
        const controller = new AbortController();
        const privatePayload =
            'VOICE_PRIVATE_GENERIC_SUBSCRIPTION_PAYLOAD';
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            diagnostic: vi.fn(),
        };
        const received: unknown[] = [];
        let delivered = false;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-private-generic-listener-failure',
            signal: controller.signal,
            dispatch: async (operation, options) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_settings.watch.open_v1') {
                    return null;
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    if (!delivered) {
                        delivered = true;
                        return {
                            kind: 'plugin_settings.watch.event_v1',
                            invocationId:
                                'invocation-private-generic-listener-failure',
                            subscriptionId: operation.subscriptionId,
                            scope: 'daemon',
                            change: {
                                revision: 'revision-1',
                                changedIds: [],
                                values: {},
                            },
                        };
                    }
                    return await new Promise<never>((_resolve, reject) => {
                        options?.signal?.addEventListener('abort', () => {
                            reject(options.signal?.reason);
                        }, { once: true });
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const subscription = services.settings.forScope({ kind: 'daemon' }).watch((change) => {
            received.push(change);
            throw new Error(privatePayload);
        });

        await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
        subscription.dispose();
        controller.abort();

        expect(received).toEqual([{
            scope: { kind: 'daemon' },
            revision: 'revision-1',
            changedIds: [],
            values: {},
        }]);
        expect(logger.warn).toHaveBeenCalledWith(
            'settings watch listener failed',
        );
        expect(JSON.stringify(logger.warn.mock.calls))
            .not.toContain(privatePayload);
    });

    it('does not retain connected-account listener failures in plugin logs', async () => {
        const unavailable = createUnavailablePluginServices();
        const controller = new AbortController();
        const privatePayload =
            'VOICE_PRIVATE_PROVIDER_CONTROL_PAYLOAD';
        const logger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            diagnostic: vi.fn(),
        };
        let delivered = false;
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-private-listener-failure',
            signal: controller.signal,
            dispatch: async (operation, options) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_connected_accounts.watch.open_v1'
                ) {
                    return null;
                }
                if (
                    operation.kind
                    === 'plugin_connected_accounts.watch.next_v1'
                ) {
                    if (!delivered) {
                        delivered = true;
                        return {
                            kind:
                                'plugin_connected_accounts.watch.event_v1',
                            invocationId:
                                'invocation-private-listener-failure',
                            subscriptionId: operation.subscriptionId,
                            event: { kind: 'resync' },
                        };
                    }
                    return await new Promise<never>((_resolve, reject) => {
                        options?.signal?.addEventListener('abort', () => {
                            reject(options.signal?.reason);
                        }, { once: true });
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const subscription = services.connectedAccounts.watch(
            'openai_realtime',
            () => {
                throw new Error(privatePayload);
            },
        );

        await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
        subscription.dispose();
        controller.abort();

        expect(logger.warn).toHaveBeenCalledWith(
            'Connected-account watch listener failed',
        );
        expect(JSON.stringify(logger.warn.mock.calls))
            .not.toContain(privatePayload);
    });

    it('reopens through the replacement authority before the first connected-account resync', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let openCount = 0;
        let nextCount = 0;
        let resolveReplacementOpen!: () => void;
        const replacementOpen = new Promise<void>((resolve) => {
            resolveReplacementOpen = resolve;
        });
        let resolveReplacementWait!: () => void;
        const replacementWait = new Promise<void>((resolve) => {
            resolveReplacementWait = resolve;
        });
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
            options?: Readonly<{
                signal?: AbortSignal;
                timeoutMs?: number | null;
            }>,
        ): Promise<unknown> => {
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.watch.open_v1'
            ) {
                openCount += 1;
                if (openCount === 1) {
                    throw new PluginError({
                        code:
                            'runner_daemon_service_authority_transition',
                        message:
                            'Authority changed before watch registration',
                    });
                }
                resolveReplacementOpen();
                return null;
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.watch.next_v1'
            ) {
                nextCount += 1;
                if (nextCount > 1) {
                    return await new Promise<never>(
                        (_resolve, reject) => {
                            options?.signal?.addEventListener(
                                'abort',
                                () => reject(options.signal?.reason),
                                { once: true },
                            );
                        },
                    );
                }
                resolveReplacementWait();
                return {
                    kind:
                        'plugin_connected_accounts.watch.event_v1',
                    invocationId:
                        'invocation-watch-first-resync',
                    subscriptionId: operation.subscriptionId,
                    event: { kind: 'resync' },
                };
            }
            if (
                operation.kind
                === 'plugin_services.subscription.close_v1'
            ) {
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-watch-first-resync',
            signal: new AbortController().signal,
            dispatch,
            isAuthorityTransitionError: (error) =>
                isPluginError(error)
                && error.code
                    === 'runner_daemon_service_authority_transition',
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        let resolveInitialResync!: () => void;
        const initialResync = new Promise<void>((resolve) => {
            resolveInitialResync = resolve;
        });
        const listener = vi.fn(() => resolveInitialResync());
        const subscription =
            services.connectedAccounts.watch(
                'upstream',
                listener,
            );

        await initialResync;
        await replacementOpen;
        await replacementWait;

        expect(openCount).toBe(2);
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith({ kind: 'resync' });
        expect(operations.filter((operation) =>
            operation.kind
            === 'plugin_connected_accounts.watch.next_v1'
        )).toHaveLength(2);
        subscription.dispose();
    });

    it('reopens a level-triggered resource watch after exact successor handle loss', async () => {
        const unavailable = createUnavailablePluginServices();
        let authority: 'A' | 'B' = 'A';
        let successorPrepared = false;
        const opens: Array<Readonly<{
            authority: 'A' | 'B';
            subscriptionId: string;
        }>> = [];
        const controller = new AbortController();
        let resolveBothEvents!: () => void;
        const bothEvents = new Promise<void>((resolve) => {
            resolveBothEvents = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-resource-watch-rotation',
            signal: controller.signal,
            dispatch: async (operation, options) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    if (authority === 'B') {
                        successorPrepared = true;
                    }
                    return {
                        ...preparedSnapshot(),
                        resourceDescriptors: {
                            prompt: {
                                id: 'prompt',
                                kind: 'prompt',
                                contentType: 'text/plain',
                                digest: authority,
                                size: 1,
                            },
                        },
                    };
                }
                if (
                    operation.kind
                    === 'plugin_resources.watch.open_v1'
                ) {
                    opens.push({
                        authority,
                        subscriptionId:
                            operation.subscriptionId,
                    });
                    return null;
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    const opened = opens.find((candidate) =>
                        candidate.subscriptionId
                        === operation.subscriptionId);
                    if (opened?.authority === 'A') {
                        if (!successorPrepared) {
                            authority = 'B';
                            throw new PluginError({
                                code:
                                    'plugin_services_invocation_unavailable',
                                message:
                                    'Successor has no prepared invocation',
                            });
                        }
                        throw new PluginError({
                            code:
                                'plugin_service_subscription_unavailable',
                            message:
                                'Old subscription handle is absent on B',
                        });
                    }
                    if (opened?.authority === 'B') {
                        if (opens.length === 2) {
                            opens.push({
                                authority: 'B',
                                subscriptionId:
                                    `${operation.subscriptionId}:delivered`,
                            });
                            return {
                                kind:
                                    'plugin_resources.watch.event_v1',
                                invocationId:
                                    'invocation-resource-watch-rotation',
                                subscriptionId:
                                    operation.subscriptionId,
                                change: { digest: 'B' },
                            };
                        }
                        return await new Promise<never>(
                            (_resolve, reject) => {
                                options?.signal?.addEventListener(
                                    'abort',
                                    () => reject(
                                        options.signal?.reason,
                                    ),
                                    { once: true },
                                );
                            },
                        );
                    }
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn((event: { digest: string }) => {
            if (event.digest === 'B') resolveBothEvents();
        });
        const watch = services.resources.watch('prompt', listener);

        await bothEvents;
        watch.dispose();
        controller.abort();

        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith({ digest: 'B' });
        expect(opens.filter((entry) =>
            !entry.subscriptionId.endsWith(':delivered')
        ).map((entry) => entry.authority)).toEqual(['A', 'B']);
    });

    // Event deliveries stay in the daemon broker's custody until this pump reports its listener
    // ran, so each later request carries the previous delivery's outcome. Other subscriptions keep
    // their fire-and-forget transport semantics and must not start acknowledging.
    it('acknowledges each Plugin Event delivery and reports a failed listener as rejected', async () => {
        const unavailable = createUnavailablePluginServices();
        const acknowledgements: (string | undefined)[] = [];
        const resourceAcknowledgements: (string | undefined)[] = [];
        const eventSubscriptionIds = new Set<string>();
        let pendingSequence = 0;
        let resolveObserved!: () => void;
        const observed = new Promise<void>((resolve) => {
            resolveObserved = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-event-settlement',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_events.subscribe.open_v1') {
                    eventSubscriptionIds.add(operation.subscriptionId);
                    return null;
                }
                if (operation.kind === 'plugin_resources.watch.open_v1') {
                    return null;
                }
                if (
                    operation.kind
                    !== 'plugin_services.subscription.next_v1'
                ) {
                    throw new Error(`Unexpected ${operation.kind}`);
                }
                if (!eventSubscriptionIds.has(operation.subscriptionId)) {
                    resourceAcknowledgements.push(operation.acknowledgement);
                    return await new Promise(() => {});
                }
                acknowledgements.push(operation.acknowledgement);
                // The host answers a rejection acknowledgement without an event.
                if (operation.acknowledgement === 'rejected') return null;
                pendingSequence += 1;
                if (pendingSequence > 2) {
                    resolveObserved();
                    return await new Promise(() => {});
                }
                return {
                    kind: 'plugin_events.subscribe.event_v1',
                    invocationId: 'invocation-event-settlement',
                    subscriptionId: operation.subscriptionId,
                    event: {
                        ref: {
                            pluginId: 'fixture.plugin',
                            localId: 'changed',
                        },
                        payload:
                            encodeRunnerDaemonPluginServiceWireValueV1(
                                pendingSequence,
                            ),
                        sequence: pendingSequence,
                    },
                };
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn((event: { sequence: number }) => {
            if (event.sequence === 1) throw new Error('listener failed');
        });
        const watch = services.events.plugin.subscribe({
            pluginId: 'fixture.plugin',
            localId: 'changed',
        }, listener);
        const resourceWatch = services.resources.watch('prompt', vi.fn());

        await observed;
        watch.dispose();
        resourceWatch.dispose();

        expect(acknowledgements).toEqual([
            undefined,
            'rejected',
            undefined,
            'settled',
        ]);
        expect(resourceAcknowledgements).toEqual([undefined]);
    });

    it('does not reconstruct a declared-event FIFO after successor handle loss', async () => {
        const unavailable = createUnavailablePluginServices();
        let prepareCount = 0;
        let openCount = 0;
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-event-watch-rotation',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_events.subscribe.open_v1'
                ) {
                    openCount += 1;
                    return null;
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.next_v1'
                ) {
                    if (prepareCount === 1) {
                        throw new PluginError({
                            code:
                                'plugin_services_invocation_unavailable',
                            message:
                                'Successor has no prepared invocation',
                        });
                    }
                    throw new PluginError({
                        code:
                            'plugin_service_subscription_unavailable',
                        message:
                            'FIFO handle cannot be reconstructed',
                    });
                }
                if (
                    operation.kind
                    === 'plugin_services.subscription.close_v1'
                ) {
                    resolveClosed();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const listener = vi.fn();
        const watch = services.events.plugin.subscribe({
            pluginId: 'fixture.plugin',
            localId: 'changed',
        }, listener);

        await closed;
        watch.dispose();

        expect(prepareCount).toBe(2);
        expect(openCount).toBe(1);
        expect(listener).not.toHaveBeenCalled();
    });

    it('projects the complete MCP client method roster onto explicit daemon operations', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let finishClientClose!: () => void;
        const clientClose = new Promise<void>((resolve) => {
            finishClientClose = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-mcp-client',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                operations.push(operation);
                switch (operation.kind) {
                    case 'plugin_services.prepare_v1':
                        return preparedSnapshot();
                    case 'plugin_mcp.connect_v1':
                        return null;
                    case 'plugin_mcp.client.close_v1':
                        await clientClose;
                        return null;
                    case 'plugin_mcp.client.list_tools_v1':
                        return { items: [] };
                    case 'plugin_mcp.client.call_tool_v1':
                        return { accepted: true };
                    case 'plugin_mcp.client.list_resources_v1':
                    case 'plugin_mcp.client.list_resource_templates_v1':
                    case 'plugin_mcp.client.list_prompts_v1':
                        return { items: [] };
                    case 'plugin_mcp.client.read_resource_v1':
                        return { contents: [] };
                    case 'plugin_mcp.client.get_prompt_v1':
                        return { messages: [] };
                    default:
                        throw new Error(`Unexpected ${operation.kind}`);
                }
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        const client = await services.mcp.connect({
            pluginId: 'fixture.plugin',
            localId: 'server',
        }, { elicitation: { mode: 'reject' } });
        await client.listTools({ cursor: 'tools', limit: 2 });
        await client.callTool('tool', null);
        await client.listResources({ cursor: 'resources' });
        await client.listResourceTemplates({ cursor: 'templates' });
        await client.readResource('file:///guide.md');
        await client.listPrompts({ cursor: 'prompts' });
        await client.getPrompt('review', { scope: 'src' });
        let disposeSettled = false;
        const dispose = Promise.resolve(client.dispose()).then(() => {
            disposeSettled = true;
        });
        await vi.waitFor(() => expect(operations.some((operation) =>
            operation.kind === 'plugin_mcp.client.close_v1'
        )).toBe(true));
        expect(disposeSettled).toBe(false);
        finishClientClose();
        await dispose;
        expect(operations.map((operation) => operation.kind)).toEqual([
            'plugin_services.prepare_v1',
            'plugin_mcp.connect_v1',
            'plugin_mcp.client.list_tools_v1',
            'plugin_mcp.client.call_tool_v1',
            'plugin_mcp.client.list_resources_v1',
            'plugin_mcp.client.list_resource_templates_v1',
            'plugin_mcp.client.read_resource_v1',
            'plugin_mcp.client.list_prompts_v1',
            'plugin_mcp.client.get_prompt_v1',
            'plugin_mcp.client.close_v1',
        ]);
    });

    it('joins repeated MCP client disposal and surfaces daemon close failure', async () => {
        const unavailable = createUnavailablePluginServices();
        const closeFailure = new PluginError({
            code: 'plugin_mcp_close_failed',
            message: 'MCP close failed',
        });
        let rejectClientClose!: (error: unknown) => void;
        const clientClose = new Promise<void>((_resolve, reject) => {
            rejectClientClose = reject;
        });
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-mcp-client-close-failure',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                operations.push(operation);
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_mcp.connect_v1') {
                    return null;
                }
                if (operation.kind === 'plugin_mcp.client.close_v1') {
                    await clientClose;
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });
        const client = await services.mcp.connect({
            pluginId: 'fixture.plugin',
            localId: 'server',
        }, { elicitation: { mode: 'reject' } });

        const firstDispose = Promise.resolve(client.dispose());
        let repeatedDisposeSettled = false;
        const repeatedDispose = Promise.resolve(client.dispose()).finally(() => {
            repeatedDisposeSettled = true;
        });
        await vi.waitFor(() => expect(operations.filter((operation) =>
            operation.kind === 'plugin_mcp.client.close_v1'
        )).toHaveLength(1));
        expect(repeatedDisposeSettled).toBe(false);

        rejectClientClose(closeFailure);
        await expect(firstDispose).rejects.toBe(closeFailure);
        await expect(repeatedDispose).rejects.toBe(closeFailure);
        expect(operations.filter((operation) =>
            operation.kind === 'plugin_mcp.client.close_v1'
        )).toHaveLength(1);
    });

    it('reprepares a replacement daemon without replaying an ambiguous mutation', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let authority: 'A' | 'B' = 'A';
        const controller = new AbortController();
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ): Promise<unknown> => {
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (operation.kind === 'plugin_storage.set_v1') {
                if (authority === 'A') {
                    authority = 'B';
                    throw new PluginError({
                        code:
                            'runner_daemon_service_authority_transition',
                        message:
                            'Mutation outcome on daemon A is unknown',
                    });
                }
                return null;
            }
            if (operation.kind === 'plugin_services.close_v1') {
                expect(authority).toBe('B');
                resolveClosed();
                return null;
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-mutation-rotation',
            signal: controller.signal,
            dispatch,
            isAuthorityTransitionError: (error) =>
                isPluginError(error)
                && error.code
                    === 'runner_daemon_service_authority_transition',
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(
            services.storage.daemonSession.set('state', {
                attempt: 1,
            }),
        ).rejects.toMatchObject({
            code:
                'runner_daemon_service_authority_transition',
        });

        expect(operations.filter((operation) =>
            operation.kind === 'plugin_services.prepare_v1'
        )).toHaveLength(2);
        expect(operations.filter((operation) =>
            operation.kind === 'plugin_storage.set_v1'
        )).toHaveLength(1);
        controller.abort();
        await closed;
        expect(operations.filter((operation) =>
            operation.kind === 'plugin_services.close_v1'
        )).toHaveLength(1);
    });

    it('does not create a successor invocation after an ambiguous lifetime close', async () => {
        const unavailable = createUnavailablePluginServices();
        const controller = new AbortController();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let resolveCloseAttempted!: () => void;
        const closeAttempted = new Promise<void>((resolve) => {
            resolveCloseAttempted = resolve;
        });
        await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-close-rotation',
            signal: controller.signal,
            dispatch: async (operation) => {
                operations.push(operation);
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_services.close_v1') {
                    resolveCloseAttempted();
                    throw new PluginError({
                        code:
                            'runner_daemon_service_authority_transition',
                        message:
                            'Close outcome on daemon A is unknown',
                    });
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            isAuthorityTransitionError: (error) =>
                isPluginError(error)
                && error.code
                    === 'runner_daemon_service_authority_transition',
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        controller.abort();
        await closeAttempted;
        await Promise.resolve();

        expect(operations.filter((operation) =>
            operation.kind === 'plugin_services.prepare_v1'
        )).toHaveLength(1);
        expect(operations.filter((operation) =>
            operation.kind === 'plugin_services.close_v1'
        )).toHaveLength(1);
    });

    it('prepares and closes a successor after an exact pre-service close miss', async () => {
        const unavailable = createUnavailablePluginServices();
        const controller = new AbortController();
        let prepareCount = 0;
        let closeCount = 0;
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-close-exact-miss',
            signal: controller.signal,
            dispatch: async (operation) => {
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_services.close_v1') {
                    closeCount += 1;
                    if (closeCount === 1) {
                        throw new PluginError({
                            code:
                                'plugin_services_invocation_unavailable',
                            message:
                                'Successor has no prepared invocation',
                        });
                    }
                    resolveClosed();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        controller.abort();
        await closed;

        expect(prepareCount).toBe(2);
        expect(closeCount).toBe(2);
    });

    it('deduplicates concurrent exact pre-service misses into one successor prepare', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let prepareCount = 0;
        let missCount = 0;
        let resolveBothMissed!: () => void;
        const bothMissed = new Promise<void>((resolve) => {
            resolveBothMissed = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-concurrent-reprepare',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                operations.push(operation);
                if (operation.kind === 'plugin_services.prepare_v1') {
                    prepareCount += 1;
                    return preparedSnapshot();
                }
                if (operation.kind === 'plugin_storage.get_v1') {
                    if (prepareCount === 1) {
                        missCount += 1;
                        if (missCount === 2) resolveBothMissed();
                        await bothMissed;
                        throw new PluginError({
                            code:
                                'plugin_services_invocation_unavailable',
                            message:
                                'Replacement daemon has no invocation',
                        });
                    }
                    return operation.key;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(Promise.all([
            services.storage.daemonSession.get('left'),
            services.storage.daemonSession.get('right'),
        ])).resolves.toEqual(['left', 'right']);
        expect(prepareCount).toBe(2);
        expect(operations.filter((operation) =>
            operation.kind === 'plugin_storage.get_v1'
        )).toHaveLength(4);
    });

    it('keeps exact exec authorization in the daemon and process custody in the runner', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        let resolveReleased!: () => void;
        const released = new Promise<void>((resolve) => {
            resolveReleased = resolve;
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-exec',
            signal: new AbortController().signal,
            dispatch: async (operation) => {
                operations.push(operation);
                if (operation.kind === 'plugin_services.prepare_v1') {
                    return preparedSnapshot();
                }
                if (
                    operation.kind
                    === 'plugin_exec.launch.authorize_v1'
                ) {
                    return {
                        authorizationId: 'authorization-1',
                        launch: {
                            command: process.execPath,
                            args: [
                                '-e',
                                'process.stdout.write("runner-exec")',
                            ],
                            env: {},
                        },
                    };
                }
                if (
                    operation.kind
                    === 'plugin_exec.launch.release_v1'
                ) {
                    resolveReleased();
                    return null;
                }
                throw new Error(`Unexpected ${operation.kind}`);
            },
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        const result = await services.exec.run({
            executable: {
                kind: 'managedDependency',
                id: 'codex-acp',
            },
        });
        await released;

        expect(Buffer.from(result.stdout).toString('utf8'))
            .toBe('runner-exec');
        expect(operations).toContainEqual({
            kind: 'plugin_exec.launch.authorize_v1',
            requestId: expect.any(String),
            invocationId: 'invocation-exec',
            request: {
                executable: {
                    kind: 'managedDependency',
                    id: 'codex-acp',
                },
                stdin: '',
            },
        });
        expect(operations).toContainEqual({
            kind: 'plugin_exec.launch.release_v1',
            requestId: expect.any(String),
            invocationId: 'invocation-exec',
            authorizationId: 'authorization-1',
        });
    });

    it('forwards the bounded purpose-scoped listing and exact-listed materialization to the daemon', async () => {
        const unavailable = createUnavailablePluginServices();
        const operations: RunnerDaemonPluginServiceOperationV1[] = [];
        const dispatch = vi.fn(async (
            operation: RunnerDaemonPluginServiceOperationV1,
        ) => {
            RunnerDaemonPluginServiceOperationV1Schema.parse(operation);
            operations.push(operation);
            if (operation.kind === 'plugin_services.prepare_v1') {
                return preparedSnapshot();
            }
            if (operation.kind === 'plugin_connected_accounts.list_accounts_v1') {
                return {
                    status: 'complete',
                    accounts: [{
                        account: {
                            service: { pluginId: 'acme.accounts', localId: 'openai' },
                            accountId: 'account-1',
                        },
                        displayName: 'EU account',
                        state: 'connected',
                        connectedAccountOrigins: ['https://eu.example.test'],
                        connectedAccountBases: ['https://eu.example.test'],
                    }],
                };
            }
            if (
                operation.kind
                === 'plugin_connected_accounts.materialize_listed_account_v1'
            ) {
                return { kind: 'environment', env: { TOKEN: 'listed-token' } };
            }
            throw new Error(`Unexpected ${operation.kind}`);
        });
        const services = await prepareRunnerDaemonPluginServices({
            invocationId: 'invocation-connected-account-listing',
            signal: new AbortController().signal,
            dispatch,
            local: {
                availability: unavailable.availability,
                logger: unavailable.logger,
                sessions: unavailable.sessions,
                managedServices: unavailable.managedServices,
                exec: unavailable.exec,
                composerContent: unavailable.composerContent,
                interactions: unavailable.interactions,
                targetedContributions: unavailable.targetedContributions,
            },
        });

        await expect(services.connectedAccounts.listAccounts({
            purpose: 'upstream',
            limit: 5,
        })).resolves.toMatchObject({ status: 'complete' });
        await expect(services.connectedAccounts.materializeListedAccount({
            purpose: 'upstream',
            account: {
                service: { pluginId: 'acme.accounts', localId: 'openai' },
                accountId: 'account-1',
            },
            materialization: { kind: 'environment', keys: ['TOKEN'] },
        })).resolves.toEqual({ kind: 'environment', env: { TOKEN: 'listed-token' } });

        expect(operations.map((operation) => operation.kind)).toEqual([
            'plugin_services.prepare_v1',
            'plugin_connected_accounts.list_accounts_v1',
            'plugin_connected_accounts.materialize_listed_account_v1',
        ]);
        expect(operations[1]).toMatchObject({ purpose: 'upstream', limit: 5 });
        expect(operations[2]).toMatchObject({
            purpose: 'upstream',
            account: {
                service: { pluginId: 'acme.accounts', localId: 'openai' },
                accountId: 'account-1',
            },
            request: { kind: 'environment', keys: ['TOKEN'] },
        });
    });
});
