import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
    isPluginError,
    PluginError,
    type JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
    PluginCancellationOptions,
    PluginServices } from '@happier-dev/plugin-sdk';
import type {
    PluginFetchCredentialBinding } from '@happier-dev/plugin-sdk/http';
import type {
    PluginInvocableActionId } from '@happier-dev/plugin-sdk/actions';
import type {
    McpClient as PluginMcpClient } from '@happier-dev/plugin-sdk/mcp';
import type {
    StorageTransaction,
} from '@happier-dev/plugin-sdk/storage';
import type {
    ProviderBindingStatusRequest,
    ProviderConnectionMutationRequest,
    ProviderConnectionsDescribeRequest,
    ProviderModelLoadRequest,
    ProviderModelProjectionRequest,
    ProviderModelsRequest,
    ProviderModelSettingsMutationRequest,
    ProviderProbeRequest,
    ProviderProfileMigrationConfirmRequest,
    ProviderProfileMigrationConflictConfirmRequest,
    ProviderProfileMigrationPreviewRequest,
} from '@happier-dev/plugin-sdk/providers';
import type {
    RunnerDaemonManagedProviderBootstrapV1,
    RunnerDaemonManagedProviderRetentionV1,
    RunnerDaemonPluginServiceOperationV1,
    RunnerDaemonPluginServiceResultV1,
    RunnerDaemonPluginServiceSubscriptionEventV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    decodeRunnerDaemonPluginServiceWireValueV1,
    encodeRunnerDaemonPluginServiceWireValueV1,
    type RunnerDaemonPluginServiceWireInput,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    authorizePluginExecLaunchForHost,
    type HostAuthorizedPluginExecLaunch,
} from '@/plugins/runtime/invocation/services/exec';
import type {
    AgentInvocationTurnAdmissionWitness,
} from '@/plugins/runtime/invocation/services/types';
import type {
    AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import type {
    RunnerManagedProviderServerLaunchAuthority,
} from '@/plugins/runtime/invocation/services/runnerManagedServiceSupervisionAuthorization';
import {
    createExternalSessionsUnavailableCapabilities,
} from '@/session/external/privateContract';
import type {
    AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
} from './sessionBridgeAuthorization';

type Invocation = {
    readonly key: string;
    readonly sessionId: string;
    readonly runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    readonly retainedAgent: AgentSessionRunnerBindingV1;
    readonly services: PluginServices;
    readonly managedProvider: ManagedProviderInvocation | null;
    managedProviderStart: Promise<void> | null;
    managedProviderMaterialization: Readonly<{
        endpointUrl: string;
        credentialPlaceholder: string;
        promise: Promise<unknown>;
    }> | null;
    readonly disposeOwner: () => void | Promise<void>;
    readonly controller: AbortController;
    readonly mcpClients: Map<string, PluginMcpClient>;
    readonly subscriptions: Map<string, Subscription>;
    readonly storageTransactions:
        Map<string, StorageTransactionState>;
    readonly systemToolResolutions:
        Map<string, ManagedExecutableRef>;
    readonly execAuthorizations:
        Map<string, HostAuthorizedPluginExecLaunch>;
    readonly authorizeOperation: (
        witness: AgentInvocationTurnAdmissionWitness | undefined,
        options?: Readonly<{
            requireActiveTurn?: boolean;
        }>,
    ) => boolean | Promise<boolean>;
    readonly authorizeManagedProviderMaterialization: () =>
        boolean | Promise<boolean>;
    readonly executeCurrentGlobalAction:
        RunnerDaemonCurrentGlobalActionExecutor;
    readonly currentGlobalMcp:
        RunnerDaemonCurrentGlobalMcpOwner;
    readonly currentGlobalExternalSessions:
        RunnerDaemonCurrentGlobalExternalSessionsOwner;
    disposed: boolean;
    disposal: Promise<void> | null;
};

type ManagedProviderInvocation = Readonly<{
    bootstrap: RunnerDaemonManagedProviderBootstrapV1;
    connectedAccounts: PluginServices['connectedAccounts'];
    isCurrent(): boolean | Promise<boolean>;
    readSupervisionLaunchAuthority(
        serverId: string,
    ): RunnerManagedProviderServerLaunchAuthority | null;
    start(): void | Promise<void>;
    materializeAgentBinding(input: Readonly<{
        endpointUrl: string;
        credentialPlaceholder: string;
    }>): unknown | Promise<unknown>;
}>;

type SubscriptionEvent =
    RunnerDaemonPluginServiceSubscriptionEventV1;

type SubscriptionWaiter = Readonly<{
    resolve(delivery: SubscriptionDelivery): void;
    reject(error: unknown): void;
    signal?: AbortSignal;
    abort?: () => void;
}>;

type SubscriptionDeliverySettlement = Readonly<{
    promise: Promise<void>;
    acknowledgeOnly: boolean;
    resolve(): void;
    reject(error: unknown): void;
}>;

type SubscriptionDelivery = Readonly<{
    event: SubscriptionEvent;
    settlement: SubscriptionDeliverySettlement | null;
}>;

type Subscription = {
    disposable: Readonly<{ dispose(): void | Promise<void> }>;
    readonly queueMode: 'fifo' | 'latest';
    readonly queue: SubscriptionDelivery[];
    readonly authorityScope: 'agent' | 'managedProvider';
    readonly awaitDeliverySettlement: boolean;
    readonly queueLimit?: number;
    readonly onOverflow?: () => void;
    overflowReported: boolean;
    waiter: SubscriptionWaiter | null;
    deliveredSettlement: SubscriptionDeliverySettlement | null;
    disposal: Promise<void> | null;
};

const RUNNER_DAEMON_PLUGIN_SERVICE_SUBSCRIPTION_QUEUE_LIMIT = 256;

type StorageTransactionState = {
    transaction: StorageTransaction | null;
    commandTail: Promise<void>;
    completion: Promise<void>;
    finish(): void;
    rollback(error: unknown): void;
    closed: boolean;
};

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
}

function decodeJsonValue(
    value: Parameters<
        typeof decodeRunnerDaemonPluginServiceWireValueV1
    >[0],
): JsonValue {
    const decoded =
        decodeRunnerDaemonPluginServiceWireValueV1(value);
    const convert = (
        candidate: RunnerDaemonPluginServiceWireInput,
    ): JsonValue => {
        if (candidate instanceof Uint8Array) {
            return fail(
                'plugin_service_json_value_invalid',
                'Binary data is not valid in this JSON service operation',
            );
        }
        if (Array.isArray(candidate)) {
            return candidate.map((entry) => convert(entry));
        }
        if (
            candidate !== null
            && typeof candidate === 'object'
        ) {
            return Object.fromEntries(
                Object.entries(candidate).map(
                    ([key, entry]) => [key, convert(entry)],
                ),
            );
        }
        return candidate;
    };
    return convert(decoded);
}

function decodeJsonRecord(
    value: Parameters<
        typeof decodeRunnerDaemonPluginServiceWireValueV1
    >[0],
): Readonly<Record<string, JsonValue>> {
    const decoded = decodeJsonValue(value);
    return isRecord(decoded)
        ? decoded
        : fail(
            'plugin_service_json_record_invalid',
            'Plugin service operation requires a JSON object',
        );
}

function decodeFetchCredentialBinding(
    value: Parameters<
        typeof decodeRunnerDaemonPluginServiceWireValueV1
    >[0],
): PluginFetchCredentialBinding {
    const decoded = decodeJsonValue(value);
    if (
        !isRecord(decoded)
        || decoded.kind !== 'voiceAccountOperation'
        || !isRecord(decoded.provider)
        || typeof decoded.provider.pluginId !== 'string'
        || typeof decoded.provider.localId !== 'string'
        || typeof decoded.operation !== 'string'
        || !isRecord(decoded.parameters)
    ) {
        return fail(
            'plugin_fetch_credential_binding_invalid',
            'Fetch credential binding is invalid',
        );
    }
    return {
        kind: 'voiceAccountOperation',
        provider: {
            pluginId: decoded.provider.pluginId,
            localId: decoded.provider.localId,
        },
        operation: decoded.operation,
        parameters: decoded.parameters,
    };
}

function invocationKey(
    sessionId: string,
    invocationId: string,
): string {
    return `${sessionId}\u0000${invocationId}`;
}

function hasExactInvocationAuthority(
    invocation: Invocation,
    sessionId: string,
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    retainedAgent: AgentSessionRunnerBindingV1,
): boolean {
    return invocation.sessionId === sessionId
        && isDeepStrictEqual(invocation.runner, runner)
        && isDeepStrictEqual(
            invocation.retainedAgent,
            retainedAgent,
        );
}

function sameExecutable(
    left: ManagedExecutableRef,
    right: ManagedExecutableRef,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function result(
    operation: RunnerDaemonPluginServiceOperationV1,
    value: unknown,
): RunnerDaemonPluginServiceResultV1 {
    return {
        kind: 'plugin_services.result_v1',
        requestId: operation.requestId,
        value: encodeRunnerDaemonPluginServiceWireValueV1(value),
    };
}

export type RunnerDaemonPluginServicesHost = Readonly<{
    readManagedProviderSupervisionAuthority(input: Readonly<{
        sessionId: string;
        runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
        retainedAgent: AgentSessionRunnerBindingV1;
        contributionId: string;
        operationClaimId: string;
        serverId?: string;
    }>): Promise<Readonly<{
        bootstrap: RunnerDaemonManagedProviderBootstrapV1;
        expectedLaunch:
            RunnerManagedProviderServerLaunchAuthority | null;
    }> | null>;
    dispatch(input: Readonly<{
        sessionId: string;
        runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
        retainedAgent: AgentSessionRunnerBindingV1;
        operation: RunnerDaemonPluginServiceOperationV1;
        signal?: AbortSignal;
    }>): Promise<RunnerDaemonPluginServiceResultV1>;
    dispose(): Promise<void>;
}>;

export type RunnerDaemonCurrentGlobalActionExecutor =
    (
        actionId: PluginInvocableActionId,
        input: unknown,
        options: PluginCancellationOptions | undefined,
        witness: AgentInvocationTurnAdmissionWitness,
    ) => Promise<unknown>;

export type RunnerDaemonCurrentGlobalMcpOwner = Pick<
    PluginServices['mcp'],
    'list' | 'discover' | 'connect'
>;

export type RunnerDaemonCurrentGlobalExternalSessionsOwner = Pick<
    PluginServices['sessions']['external'],
    | 'capabilities'
    | 'list'
    | 'attach'
    | 'readTranscript'
    | 'followTranscript'
    | 'takeover'
>;

export function createRunnerDaemonPluginServicesHost(input: Readonly<{
    createInvocation(params: Readonly<{
        sessionId: string;
        runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
        retainedAgent: AgentSessionRunnerBindingV1;
        invocationId: string;
        witness: AgentInvocationTurnAdmissionWitness | undefined;
        managedProviderRetention?:
            RunnerDaemonManagedProviderRetentionV1;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        services: PluginServices;
        managedProvider?: ManagedProviderInvocation | null;
        resourceDescriptors: Readonly<Record<
            string,
            ReturnType<PluginServices['resources']['describe']>
        >>;
        subscriptionCapabilities: Readonly<{
            settingsWatch: boolean;
            eventSubscriptions: readonly Readonly<{
                pluginId: string;
                localId: string;
            }>[];
            resourceWatches: readonly string[];
            notificationPreferencesWatch: boolean;
        }>;
        dispose(): void | Promise<void>;
        authorizeOperation(
            witness: AgentInvocationTurnAdmissionWitness | undefined,
            options?: Readonly<{
                requireActiveTurn?: boolean;
            }>,
        ): boolean | Promise<boolean>;
        authorizeManagedProviderMaterialization?():
            boolean | Promise<boolean>;
        executeCurrentGlobalAction:
            RunnerDaemonCurrentGlobalActionExecutor;
        currentGlobalMcp: RunnerDaemonCurrentGlobalMcpOwner;
        currentGlobalExternalSessions:
            RunnerDaemonCurrentGlobalExternalSessionsOwner;
    }>>;
}>): RunnerDaemonPluginServicesHost {
    const invocations = new Map<string, Invocation>();
    const pendingCreations = new Map<
        AbortController,
        Promise<void>
    >();
    let disposed = false;
    let disposal: Promise<void> | null = null;

    const requireInvocation = (
        sessionId: string,
        runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
        retainedAgent: AgentSessionRunnerBindingV1,
        operation: RunnerDaemonPluginServiceOperationV1,
    ): Invocation => {
        const invocation = invocations.get(
            invocationKey(sessionId, operation.invocationId),
        );
        if (
            !invocation
            || invocation.disposed
            || !hasExactInvocationAuthority(
                invocation,
                sessionId,
                runner,
                retainedAgent,
            )
        ) {
            return fail(
                'plugin_services_invocation_unavailable',
                'Runner PluginServices invocation is unavailable',
            );
        }
        return invocation;
    };

    const closeSubscription = async (
        invocation: Invocation,
        subscriptionId: string,
    ): Promise<void> => {
        const subscription =
            invocation.subscriptions.get(subscriptionId);
        if (!subscription) return;
        if (subscription.disposal) {
            return await subscription.disposal;
        }
        subscription.disposal = (async () => {
            try {
                await subscription.disposable.dispose();
            } finally {
                if (
                    invocation.subscriptions.get(subscriptionId)
                    === subscription
                ) {
                    invocation.subscriptions.delete(subscriptionId);
                }
                const closed = new PluginError({
                    code: 'plugin_service_subscription_closed',
                    message: 'Plugin service subscription is closed',
                });
                subscription.deliveredSettlement?.reject(closed);
                subscription.deliveredSettlement = null;
                for (const delivery of subscription.queue.splice(0)) {
                    delivery.settlement?.reject(closed);
                }
                const waiter = subscription.waiter;
                subscription.waiter = null;
                if (waiter) {
                    if (waiter.abort && waiter.signal) {
                        waiter.signal.removeEventListener(
                            'abort',
                            waiter.abort,
                        );
                    }
                    waiter.reject(closed);
                }
            }
        })();
        return await subscription.disposal;
    };

    const enqueueSubscriptionEvent = (
        subscription: Subscription,
        event: SubscriptionEvent,
    ): Promise<void> => {
        const settlement: SubscriptionDeliverySettlement | null =
            subscription.awaitDeliverySettlement
                ? (() => {
                    let resolveSettlement!: () => void;
                    let rejectSettlement!: (error: unknown) => void;
                    const promise = new Promise<void>(
                        (resolve, reject) => {
                            resolveSettlement = resolve;
                            rejectSettlement = reject;
                        },
                    );
                    return {
                        promise,
                        acknowledgeOnly:
                            event.kind
                            === 'plugin_sessions.external.follow_transcript.opened_v1',
                        resolve: resolveSettlement,
                        reject: rejectSettlement,
                    };
                })()
                : null;
        const settled = settlement?.promise ?? Promise.resolve();
        const delivery: SubscriptionDelivery = {
            event,
            settlement,
        };
        const waiter = subscription.waiter;
        if (waiter) {
            subscription.waiter = null;
            if (waiter.abort && waiter.signal) {
                waiter.signal.removeEventListener(
                    'abort',
                    waiter.abort,
                );
            }
            waiter.resolve(delivery);
            return settled;
        }
        if (subscription.queueMode === 'fifo') {
            if (
                subscription.queueLimit !== undefined
                &&
                subscription.queue.length
                    >= subscription.queueLimit
            ) {
                if (!subscription.overflowReported) {
                    subscription.overflowReported = true;
                    try {
                        subscription.onOverflow?.();
                    } catch {
                        // Overflow diagnostics never affect the producer.
                    }
                }
                settlement?.resolve();
                return settled;
            }
            subscription.queue.push(delivery);
        } else {
            for (const replaced of subscription.queue.splice(0)) {
                replaced.settlement?.resolve();
            }
            subscription.queue.push(delivery);
        }
        return settled;
    };

    const openSubscription = (
        invocation: Invocation,
        subscriptionId: string,
        register: (
            publish: (event: SubscriptionEvent) => Promise<void>,
        ) => Readonly<{ dispose(): void | Promise<void> }>,
        queueMode: Subscription['queueMode'],
        authorityScope: Subscription['authorityScope'] = 'agent',
        queueLimit?: number,
        onOverflow?: () => void,
        awaitDeliverySettlement = false,
    ): void => {
        if (invocation.subscriptions.has(subscriptionId)) {
            return fail(
                'plugin_service_subscription_duplicate',
                'Plugin service subscription already exists',
            );
        }
        const subscription: Subscription = {
            disposable: Object.freeze({ dispose() {} }),
            queueMode,
            queue: [],
            authorityScope,
            awaitDeliverySettlement,
            ...(queueLimit !== undefined ? { queueLimit } : {}),
            ...(onOverflow ? { onOverflow } : {}),
            overflowReported: false,
            waiter: null,
            deliveredSettlement: null,
            disposal: null,
        };
        invocation.subscriptions.set(
            subscriptionId,
            subscription,
        );
        try {
            subscription.disposable = register((event) =>
                enqueueSubscriptionEvent(subscription, event));
        } catch (error) {
            invocation.subscriptions.delete(subscriptionId);
            throw error;
        }
    };

    const requireStorageTransaction = (
        invocation: Invocation,
        transactionId: string,
    ): StorageTransactionState =>
        invocation.storageTransactions.get(transactionId)
        ?? fail(
            'plugin_storage_transaction_unavailable',
            'Plugin storage transaction is unavailable',
        );

    const runStorageTransactionCommand = async <T>(
        transaction: StorageTransactionState,
        command: (owner: StorageTransaction) => Promise<T>,
    ): Promise<T> => {
        if (transaction.closed || !transaction.transaction) {
            return fail(
                'plugin_storage_transaction_unavailable',
                'Plugin storage transaction is unavailable',
            );
        }
        const run = transaction.commandTail.then(
            async () => await command(transaction.transaction!),
        );
        transaction.commandTail = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    };

    const disposeInvocation = async (
        invocation: Invocation,
    ): Promise<void> => {
        if (invocation.disposal) {
            return await invocation.disposal;
        }
        invocation.disposed = true;
        invocations.delete(invocation.key);
        invocation.controller.abort();
        invocation.disposal = (async () => {
            const cleanupFailures: unknown[] = [];
            const subscriptionCleanupResults =
                await Promise.allSettled(
                    [...invocation.subscriptions.keys()].map(
                        async (subscriptionId) => {
                            await closeSubscription(
                                invocation,
                                subscriptionId,
                            );
                        },
                    ),
                );
            cleanupFailures.push(
                ...subscriptionCleanupResults.flatMap((result) =>
                    result.status === 'rejected'
                        ? [result.reason]
                        : []),
            );
            const mcpClientDisposals = [
                ...invocation.mcpClients.values(),
            ].map(async (client) => {
                await client.dispose();
            });
            invocation.mcpClients.clear();
            const mcpCleanupResults =
                await Promise.allSettled(mcpClientDisposals);
            cleanupFailures.push(
                ...mcpCleanupResults.flatMap((result) =>
                    result.status === 'rejected'
                        ? [result.reason]
                        : []),
            );
            for (
                const authorization
                of invocation.execAuthorizations.values()
            ) {
                authorization.release();
            }
            invocation.execAuthorizations.clear();
            invocation.systemToolResolutions.clear();
            for (
                const transaction
                of invocation.storageTransactions.values()
            ) {
                transaction.closed = true;
            }
            try {
                await Promise.all(
                    [...invocation.storageTransactions.values()]
                        .map(async (transaction) => {
                            await transaction.commandTail;
                            transaction.rollback(new PluginError({
                                code:
                                    'plugin_storage_transaction_closed',
                                message:
                                    'Plugin storage transaction invocation closed',
                            }));
                        }),
                );
                await Promise.allSettled(
                    [...invocation.storageTransactions.values()]
                        .map((transaction) =>
                            transaction.completion),
                );
            } catch (error) {
                cleanupFailures.push(error);
            } finally {
                invocation.storageTransactions.clear();
            }
            try {
                await invocation.disposeOwner();
            } catch (error) {
                cleanupFailures.push(error);
            }
            if (cleanupFailures.length === 1) {
                throw cleanupFailures[0];
            }
            if (cleanupFailures.length > 1) {
                throw new AggregateError(
                    cleanupFailures,
                    'Runner PluginServices invocation cleanup failed',
                );
            }
        })();
        return await invocation.disposal;
    };

    const dispatch = async (
        dispatchInput: Readonly<{
            sessionId: string;
            runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
            retainedAgent: AgentSessionRunnerBindingV1;
            operation: RunnerDaemonPluginServiceOperationV1;
            signal?: AbortSignal;
        }>,
    ): Promise<RunnerDaemonPluginServiceResultV1> => {
        if (disposed) {
            return fail(
                'plugin_services_host_disposed',
                'Runner PluginServices host is disposed',
            );
        }
        const {
            sessionId,
            runner,
            retainedAgent,
            operation,
            signal,
        } = dispatchInput;
        if (operation.kind === 'plugin_services.prepare_v1') {
            const key = invocationKey(sessionId, operation.invocationId);
            const existing = invocations.get(key);
            if (existing) {
                if (hasExactInvocationAuthority(
                    existing,
                    sessionId,
                    runner,
                    retainedAgent,
                )) {
                    return fail(
                        'plugin_services_invocation_duplicate',
                        'Runner PluginServices invocation already exists',
                    );
                }
                await disposeInvocation(existing);
            }
            if (disposed) {
                return fail(
                    'plugin_services_host_disposed',
                    'Runner PluginServices host is disposed',
                );
            }
            const controller = new AbortController();
            let pending = true;
            let settlePendingCreation!: () => void;
            const pendingCreation = new Promise<void>((resolve) => {
                settlePendingCreation = resolve;
            });
            pendingCreations.set(controller, pendingCreation);
            const completePendingCreation = (): void => {
                if (!pending) return;
                pending = false;
                pendingCreations.delete(controller);
                settlePendingCreation();
            };
            let created: Awaited<ReturnType<typeof input.createInvocation>>;
            try {
                created = await input.createInvocation({
                    sessionId,
                    runner,
                    retainedAgent,
                    invocationId: operation.invocationId,
                    witness: operation.witness,
                    ...(operation.managedProviderRetention
                        ? {
                            managedProviderRetention:
                                operation.managedProviderRetention,
                        }
                        : {}),
                    signal: controller.signal,
                });
            } catch (error) {
                completePendingCreation();
                throw error;
            }
            if (disposed) {
                try {
                    controller.abort();
                    await created.dispose();
                } finally {
                    completePendingCreation();
                }
                return fail(
                    'plugin_services_host_disposed',
                    'Runner PluginServices host is disposed',
                );
            }
            const managedProvider =
                created.managedProvider ?? null;
            if (
                managedProvider
                && !await managedProvider.isCurrent()
            ) {
                controller.abort();
                try {
                    await created.dispose();
                } finally {
                    completePendingCreation();
                }
                return fail(
                    'plugin_services_managed_provider_authority_unavailable',
                    'Runner managed Provider PluginServices authority is unavailable',
                );
            }
            if (disposed) {
                try {
                    controller.abort();
                    await created.dispose();
                } finally {
                    completePendingCreation();
                }
                return fail(
                    'plugin_services_host_disposed',
                    'Runner PluginServices host is disposed',
                );
            }
            const invocation: Invocation = {
                key,
                sessionId,
                runner,
                retainedAgent,
                services: created.services,
                managedProvider,
                managedProviderStart: null,
                managedProviderMaterialization: null,
                disposeOwner: created.dispose,
                controller,
                mcpClients: new Map(),
                subscriptions: new Map(),
                storageTransactions: new Map(),
                systemToolResolutions: new Map(),
                execAuthorizations: new Map(),
                authorizeOperation:
                    created.authorizeOperation,
                authorizeManagedProviderMaterialization:
                    created.authorizeManagedProviderMaterialization
                    ?? (() => false),
                executeCurrentGlobalAction:
                    created.executeCurrentGlobalAction,
                currentGlobalMcp:
                    created.currentGlobalMcp,
                currentGlobalExternalSessions:
                    created.currentGlobalExternalSessions,
                disposed: false,
                disposal: null,
            };
            invocations.set(key, invocation);
            completePendingCreation();
            const availability = Object.freeze({
                storage:
                    created.services.availability('storage'),
                settings:
                    created.services.availability('settings'),
                secrets:
                    created.services.availability('secrets'),
                events: created.services.availability('events'),
                fetch: created.services.availability('http'),
                fs: created.services.availability('fs'),
                exec: created.services.availability('exec'),
                actions:
                    created.services.availability('actions'),
                providers:
                    created.services.availability('providers'),
                resources:
                    created.services.availability('resources'),
                mcp: created.services.availability('mcp'),
                notifications:
                    created.services.availability(
                        'notifications',
                    ),
                connectedAccounts:
                    created.services.availability(
                        'connectedAccounts',
                    ),
            });
            const storageAvailable =
                availability.storage.status === 'available';
            const settingsDescriptors = Object.freeze({
                account: availability.settings.status === 'available'
                    ? (() => {
                        try {
                            return created.services.settings
                                .forScope({ kind: 'account' })
                                .describe();
                        } catch {
                            return [];
                        }
                    })()
                    : [],
                daemon: availability.settings.status === 'available'
                    ? (() => {
                        try {
                            return created.services.settings
                                .forScope({ kind: 'daemon' })
                                .describe();
                        } catch {
                            return [];
                        }
                    })()
                    : [],
            });
            return result(operation, {
                availability,
                storageConsistency: {
                    ephemeral: storageAvailable
                        ? created.services.storage.ephemeral
                            .consistency()
                        : null,
                    daemonSession: storageAvailable
                        ? created.services.storage.daemonSession
                            .consistency()
                        : null,
                    daemon: storageAvailable
                        ? created.services.storage.daemon
                            .consistency()
                        : null,
                },
                settingsDescriptors,
                resourceDescriptors:
                    created.resourceDescriptors,
                subscriptionCapabilities:
                    created.subscriptionCapabilities,
                ...(managedProvider
                    ? { managedProvider: managedProvider.bootstrap }
                    : {}),
            });
        }
        const invocation = requireInvocation(
            sessionId,
            runner,
            retainedAgent,
            operation,
        );
        if (
            operation.kind !== 'plugin_services.close_v1'
            && operation.kind
                !== 'plugin_services.subscription.close_v1'
            && operation.kind !== 'plugin_mcp.client.close_v1'
            && operation.kind !== 'plugin_exec.launch.release_v1'
            && operation.kind
                !== 'plugin_storage.transaction.rollback_v1'
        ) {
            const witness = 'witness' in operation
                ? operation.witness
                : undefined;
            const authorized = operation.kind
                === 'plugin_services.managed_provider.materialize_agent_binding_v1'
                ? await invocation
                    .authorizeManagedProviderMaterialization()
                : await invocation.authorizeOperation(witness, {
                    requireActiveTurn:
                        operation.kind
                            === 'plugin_actions.execute_v1',
                });
            if (!authorized) {
                if (
                    operation.kind
                        === 'plugin_sessions.external.capabilities_v1'
                ) {
                    return result(
                        operation,
                        createExternalSessionsUnavailableCapabilities(
                            'plugin_generation_retired',
                        ),
                    );
                }
                return fail(
                    'plugin_services_turn_authority_unavailable',
                    'Runner PluginServices operation lacks the exact active-turn authority',
                );
            }
        }
        const services = invocation.services;
        const requireManagedProvider = async () => {
            const managedProvider = invocation.managedProvider;
            if (
                !managedProvider
                || !await managedProvider.isCurrent()
            ) {
                return fail(
                    'plugin_services_managed_provider_authority_unavailable',
                    'Runner managed Provider PluginServices authority is unavailable',
                );
            }
            return managedProvider;
        };
        const connectedAccountsFor = async (
            operationScope: 'managedProvider' | undefined,
        ) => operationScope === 'managedProvider'
            ? (await requireManagedProvider()).connectedAccounts
            : services.connectedAccounts;
        const operationOptions = signal ? { signal } : {};
        const storageScope = (
            scope: 'ephemeral' | 'daemonSession' | 'daemon',
        ) => services.storage[scope];

        switch (operation.kind) {
            case 'plugin_services.close_v1':
                await disposeInvocation(invocation);
                return result(operation, null);
            case 'plugin_logger.write_v1': {
                const entry = operation.entry;
                if (entry.kind === 'diagnostic') {
                    services.logger.diagnostic({
                        code: entry.data.code,
                        severity: entry.data.severity,
                        ...(entry.data.message !== undefined
                            ? { message: entry.data.message }
                            : {}),
                        ...(entry.data.details !== undefined
                            ? {
                                details: decodeJsonValue(
                                    entry.data.details,
                                ),
                            }
                            : {}),
                        ...(entry.data.remediation !== undefined
                            ? {
                                remediation:
                                    entry.data.remediation,
                            }
                            : {}),
                    });
                } else {
                    services.logger[entry.level](
                        entry.message,
                        entry.fields === undefined
                            ? undefined
                            : decodeJsonRecord(entry.fields),
                    );
                }
                return result(operation, null);
            }
            case 'plugin_services.managed_provider.start_v1': {
                const managedProvider =
                    await requireManagedProvider();
                const expected = Object.freeze({
                    v: 1 as const,
                    scope: managedProvider.bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        managedProvider.bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                });
                if (
                    JSON.stringify(operation.retained)
                        !== JSON.stringify(expected)
                ) {
                    return fail(
                        'plugin_services_managed_provider_retention_mismatch',
                        'Runner requested a different managed Provider start authority',
                    );
                }
                invocation.managedProviderStart ??=
                    Promise.resolve(managedProvider.start());
                await invocation.managedProviderStart;
                if (!await managedProvider.isCurrent()) {
                    return fail(
                        'plugin_services_managed_provider_authority_unavailable',
                        'Runner managed Provider authority changed during start',
                    );
                }
                return result(operation, null);
            }
            case 'plugin_services.managed_provider.materialize_agent_binding_v1': {
                const managedProvider =
                    await requireManagedProvider();
                const expected = Object.freeze({
                    v: 1 as const,
                    scope: managedProvider.bootstrap.scope,
                    providerPluginHardRevocationRevisionAtAdmission:
                        managedProvider.bootstrap
                            .providerPluginHardRevocationRevisionAtAdmission,
                });
                if (
                    JSON.stringify(operation.retained)
                        !== JSON.stringify(expected)
                ) {
                    return fail(
                        'plugin_services_managed_provider_retention_mismatch',
                        'Runner requested a different managed Provider materialization authority',
                    );
                }
                if (!invocation.managedProviderStart) {
                    return fail(
                        'plugin_services_managed_provider_start_required',
                        'Managed Provider must start before Agent materialization',
                    );
                }
                await invocation.managedProviderStart;
                if (!await managedProvider.isCurrent()) {
                    return fail(
                        'plugin_services_managed_provider_authority_unavailable',
                        'Runner managed Provider authority changed before Agent materialization',
                    );
                }
                const prior = invocation
                    .managedProviderMaterialization;
                if (prior) {
                    return fail(
                        'plugin_services_managed_provider_materialization_already_attempted',
                        'Managed Provider Agent materialization was already attempted',
                    );
                }
                invocation.managedProviderMaterialization ??=
                    Object.freeze({
                        endpointUrl: operation.endpointUrl,
                        credentialPlaceholder:
                            operation.credentialPlaceholder,
                        promise: (async () => {
                            const value = await managedProvider
                                .materializeAgentBinding({
                                    endpointUrl:
                                        operation.endpointUrl,
                                    credentialPlaceholder:
                                        operation
                                            .credentialPlaceholder,
                                });
                            if (!await managedProvider.isCurrent()) {
                                return fail(
                                    'plugin_services_managed_provider_authority_unavailable',
                                    'Runner managed Provider authority changed during Agent materialization',
                                );
                            }
                            return value;
                        })(),
                    });
                return result(
                    operation,
                    await invocation
                        .managedProviderMaterialization.promise,
                );
            }
            case 'plugin_storage.get_v1':
                return result(
                    operation,
                    await storageScope(operation.scope).get(
                        operation.key,
                        operationOptions,
                    ),
                );
            case 'plugin_storage.set_v1':
                await storageScope(operation.scope).set(
                    operation.key,
                    decodeJsonValue(
                        operation.value,
                    ),
                    operationOptions,
                );
                return result(operation, null);
            case 'plugin_storage.delete_v1':
                await storageScope(operation.scope).delete(
                    operation.key,
                    operationOptions,
                );
                return result(operation, null);
            case 'plugin_storage.list_v1':
                return result(
                    operation,
                    await storageScope(operation.scope).list({
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...(operation.prefix !== undefined
                            ? { prefix: operation.prefix }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_storage.transaction.open_v1': {
                if (
                    invocation.storageTransactions.has(
                        operation.transactionId,
                    )
                ) {
                    return fail(
                        'plugin_storage_transaction_duplicate',
                        'Plugin storage transaction already exists',
                    );
                }
                let resolveReady!: () => void;
                let rejectReady!: (error: unknown) => void;
                const ready = new Promise<void>(
                    (resolve, reject) => {
                        resolveReady = resolve;
                        rejectReady = reject;
                    },
                );
                let finish!: () => void;
                let rollback!: (error: unknown) => void;
                const finished = new Promise<void>(
                    (resolve, reject) => {
                        finish = resolve;
                        rollback = reject;
                    },
                );
                const transaction: StorageTransactionState = {
                    transaction: null,
                    commandTail: Promise.resolve(),
                    completion: Promise.resolve(),
                    finish,
                    rollback,
                    closed: false,
                };
                invocation.storageTransactions.set(
                    operation.transactionId,
                    transaction,
                );
                transaction.completion =
                    storageScope(operation.scope).transaction(
                        async (owner) => {
                            transaction.transaction = owner;
                            resolveReady();
                            await finished;
                        },
                        operationOptions,
                    ).finally(() => {
                        transaction.closed = true;
                        invocation.storageTransactions.delete(
                            operation.transactionId,
                        );
                    });
                void transaction.completion.catch((error) => {
                    rejectReady(error);
                });
                await ready;
                return result(operation, null);
            }
            case 'plugin_storage.transaction.get_v1': {
                const transaction = requireStorageTransaction(
                    invocation,
                    operation.transactionId,
                );
                return result(
                    operation,
                    await runStorageTransactionCommand(
                        transaction,
                        async (owner) => await owner.get(
                            operation.key,
                            operationOptions,
                        ),
                    ),
                );
            }
            case 'plugin_storage.transaction.set_v1': {
                const transaction = requireStorageTransaction(
                    invocation,
                    operation.transactionId,
                );
                await runStorageTransactionCommand(
                    transaction,
                    async (owner) => await owner.set(
                        operation.key,
                        decodeJsonValue(operation.value),
                        operationOptions,
                    ),
                );
                return result(operation, null);
            }
            case 'plugin_storage.transaction.delete_v1': {
                const transaction = requireStorageTransaction(
                    invocation,
                    operation.transactionId,
                );
                await runStorageTransactionCommand(
                    transaction,
                    async (owner) => await owner.delete(
                        operation.key,
                        operationOptions,
                    ),
                );
                return result(operation, null);
            }
            case 'plugin_storage.transaction.commit_v1': {
                const transaction = requireStorageTransaction(
                    invocation,
                    operation.transactionId,
                );
                if (transaction.closed) {
                    return fail(
                        'plugin_storage_transaction_unavailable',
                        'Plugin storage transaction is unavailable',
                    );
                }
                transaction.closed = true;
                const commandTail = transaction.commandTail;
                await commandTail;
                transaction.finish();
                await transaction.completion;
                return result(operation, null);
            }
            case 'plugin_storage.transaction.rollback_v1': {
                const transaction = requireStorageTransaction(
                    invocation,
                    operation.transactionId,
                );
                if (transaction.closed) {
                    return fail(
                        'plugin_storage_transaction_unavailable',
                        'Plugin storage transaction is unavailable',
                    );
                }
                transaction.closed = true;
                const commandTail = transaction.commandTail;
                await commandTail;
                transaction.rollback(new PluginError({
                    code: 'plugin_storage_transaction_rolled_back',
                    message:
                        'Plugin storage transaction was rolled back',
                }));
                await transaction.completion.catch(() => undefined);
                return result(operation, null);
            }
            case 'plugin_settings.snapshot_v1':
                return result(
                    operation,
                    await services.settings.forScope({
                        kind: operation.scope,
                    }).snapshot(
                        operationOptions,
                    ),
                );
            case 'plugin_settings.get_v1':
                return result(
                    operation,
                    await services.settings.forScope({
                        kind: operation.scope,
                    }).get(
                        operation.id,
                        operationOptions,
                    ),
                );
            case 'plugin_settings.set_v1':
                return result(
                    operation,
                    await services.settings.forScope({
                        kind: operation.scope,
                    }).set(
                        operation.id,
                        decodeJsonValue(
                            operation.value,
                        ),
                        {
                            ...(operation.expectedRevision
                                ? {
                                    expectedRevision:
                                        operation
                                            .expectedRevision,
                                }
                                : {}),
                            ...operationOptions,
                        },
                    ),
                );
            case 'plugin_settings.reset_v1':
                return result(
                    operation,
                    await services.settings.forScope({
                        kind: operation.scope,
                    }).reset(
                        operation.id,
                        {
                            ...(operation.expectedRevision
                                ? {
                                    expectedRevision:
                                        operation
                                            .expectedRevision,
                                }
                                : {}),
                            ...operationOptions,
                        },
                    ),
                );
            case 'plugin_settings.watch.open_v1':
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        services.settings.forScope({
                            kind: operation.scope,
                        }).watch((change) => {
                            publish({
                                kind:
                                    'plugin_settings.watch.event_v1',
                                invocationId:
                                    operation.invocationId,
                                subscriptionId:
                                    operation.subscriptionId,
                                scope: operation.scope,
                                change: {
                                    revision: change.revision,
                                    changedIds: [
                                        ...change.changedIds,
                                    ],
                                    values: Object.fromEntries(
                                        Object.entries(
                                            change.values,
                                        ).map(([id, value]) => [
                                            id,
                                            encodeRunnerDaemonPluginServiceWireValueV1(
                                                value,
                                            ),
                                        ]),
                                    ),
                                },
                            });
                        }),
                    'fifo',
                );
                return result(operation, null);
            case 'plugin_secrets.status_v1':
                return result(
                    operation,
                    await services.secrets.status(operation.id),
                );
            case 'plugin_secrets.get_v1':
                return result(
                    operation,
                    await services.secrets.get(operation.id, {
                        ...(operation.reason
                            ? { reason: operation.reason }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_secrets.set_v1':
                return result(
                    operation,
                    await services.secrets.set(
                        operation.id,
                        operation.value,
                        {
                            ...(operation.expectedRevision
                                ? {
                                    expectedRevision:
                                        operation
                                            .expectedRevision,
                                }
                                : {}),
                            ...operationOptions,
                        },
                    ),
                );
            case 'plugin_secrets.delete_v1':
                return result(
                    operation,
                    await services.secrets.delete(
                        operation.id,
                        {
                            ...(operation.expectedRevision
                                ? {
                                    expectedRevision:
                                        operation
                                            .expectedRevision,
                                }
                                : {}),
                            ...operationOptions,
                        },
                    ),
                );
            case 'plugin_events.emit_v1':
                return result(
                    operation,
                    await services.events.plugin.emit(
                        operation.eventId,
                        decodeJsonValue(
                            operation.payload,
                        ),
                        operationOptions,
                    ),
                );
            case 'plugin_events.subscribe.open_v1':
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        services.events.plugin.subscribe(
                            operation.event,
                            (event) => {
                                publish({
                                    kind:
                                        'plugin_events.subscribe.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    event: {
                                        ref: event.ref,
                                        payload:
                                            encodeRunnerDaemonPluginServiceWireValueV1(
                                                event.payload,
                                            ),
                                        sequence:
                                            event.sequence,
                                    },
                                });
                            },
                        ),
                    'fifo',
                );
                return result(operation, null);
            case 'plugin_events.host.subscribe.open_v1':
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        services.events.host.subscribe(
                            operation.target,
                            (event) => {
                                publish({
                                    kind:
                                        'plugin_events.host.subscribe.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    event: {
                                        eventId:
                                            event.eventId,
                                        scope: event.scope,
                                        payload:
                                            encodeRunnerDaemonPluginServiceWireValueV1(
                                                event.payload,
                                            ),
                                    },
                                });
                            },
                        ),
                    'fifo',
                    'agent',
                    RUNNER_DAEMON_PLUGIN_SERVICE_SUBSCRIPTION_QUEUE_LIMIT,
                    () => {
                        services.logger.diagnostic({
                            code:
                                'plugin_host_events_delivery_dropped',
                            severity: 'warning',
                            message:
                                'Host Event delivery was dropped because the retained runner transport queue is full',
                            details: {
                                subscriptionId:
                                    operation.subscriptionId,
                                queueLimit:
                                    RUNNER_DAEMON_PLUGIN_SERVICE_SUBSCRIPTION_QUEUE_LIMIT,
                            },
                        });
                    },
                );
                return result(operation, null);
            case 'plugin_fetch.request_v1':
                {
                const {
                    body,
                    credentialBinding,
                    ...request
                } = operation.request;
                return result(
                    operation,
                    await services.http.request({
                        ...request,
                        ...(body !== undefined
                            ? {
                                body: new Uint8Array(
                                    Buffer.from(
                                        body,
                                        'base64',
                                    ),
                                ),
                            }
                            : {}),
                        ...(credentialBinding
                            ? {
                                credentialBinding:
                                    decodeFetchCredentialBinding(
                                        credentialBinding,
                                    ),
                            }
                            : {}),
                        ...operationOptions,
                    }),
                );
                }
            case 'plugin_providers.invoke_v1': {
                // The runner wire carries host-neutral JSON. The canonical
                // Provider producer stamps machine identity and strictly
                // parses the Protocol request before dispatch.
                const request = decodeJsonValue(operation.request);
                switch (operation.operation) {
                    case 'connections.describe':
                        return result(operation, await services.providers.connections.describe(
                            request as ProviderConnectionsDescribeRequest,
                            operationOptions,
                        ));
                    case 'connections.mutate':
                        return result(operation, await services.providers.connections.mutate(
                            request as ProviderConnectionMutationRequest,
                            operationOptions,
                        ));
                    case 'connections.bindingStatus':
                        return result(operation, await services.providers.connections.bindingStatus(
                            request as ProviderBindingStatusRequest,
                            operationOptions,
                        ));
                    case 'catalog.probe':
                        return result(operation, await services.providers.catalog.probe(
                            request as ProviderProbeRequest,
                            operationOptions,
                        ));
                    case 'catalog.listModels':
                        return result(operation, await services.providers.catalog.listModels(
                            request as ProviderModelsRequest,
                            operationOptions,
                        ));
                    case 'catalog.setModelLoad':
                        return result(operation, await services.providers.catalog.setModelLoad(
                            request as ProviderModelLoadRequest,
                            operationOptions,
                        ));
                    case 'catalog.projectModels':
                        return result(operation, await services.providers.catalog.projectModels(
                            request as ProviderModelProjectionRequest,
                            operationOptions,
                        ));
                    case 'catalog.mutateModelSettings':
                        return result(operation, await services.providers.catalog.mutateModelSettings(
                            request as ProviderModelSettingsMutationRequest,
                            operationOptions,
                        ));
                    case 'migrations.preview':
                        return result(operation, await services.providers.migrations.preview(
                            request as ProviderProfileMigrationPreviewRequest,
                            operationOptions,
                        ));
                    case 'migrations.confirm':
                        return result(operation, await services.providers.migrations.confirm(
                            request as ProviderProfileMigrationConfirmRequest,
                            operationOptions,
                        ));
                    case 'migrations.confirmConflict':
                        return result(operation, await services.providers.migrations.confirmConflict(
                            request as ProviderProfileMigrationConflictConfirmRequest,
                            operationOptions,
                        ));
                }
            }
            case 'plugin_actions.execute_v1': {
                if (!operation.witness) {
                    return fail(
                        'plugin_services_turn_authority_unavailable',
                        'Runner PluginServices Action lacks exact active-turn authority',
                    );
                }
                const actionInput = decodeJsonValue(operation.input);
                return result(
                    operation,
                    await invocation.executeCurrentGlobalAction(
                        operation.actionId,
                        actionInput,
                        operationOptions,
                        operation.witness,
                    ),
                );
            }
            case 'plugin_sessions.external.capabilities_v1':
                return result(
                    operation,
                    await invocation.currentGlobalExternalSessions
                        .capabilities(operationOptions),
                );
            case 'plugin_sessions.external.list_v1': {
                const query = operation.query
                    ? decodeRunnerDaemonPluginServiceWireValueV1(
                        operation.query,
                    ) as Parameters<
                        RunnerDaemonCurrentGlobalExternalSessionsOwner[
                            'list'
                        ]
                    >[0]
                    : undefined;
                return result(
                    operation,
                    await invocation.currentGlobalExternalSessions.list(
                        query,
                        operationOptions,
                    ),
                );
            }
            case 'plugin_sessions.external.attach_v1':
                return result(
                    operation,
                    await invocation.currentGlobalExternalSessions.attach(
                        decodeRunnerDaemonPluginServiceWireValueV1(
                            operation.ref,
                        ) as Parameters<
                            RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                'attach'
                            ]
                        >[0],
                        operationOptions,
                    ),
                );
            case 'plugin_sessions.external.read_transcript_v1':
                return result(
                    operation,
                    await invocation.currentGlobalExternalSessions
                        .readTranscript(
                            decodeRunnerDaemonPluginServiceWireValueV1(
                                operation.ref,
                            ) as Parameters<
                                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                    'readTranscript'
                                ]
                            >[0],
                            decodeRunnerDaemonPluginServiceWireValueV1(
                                operation.query,
                            ) as Parameters<
                                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                    'readTranscript'
                                ]
                            >[1],
                            operationOptions,
                        ),
                );
            case 'plugin_sessions.external.follow_transcript.open_v1': {
                let publishFollowEvent:
                    (event: SubscriptionEvent) => Promise<void> =
                    async () => fail(
                        'plugin_service_subscription_unavailable',
                        'External Sessions follow subscription is unavailable',
                    );
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) => {
                        publishFollowEvent = publish;
                        return Object.freeze({ dispose() {} });
                    },
                    'fifo',
                    'agent',
                    undefined,
                    undefined,
                    true,
                );
                void (async () => {
                    try {
                        const followed = await invocation
                        .currentGlobalExternalSessions.followTranscript(
                            decodeRunnerDaemonPluginServiceWireValueV1(
                                operation.ref,
                            ) as Parameters<
                                RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                    'followTranscript'
                                ]
                            >[0],
                            {
                                ...(decodeRunnerDaemonPluginServiceWireValueV1(
                                    operation.options,
                                ) as Parameters<
                                    RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                        'followTranscript'
                                    ]
                                >[1]),
                                ...operationOptions,
                            },
                            async (event) => {
                                await publishFollowEvent({
                                    kind:
                                        'plugin_sessions.external.follow_transcript.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    event:
                                        encodeRunnerDaemonPluginServiceWireValueV1(
                                            event,
                                        ),
                                });
                            },
                        );
                        if (followed.status === 'unavailable') {
                            await publishFollowEvent({
                                kind:
                                    'plugin_sessions.external.follow_transcript.opened_v1',
                                invocationId: operation.invocationId,
                                subscriptionId:
                                    operation.subscriptionId,
                                result: followed,
                            });
                            await closeSubscription(
                                invocation,
                                operation.subscriptionId,
                            );
                            return;
                        }
                        const subscription =
                            invocation.subscriptions.get(
                                operation.subscriptionId,
                            );
                        if (!subscription) {
                            await followed.subscription.dispose();
                            return;
                        }
                        subscription.disposable =
                            followed.subscription;
                        await publishFollowEvent({
                            kind:
                                'plugin_sessions.external.follow_transcript.opened_v1',
                            invocationId: operation.invocationId,
                            subscriptionId:
                                operation.subscriptionId,
                            result: {
                                status: 'following',
                                startingCursor:
                                    followed.startingCursor,
                            },
                        });
                    } catch (error) {
                        if (
                            invocation.subscriptions.has(
                                operation.subscriptionId,
                            )
                        ) {
                            const code = isPluginError(error)
                                ? error.code
                                : 'plugin_external_follow_failed';
                            const message = error instanceof Error
                                ? error.message
                                : 'External Sessions follow acquisition failed';
                            await publishFollowEvent({
                                kind:
                                    'plugin_sessions.external.follow_transcript.opened_v1',
                                invocationId: operation.invocationId,
                                subscriptionId:
                                    operation.subscriptionId,
                                result: {
                                    status: 'failed',
                                    code,
                                    message,
                                },
                            }).catch(() => undefined);
                            await closeSubscription(
                                invocation,
                                operation.subscriptionId,
                            ).catch(() => undefined);
                        }
                    }
                })().catch(() => undefined);
                return result(operation, { status: 'opening' });
            }
            case 'plugin_sessions.external.takeover_v1':
                return result(
                    operation,
                    await invocation.currentGlobalExternalSessions.takeover(
                        decodeRunnerDaemonPluginServiceWireValueV1(
                            operation.ref,
                        ) as Parameters<
                            RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                'takeover'
                            ]
                        >[0],
                        decodeRunnerDaemonPluginServiceWireValueV1(
                            operation.request,
                        ) as Parameters<
                            RunnerDaemonCurrentGlobalExternalSessionsOwner[
                                'takeover'
                            ]
                        >[1],
                        operationOptions,
                    ),
                );
            case 'plugin_fs.read_file_v1':
                return result(
                    operation,
                    await services.fs.readFile(operation.path, {
                        ...(operation.maxBytes !== undefined
                            ? { maxBytes: operation.maxBytes }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_fs.write_file_v1':
                await services.fs.writeFile(
                    operation.path,
                    new Uint8Array(
                        Buffer.from(operation.data, 'base64'),
                    ),
                    operationOptions,
                );
                return result(operation, null);
            case 'plugin_fs.stat_v1':
                return result(
                    operation,
                    await services.fs.stat(
                        operation.path,
                        operationOptions,
                    ),
                );
            case 'plugin_fs.list_v1':
                return result(
                    operation,
                    await services.fs.list(operation.path, {
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_fs.remove_v1':
                await services.fs.remove(operation.path, {
                    ...(operation.recursive !== undefined
                        ? { recursive: operation.recursive }
                        : {}),
                    ...operationOptions,
                });
                return result(operation, null);
            case 'plugin_resources.describe_v1':
                return result(
                    operation,
                    services.resources.describe(operation.id),
                );
            case 'plugin_resources.read_v1':
                return result(
                    operation,
                    await services.resources.read(operation.id, {
                        ...(operation.maxBytes !== undefined
                            ? { maxBytes: operation.maxBytes }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_resources.watch.open_v1':
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        services.resources.watch(
                            operation.id,
                            (change) => {
                                publish({
                                    kind:
                                        'plugin_resources.watch.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    change,
                                });
                            },
                        ),
                    'latest',
                );
                return result(operation, null);
            case 'plugin_mcp.list_v1':
                return result(
                    operation,
                    await invocation.currentGlobalMcp.list({
                        ...(operation.sessionId
                            ? { sessionId: operation.sessionId }
                            : {}),
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_mcp.discover_v1':
                return result(
                    operation,
                    await invocation.currentGlobalMcp.discover(
                        operation.provider,
                        {
                            ...(operation.input
                                ? {
                                    input:
                                        decodeJsonValue(
                                            operation.input,
                                        ),
                                }
                                : {}),
                            ...(operation.cursor
                                ? { cursor: operation.cursor }
                                : {}),
                            ...(operation.limit !== undefined
                                ? { limit: operation.limit }
                                : {}),
                        },
                        operationOptions,
                    ),
                );
            case 'plugin_mcp.connect_v1': {
                if (invocation.mcpClients.has(operation.clientId)) {
                    return fail(
                        'plugin_mcp_client_duplicate',
                        'MCP client identity already exists',
                    );
                }
                const client = await invocation.currentGlobalMcp.connect(
                    operation.ref,
                    {
                        ...(operation.sessionId
                            ? { sessionId: operation.sessionId }
                            : {}),
                        elicitation: operation.elicitation,
                        ...operationOptions,
                    },
                );
                invocation.mcpClients.set(
                    operation.clientId,
                    client,
                );
                return result(operation, null);
            }
            case 'plugin_mcp.client.list_tools_v1': {
                const client =
                    invocation.mcpClients.get(operation.clientId)
                    ?? fail(
                        'plugin_mcp_client_unavailable',
                        'MCP client is unavailable',
                    );
                return result(
                    operation,
                    await client.listTools({
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...operationOptions,
                    }),
                );
            }
            case 'plugin_mcp.client.call_tool_v1': {
                const client =
                    invocation.mcpClients.get(operation.clientId)
                    ?? fail(
                        'plugin_mcp_client_unavailable',
                        'MCP client is unavailable',
                    );
                return result(
                    operation,
                    await client.callTool(
                        operation.name,
                        decodeJsonValue(
                            operation.input,
                        ),
                        operationOptions,
                    ),
                );
            }
            case 'plugin_mcp.client.list_resources_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                return result(operation, await client.listResources({
                    ...(operation.cursor ? { cursor: operation.cursor } : {}),
                    ...operationOptions,
                }));
            }
            case 'plugin_mcp.client.list_resource_templates_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                return result(operation, await client.listResourceTemplates({
                    ...(operation.cursor ? { cursor: operation.cursor } : {}),
                    ...operationOptions,
                }));
            }
            case 'plugin_mcp.client.read_resource_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                return result(
                    operation,
                    await client.readResource(operation.uri, operationOptions),
                );
            }
            case 'plugin_mcp.client.subscribe_resource.open_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                if (invocation.subscriptions.has(operation.subscriptionId)) {
                    return fail(
                        'plugin_service_subscription_duplicate',
                        'Plugin service subscription already exists',
                    );
                }
                let publish: ((event: SubscriptionEvent) => void) | null = null;
                const buffered: SubscriptionEvent[] = [];
                const disposable = await client.subscribeResource(
                    operation.uri,
                    (event) => {
                        const wireEvent: SubscriptionEvent = {
                            kind: 'plugin_mcp.client.subscribe_resource.event_v1',
                            invocationId: operation.invocationId,
                            subscriptionId: operation.subscriptionId,
                            event,
                        };
                        if (publish) publish(wireEvent);
                        else buffered.push(wireEvent);
                    },
                    operationOptions,
                );
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publishEvent) => {
                        publish = publishEvent;
                        for (const event of buffered.splice(0)) publishEvent(event);
                        return disposable;
                    },
                    'fifo',
                );
                return result(operation, null);
            }
            case 'plugin_mcp.client.list_prompts_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                return result(operation, await client.listPrompts({
                    ...(operation.cursor ? { cursor: operation.cursor } : {}),
                    ...operationOptions,
                }));
            }
            case 'plugin_mcp.client.get_prompt_v1': {
                const client = invocation.mcpClients.get(operation.clientId)
                    ?? fail('plugin_mcp_client_unavailable', 'MCP client is unavailable');
                return result(
                    operation,
                    await client.getPrompt(
                        operation.name,
                        operation.args,
                        operationOptions,
                    ),
                );
            }
            case 'plugin_mcp.client.close_v1': {
                const client =
                    invocation.mcpClients.get(operation.clientId);
                invocation.mcpClients.delete(operation.clientId);
                await client?.dispose();
                return result(operation, null);
            }
            case 'plugin_notifications.send_v1':
                return result(
                    operation,
                    await services.notifications.send({
                        ...operation.request,
                        ...(operation.request.data
                            ? {
                                data:
                                    decodeJsonValue(
                                        operation.request.data,
                                    ),
                            }
                            : {}),
                    }, operationOptions),
                );
            case 'plugin_notifications.list_channels_v1':
                return result(
                    operation,
                    await services.notifications.listChannels({
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_notifications.list_categories_v1':
                return result(
                    operation,
                    await services.notifications.listCategories({
                        ...(operation.cursor
                            ? { cursor: operation.cursor }
                            : {}),
                        ...(operation.limit !== undefined
                            ? { limit: operation.limit }
                            : {}),
                        ...operationOptions,
                    }),
                );
            case 'plugin_notifications.preferences_v1':
                return result(
                    operation,
                    await services.notifications.preferences(
                        operation.categoryId,
                        operationOptions,
                    ),
                );
            case 'plugin_notifications.watch_preferences.open_v1':
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        services.notifications.watchPreferences(
                            operation.categoryId,
                            (preferences) => {
                                publish({
                                    kind:
                                        'plugin_notifications.watch_preferences.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    preferences: {
                                        ...preferences,
                                        channelIds: [
                                            ...preferences
                                                .channelIds,
                                        ],
                                    },
                                });
                            },
                        ),
                    'latest',
                );
                return result(operation, null);
            case 'plugin_connected_accounts.get_binding_v1':
                return result(
                    operation,
                    await (await connectedAccountsFor(
                        operation.serviceScope,
                    )).getBinding(
                        operation.purpose,
                        operationOptions,
                    ),
                );
            case 'plugin_connected_accounts.request_selection_v1':
                return result(
                    operation,
                    await (await connectedAccountsFor(
                        operation.serviceScope,
                    )).requestSelection({
                        purpose: operation.purpose,
                        reason: operation.reason,
                    }, operationOptions),
                );
            case 'plugin_connected_accounts.materialize_v1':
                return result(
                    operation,
                    await (await connectedAccountsFor(
                        operation.serviceScope,
                    )).materialize(
                        operation.purpose,
                        operation.request,
                        operation.expectedAccount === undefined
                            ? operationOptions
                            : {
                                ...operationOptions,
                                expectedAccount: operation.expectedAccount,
                            },
                    ),
                );
            case 'plugin_connected_accounts.list_accounts_v1':
                return result(
                    operation,
                    await (await connectedAccountsFor(
                        operation.serviceScope,
                    )).listAccounts({
                        purpose: operation.purpose,
                        ...(operation.limit === undefined
                            ? {}
                            : { limit: operation.limit }),
                    }, operationOptions),
                );
            case 'plugin_connected_accounts.materialize_listed_account_v1':
                return result(
                    operation,
                    await (await connectedAccountsFor(
                        operation.serviceScope,
                    )).materializeListedAccount({
                        purpose: operation.purpose,
                        account: operation.account,
                        materialization: operation.request,
                    }, operationOptions),
                );
            case 'plugin_connected_accounts.watch.open_v1': {
                const connectedAccounts =
                    await connectedAccountsFor(
                        operation.serviceScope,
                    );
                openSubscription(
                    invocation,
                    operation.subscriptionId,
                    (publish) =>
                        connectedAccounts.watch(
                            operation.purpose,
                            () => {
                                const event: SubscriptionEvent = {
                                    kind:
                                        'plugin_connected_accounts.watch.event_v1',
                                    invocationId:
                                        operation.invocationId,
                                    subscriptionId:
                                        operation.subscriptionId,
                                    event: { kind: 'resync' },
                                };
                                publish(event);
                            },
                        ),
                    'latest',
                    operation.serviceScope === 'managedProvider'
                        ? 'managedProvider'
                        : 'agent',
                );
                return result(operation, null);
            }
            case 'plugin_connected_accounts.watch.next_v1':
            case 'plugin_services.subscription.next_v1': {
                const subscription =
                    invocation.subscriptions.get(
                        operation.subscriptionId,
                    )
                    ?? fail(
                        'plugin_service_subscription_unavailable',
                        'Plugin service subscription is unavailable',
                    );
                if (
                    subscription.authorityScope
                        === 'managedProvider'
                ) {
                    await requireManagedProvider();
                }
                if (
                    operation.kind
                        === 'plugin_services.subscription.next_v1'
                    && subscription.awaitDeliverySettlement
                ) {
                    const settlement =
                        subscription.deliveredSettlement;
                    if (settlement) {
                        if (!operation.acknowledgement) {
                            return fail(
                                'plugin_service_subscription_acknowledgement_missing',
                                'Plugin service subscription delivery requires acknowledgement',
                            );
                        }
                        subscription.deliveredSettlement = null;
                        if (operation.acknowledgement === 'settled') {
                            settlement.resolve();
                            if (settlement.acknowledgeOnly) {
                                return result(operation, null);
                            }
                        } else {
                            settlement.reject(new PluginError({
                                code:
                                    'plugin_external_follow_listener_failed',
                                message:
                                    'External Sessions follow listener rejected delivery',
                            }));
                            return result(operation, null);
                        }
                    } else if (operation.acknowledgement) {
                        return fail(
                            'plugin_service_subscription_acknowledgement_invalid',
                            'Plugin service subscription has no delivery to acknowledge',
                        );
                    }
                }
                const queued = subscription.queue.shift();
                if (queued) {
                    subscription.deliveredSettlement =
                        queued.settlement;
                    return result(operation, queued.event);
                }
                if (subscription.waiter) {
                    return fail(
                        'plugin_service_subscription_wait_pending',
                        'Plugin service subscription already has a pending wait',
                    );
                }
                const delivery = await new Promise<SubscriptionDelivery>(
                    (resolve, reject) => {
                        const waiter: SubscriptionWaiter = {
                            resolve,
                            reject,
                            ...(signal ? { signal } : {}),
                            ...(signal
                                ? {
                                    abort: () => {
                                        if (
                                            subscription.waiter
                                            !== waiter
                                        ) return;
                                        subscription.waiter =
                                            null;
                                        reject(signal.reason);
                                    },
                                }
                                : {}),
                        };
                        subscription.waiter = waiter;
                        if (waiter.abort && signal) {
                            signal.addEventListener(
                                'abort',
                                waiter.abort,
                                { once: true },
                            );
                            if (signal.aborted) waiter.abort();
                        }
                    },
                );
                subscription.deliveredSettlement =
                    delivery.settlement;
                return result(operation, delivery.event);
            }
            case 'plugin_services.subscription.close_v1':
                await closeSubscription(
                    invocation,
                    operation.subscriptionId,
                );
                return result(operation, null);
            case 'plugin_exec.agent_cli.check_readiness_v1':
                return result(
                    operation,
                    await services.exec.agentCli.checkReadiness({
                        ...operation.request,
                        ...operationOptions,
                    }),
                );
            case 'plugin_exec.system_tools.resolve_v1': {
                const resolved =
                    await services.exec.systemTools.resolve({
                        ...operation.request,
                        ...operationOptions,
                    });
                const resolutionId = randomUUID();
                invocation.systemToolResolutions.set(
                    resolutionId,
                    resolved.executable,
                );
                return result(operation, {
                    resolutionId,
                    result: resolved,
                });
            }
            case 'plugin_exec.launch.authorize_v1': {
                let executable = operation.request.executable;
                if (operation.systemToolResolutionId) {
                    const resolved =
                        invocation.systemToolResolutions.get(
                            operation.systemToolResolutionId,
                        );
                    invocation.systemToolResolutions.delete(
                        operation.systemToolResolutionId,
                    );
                    if (
                        !resolved
                        || !sameExecutable(resolved, executable)
                    ) {
                        return fail(
                            'plugin_exec_system_tool_resolution_invalid',
                            'System-tool resolution is unavailable or does not match the launch',
                        );
                    }
                    executable = resolved;
                }
                const {
                    stdin,
                    ...request
                } = operation.request;
                const launch =
                    await authorizePluginExecLaunchForHost(
                        services.exec,
                        {
                            ...request,
                            executable,
                        ...(stdin !== undefined
                                ? {
                                    stdin: new Uint8Array(
                                        Buffer.from(
                                            stdin,
                                            'base64',
                                        ),
                                    ),
                                }
                                : {}),
                        },
                        operationOptions,
                    );
                const authorizationId = randomUUID();
                invocation.execAuthorizations.set(
                    authorizationId,
                    launch,
                );
                return result(operation, {
                    authorizationId,
                    launch: {
                        command: launch.command,
                        args: [...launch.args],
                        env: { ...launch.env },
                        ...(launch.cwd ? { cwd: launch.cwd } : {}),
                        ...(launch.stdin
                            ? {
                                stdin:
                                    Buffer.from(launch.stdin)
                                        .toString('base64'),
                            }
                            : {}),
                        ...(launch.timeoutMs !== undefined
                            ? { timeoutMs: launch.timeoutMs }
                            : {}),
                        ...(launch.maxStdoutBytes !== undefined
                            ? {
                                maxStdoutBytes:
                                    launch.maxStdoutBytes,
                            }
                            : {}),
                        ...(launch.maxStderrBytes !== undefined
                            ? {
                                maxStderrBytes:
                                    launch.maxStderrBytes,
                            }
                            : {}),
                        ...(launch.windowsVerbatimArguments
                            ? {
                                windowsVerbatimArguments:
                                    true,
                            }
                            : {}),
                    },
                });
            }
            case 'plugin_exec.launch.release_v1': {
                const authorization =
                    invocation.execAuthorizations.get(
                        operation.authorizationId,
                    );
                invocation.execAuthorizations.delete(
                    operation.authorizationId,
                );
                authorization?.release();
                return result(operation, null);
            }
            default:
                return fail(
                    'plugin_service_operation_unavailable',
                    'Runner PluginServices operation is unavailable',
                );
        }
    };

    const readManagedProviderSupervisionAuthority = async (
        authorityInput: Readonly<{
            sessionId: string;
            runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
            retainedAgent: AgentSessionRunnerBindingV1;
            contributionId: string;
            operationClaimId: string;
            serverId?: string;
        }>,
    ): Promise<Readonly<{
        bootstrap: RunnerDaemonManagedProviderBootstrapV1;
        expectedLaunch:
            RunnerManagedProviderServerLaunchAuthority | null;
    }> | null> => {
        if (disposed) return null;
        const exact: Readonly<{
            bootstrap: RunnerDaemonManagedProviderBootstrapV1;
            expectedLaunch:
                RunnerManagedProviderServerLaunchAuthority | null;
        }>[] = [];
        for (const invocation of invocations.values()) {
            const managedProvider = invocation.managedProvider;
            const scope = managedProvider?.bootstrap.scope;
            if (
                invocation.disposed
                || !hasExactInvocationAuthority(
                    invocation,
                    authorityInput.sessionId,
                    authorityInput.runner,
                    authorityInput.retainedAgent,
                )
                || !managedProvider
                || !scope
                || scope.sessionId
                    !== authorityInput.sessionId
                || `${scope.pluginId}/providers/${scope.providerLocalId}`
                    !== authorityInput.contributionId
                || scope.operationClaimId
                    !== authorityInput.operationClaimId
                || !await managedProvider.isCurrent()
            ) continue;
            exact.push(Object.freeze({
                bootstrap: managedProvider.bootstrap,
                expectedLaunch: authorityInput.serverId
                    ? managedProvider
                        .readSupervisionLaunchAuthority(
                            authorityInput.serverId,
                        )
                    : null,
            }));
            if (exact.length > 1) return null;
        }
        return exact[0] ?? null;
    };

    return Object.freeze({
        readManagedProviderSupervisionAuthority,
        dispatch,
        dispose() {
            disposal ??= (async () => {
                disposed = true;
                const pending = [...pendingCreations.entries()];
                for (const [controller] of pending) {
                    controller.abort(
                        'Runner PluginServices host is disposed',
                    );
                }
                await Promise.all([
                    ...invocations.values(),
                ].map(disposeInvocation).concat(
                    pending.map(([, completion]) => completion),
                ));
            })();
            return disposal;
        },
    });
}
