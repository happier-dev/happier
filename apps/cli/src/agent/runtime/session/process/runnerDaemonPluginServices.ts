import { randomUUID } from 'node:crypto';

import type { ZodType } from 'zod';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type {
    JsonValue,
} from '@happier-dev/plugin-sdk';
import type {
    PluginActionInputById,
    PluginActionResultById,
    PluginInvocableActionId } from '@happier-dev/plugin-sdk/actions';
import type {
    McpClient as PluginMcpClient } from '@happier-dev/plugin-sdk/mcp';
import type {
    PluginCancellationOptions,
    PluginContributionRef,
    PluginServiceId,
    PluginServices } from '@happier-dev/plugin-sdk';
import type {
    ScopedSettingsService,
    SettingsScopeRef,
} from '@happier-dev/plugin-sdk/settings';
import type {
    HostEventEnvelope,
    HostEventId,
    HostEventTarget } from '@happier-dev/plugin-sdk/events';
import type {
    DaemonDatabaseStorageScope,
    StorageScopeService,
} from '@happier-dev/plugin-sdk/storage';
import {
    parseHostEventPayloadV1,
} from '@happier-dev/protocol';
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
import {
    PLUGIN_ACTION_OUTPUT_SCHEMAS,
} from '@happier-dev/protocol/actions';

import type {
    AgentInvocationTurnAdmissionWitness,
} from '@/plugins/runtime/invocation/services/types';
import {
    EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
} from '@/session/external/hostOperationOwner';
import {
    projectAgentRuntimeDaemonServiceTurnWitnessV1,
} from './agentRuntimeDaemonServiceTurnWitness';
import {
    createStableRunnerPluginExecService,
    type HostAuthorizedPluginExecLaunch,
} from '@/plugins/runtime/invocation/services/exec';
import type {
    RunnerDaemonManagedProviderBootstrapV1,
    RunnerDaemonManagedProviderRetentionV1,
    RunnerDaemonPluginSettingsScopeV1,
    RunnerDaemonProviderOperationIdV1,
    RunnerDaemonPluginServiceOperationV1,
    RunnerDaemonPluginServiceSubscriptionEventV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import {
    RunnerDaemonManagedProviderBootstrapV1Schema,
    RunnerDaemonManagedProviderRetentionV1Schema,
    RunnerDaemonPluginServiceSubscriptionEventV1Schema,
    decodeRunnerDaemonPluginServiceWireValueV1,
    encodeRunnerDaemonPluginServiceWireValueV1,
} from './agentRuntimeDaemonPluginServicesProtocol';

export type RunnerDaemonPluginServicesDispatchOptionsV1 =
    Readonly<{
        signal?: AbortSignal;
        timeoutMs?: number | null;
    }>;

export type RunnerDaemonPluginServicesDispatchV1 = (
    operation: RunnerDaemonPluginServiceOperationV1,
    options?: RunnerDaemonPluginServicesDispatchOptionsV1,
) => Promise<unknown>;

type DaemonServiceId = Exclude<
    PluginServiceId,
    | 'logger'
    | 'sessions'
    | 'managedServices'
    | 'targetedContributions'
    | 'interactions'
    | 'composerContent'
>;
// Runner protocol V1 keeps its existing `fetch` field/kind; this boundary maps
// that wire spelling to the contracted author/runtime `http` service.
type DaemonServiceWireId = Exclude<DaemonServiceId, 'http'> | 'fetch';
type RunnerPluginEventRef = Parameters<
    PluginServices['events']['plugin']['subscribe']
>[0];

function hostEventDeliveryMatchesTarget(
    target: HostEventTarget,
    deliveryScope:
        | Readonly<{ kind: 'account' }>
        | Readonly<{ kind: 'session'; sessionId: string }>,
): boolean {
    if (target.scope.kind === 'account') {
        return deliveryScope.kind === 'account';
    }
    if (deliveryScope.kind !== 'session') {
        return false;
    }
    return target.scope.kind === 'current-session'
        || target.scope.sessionId === deliveryScope.sessionId;
}

const pluginActionOutputSchemas: Readonly<
    Partial<Record<string, ZodType>>
> = PLUGIN_ACTION_OUTPUT_SCHEMAS;

type PreparedRunnerDaemonPluginServicesSnapshotV1 = Readonly<{
    availability: Readonly<Record<
        DaemonServiceWireId,
        ReturnType<PluginServices['availability']>
    >>;
    storageConsistency: Readonly<Record<
        'ephemeral' | 'daemonSession' | 'daemon',
        ReturnType<StorageScopeService['consistency']>
            | null
    >>;
    settingsDescriptors: Readonly<Record<
        RunnerDaemonPluginSettingsScopeV1,
        ReturnType<ScopedSettingsService['describe']>
    >>;
    resourceDescriptors: Readonly<
        Record<
            string,
            ReturnType<PluginServices['resources']['describe']>
        >
    >;
    subscriptionCapabilities: Readonly<{
        settingsWatch: boolean;
        eventSubscriptions: readonly Readonly<{
            pluginId: string;
            localId: string;
        }>[];
        resourceWatches: readonly string[];
        notificationPreferencesWatch: boolean;
    }>;
    managedProvider: RunnerDaemonManagedProviderBootstrapV1 | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

const RUNNER_STORAGE_SCOPE_IDS = [
    'ephemeral',
    'daemonSession',
    'daemon',
] as const;

function isPreparedStorageConsistency(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    if (
        keys.length !== RUNNER_STORAGE_SCOPE_IDS.length
        || !RUNNER_STORAGE_SCOPE_IDS.every((scope) =>
            Object.prototype.hasOwnProperty.call(value, scope))
    ) {
        return false;
    }
    return RUNNER_STORAGE_SCOPE_IDS.every((scope) => {
        const consistency = value[scope];
        return consistency === null
            || (
                isRecord(consistency)
                && consistency.kind === 'authoritativeSerializable'
                && Object.keys(consistency).length === 1
            );
    });
}

function sameManagedProviderRetentionScope(
    left: RunnerDaemonManagedProviderRetentionV1['scope'],
    right: RunnerDaemonManagedProviderRetentionV1['scope'],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

type RunnerAuthorizedLaunchWire = Readonly<{
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd?: string;
    stdin?: string;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    windowsVerbatimArguments?: true;
}>;

function isRunnerAuthorizedLaunchWire(
    value: unknown,
): value is RunnerAuthorizedLaunchWire {
    return isRecord(value)
        && typeof value.command === 'string'
        && Array.isArray(value.args)
        && value.args.every(
            (entry) => typeof entry === 'string',
        )
        && isRecord(value.env)
        && Object.values(value.env).every(
            (entry) => typeof entry === 'string',
        )
        && (
            value.cwd === undefined
            || typeof value.cwd === 'string'
        )
        && (
            value.stdin === undefined
            || typeof value.stdin === 'string'
        )
        && (
            value.timeoutMs === undefined
            || typeof value.timeoutMs === 'number'
        )
        && (
            value.maxStdoutBytes === undefined
            || typeof value.maxStdoutBytes === 'number'
        )
        && (
            value.maxStderrBytes === undefined
            || typeof value.maxStderrBytes === 'number'
        )
        && (
            value.windowsVerbatimArguments === undefined
            || value.windowsVerbatimArguments === true
        );
}

function parsePreparedSnapshot(
    value: unknown,
): PreparedRunnerDaemonPluginServicesSnapshotV1 {
    if (
        !isRecord(value)
        || !isRecord(value.availability)
        || !isPreparedStorageConsistency(value.storageConsistency)
        || !isRecord(value.settingsDescriptors)
        || !Array.isArray(value.settingsDescriptors.account)
        || !Array.isArray(value.settingsDescriptors.daemon)
        || !isRecord(value.resourceDescriptors)
        || !isRecord(value.subscriptionCapabilities)
        || typeof value.subscriptionCapabilities.settingsWatch
            !== 'boolean'
        || !Array.isArray(
            value.subscriptionCapabilities.eventSubscriptions,
        )
        || !value.subscriptionCapabilities.eventSubscriptions
            .every((entry) =>
                isRecord(entry)
                && typeof entry.pluginId === 'string'
                && typeof entry.localId === 'string')
        || !Array.isArray(
            value.subscriptionCapabilities.resourceWatches,
        )
        || !value.subscriptionCapabilities.resourceWatches
            .every((entry) => typeof entry === 'string')
        || typeof value.subscriptionCapabilities
            .notificationPreferencesWatch !== 'boolean'
    ) {
        throw new PluginError({
            code: 'plugin_services_prepare_invalid',
            message:
                'Daemon returned an invalid PluginServices preparation snapshot',
        });
    }
    const managedProvider = value.managedProvider === undefined
        ? null
        : RunnerDaemonManagedProviderBootstrapV1Schema.safeParse(
            value.managedProvider,
        );
    if (
        managedProvider !== null
        && !managedProvider.success
    ) {
        throw new PluginError({
            code: 'plugin_services_prepare_invalid',
            message:
                'Daemon returned an invalid managed Provider preparation bootstrap',
        });
    }
    return Object.freeze({
        ...(value as Omit<
            PreparedRunnerDaemonPluginServicesSnapshotV1,
            'managedProvider'
        >),
        managedProvider:
            managedProvider === null
                ? null
                : managedProvider.data,
    });
}

function decodeRunnerDaemonPluginServiceJsonValueV1<
    T extends JsonValue,
>(
    value: Parameters<
        typeof decodeRunnerDaemonPluginServiceWireValueV1
    >[0],
): T;
function decodeRunnerDaemonPluginServiceJsonValueV1(
    value: Parameters<
        typeof decodeRunnerDaemonPluginServiceWireValueV1
    >[0],
): JsonValue {
    const decoded =
        decodeRunnerDaemonPluginServiceWireValueV1(value);
    const convert = (
        candidate: ReturnType<
            typeof decodeRunnerDaemonPluginServiceWireValueV1
        >,
    ): JsonValue => {
        if (candidate instanceof Uint8Array) {
            throw new PluginError({
                code: 'plugin_service_json_value_invalid',
                message:
                    'Binary data is not valid in this JSON service event',
            });
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

function throwUnavailable(
    serviceId: PluginServiceId,
    availability: ReturnType<PluginServices['availability']>,
): never {
    throw new PluginError({
        code:
            availability.status === 'available'
                ? 'plugin_service_unavailable'
                : availability.code,
        message: `Plugin service '${serviceId}' is unavailable in the current runner invocation`,
        details: { serviceId },
    });
}

function failPreparedStorageConsistency(
    scope: string,
): never {
    throw new PluginError({
        code: 'plugin_storage_consistency_unavailable',
        message:
            `Daemon did not provide storage consistency for '${scope}'`,
    });
}

function readDaemonWitness(
    read:
        | (() => AgentInvocationTurnAdmissionWitness | null)
        | undefined,
) {
    const witness = read?.();
    return witness
        ? projectAgentRuntimeDaemonServiceTurnWitnessV1(witness)
        : undefined;
}

export async function prepareRunnerDaemonPluginServices(
    input: Readonly<{
        invocationId: string;
        dispatch: RunnerDaemonPluginServicesDispatchV1;
        signal: AbortSignal;
        isAuthorityTransitionError?(error: unknown): boolean;
        readActiveTurnAdmissionWitness?():
            AgentInvocationTurnAdmissionWitness | null;
        readManagedProviderRetention?():
            | RunnerDaemonManagedProviderRetentionV1
            | null
            | Promise<
                RunnerDaemonManagedProviderRetentionV1 | null
            >;
        bindManagedServices?(input: Readonly<{
            connectedAccounts:
                PluginServices['connectedAccounts'];
            exec: PluginServices['exec'];
            managedProvider: Readonly<{
                bootstrap:
                    RunnerDaemonManagedProviderBootstrapV1;
                connectedAccounts:
                    PluginServices['connectedAccounts'];
                exec: PluginServices['exec'];
                isCurrent(): boolean;
            }> | null;
        }>): PluginServices['managedServices'];
        onManagedProviderStarted?(input: Readonly<{
            bootstrap: RunnerDaemonManagedProviderBootstrapV1;
            materialize(input: Readonly<{
                endpointUrl: string;
                credentialPlaceholder: string;
            }>): Promise<unknown>;
            registerLaunchEnvironmentTransformer(
                transform: (
                    environment: Readonly<Record<string, string>>,
                ) => Readonly<Record<string, string>>,
            ): void;
        }>): Promise<void>;
        local: Pick<
            PluginServices,
            | 'availability'
            | 'logger'
            | 'sessions'
            | 'managedServices'
            | 'targetedContributions'
            | 'interactions'
            | 'composerContent'
            | 'exec'
        >;
    }>,
): Promise<PluginServices> {
    let prepared:
        PreparedRunnerDaemonPluginServicesSnapshotV1;
    let prepareInFlight:
        Promise<PreparedRunnerDaemonPluginServicesSnapshotV1>
        | null = null;
    let prepareRevision = 0;
    let managedProviderRetention:
        RunnerDaemonManagedProviderRetentionV1 | null = null;
    let refreshManagedServicesBinding:
        (() => void) | null = null;
    let launchEnvironmentTransformer:
        ((environment: Readonly<Record<string, string>>) =>
            Readonly<Record<string, string>>) | null = null;
    const retainedFromBootstrap = (
        bootstrap: RunnerDaemonManagedProviderBootstrapV1,
    ): RunnerDaemonManagedProviderRetentionV1 => Object.freeze({
        v: 1 as const,
        scope: bootstrap.scope,
        providerPluginHardRevocationRevisionAtAdmission:
            bootstrap
                .providerPluginHardRevocationRevisionAtAdmission,
    });
    const startPreparedManagedProvider = async (
        snapshot: PreparedRunnerDaemonPluginServicesSnapshotV1,
        send: RunnerDaemonPluginServicesDispatchV1 = input.dispatch,
    ): Promise<void> => {
        if (!snapshot.managedProvider) return;
        await send({
            kind: 'plugin_services.managed_provider.start_v1',
            requestId: randomUUID(),
            invocationId: input.invocationId,
            retained: retainedFromBootstrap(
                snapshot.managedProvider,
            ),
        });
    };
    const prepareCurrentAuthority = async () => {
        prepareInFlight ??= (async () => {
            const recoveredRetention =
                managedProviderRetention
                ?? (input.readManagedProviderRetention
                    ? await input.readManagedProviderRetention()
                    : null);
            const requestedRetention = recoveredRetention
                ? RunnerDaemonManagedProviderRetentionV1Schema.parse(
                    recoveredRetention,
                )
                : null;
            managedProviderRetention = requestedRetention;
            const snapshot = parsePreparedSnapshot(
                await input.dispatch({
                kind: 'plugin_services.prepare_v1',
                requestId: randomUUID(),
                invocationId: input.invocationId,
                ...(managedProviderRetention
                    ? { managedProviderRetention }
                    : {}),
                ...(() => {
                    const witness = readDaemonWitness(
                        input.readActiveTurnAdmissionWitness,
                    );
                    return witness ? { witness } : {};
                })(),
                }),
            );
            prepareRevision += 1;
            if (
                requestedRetention
                && snapshot.managedProvider
                && (
                    !sameManagedProviderRetentionScope(
                        requestedRetention.scope,
                        snapshot.managedProvider.scope,
                    )
                    || snapshot.managedProvider
                        .providerPluginHardRevocationRevisionAtAdmission
                        !== requestedRetention
                            .providerPluginHardRevocationRevisionAtAdmission
                )
            ) {
                throw new PluginError({
                    code:
                        'plugin_services_managed_provider_retention_mismatch',
                    message:
                        'Replacement daemon returned a different managed Provider than the retained Session authority',
                });
            }
            prepared = snapshot;
            refreshManagedServicesBinding?.();
            if (refreshManagedServicesBinding) {
                await startPreparedManagedProvider(snapshot);
                managedProviderRetention = snapshot.managedProvider
                    ? retainedFromBootstrap(
                        snapshot.managedProvider,
                    )
                    : requestedRetention;
            }
            return snapshot;
        })();
        const pending = prepareInFlight;
        try {
            return await pending;
        } finally {
            if (prepareInFlight === pending) {
                prepareInFlight = null;
            }
        }
    };
    prepared = await prepareCurrentAuthority();
    const availability = (serviceId: PluginServiceId) => {
        if (
            serviceId === 'logger'
            || serviceId === 'sessions'
            || serviceId === 'managedServices'
            || serviceId === 'targetedContributions'
            || serviceId === 'interactions'
            || serviceId === 'composerContent'
        ) {
            return input.local.availability(serviceId);
        }
        return serviceId === 'http'
            ? prepared.availability.fetch
            : prepared.availability[serviceId];
    };
    const readErrorCode = (error: unknown): string | null =>
        isPluginError(error) ? error.code : null;
    const dispatch = async <T>(
        operation: RunnerDaemonPluginServiceOperationV1,
        options?: RunnerDaemonPluginServicesDispatchOptionsV1,
    ): Promise<T> => {
        const observedPrepareRevision = prepareRevision;
        const lifecycleCleanup =
            operation.kind === 'plugin_services.close_v1'
            || operation.kind
                === 'plugin_services.subscription.close_v1'
            || operation.kind === 'plugin_mcp.client.close_v1'
            || operation.kind
                === 'plugin_exec.launch.release_v1'
            || operation.kind
                === 'plugin_storage.transaction.rollback_v1';
        const ensurePreparedAfterObservedAuthority = async () => {
            if (prepareRevision !== observedPrepareRevision) {
                return prepared;
            }
            return await prepareCurrentAuthority();
        };
        try {
            return await input.dispatch(operation, options) as T;
        } catch (error) {
            if (
                readErrorCode(error)
                === 'plugin_services_invocation_unavailable'
            ) {
                if (
                    lifecycleCleanup
                    && operation.kind
                        !== 'plugin_services.close_v1'
                ) {
                    throw error;
                }
                // The daemon proved this exact request was rejected before
                // reaching any canonical service method. Reprepare the same
                // invocation on the current authority and retry once.
                await ensurePreparedAfterObservedAuthority();
                return await input.dispatch(
                    operation,
                    options,
                ) as T;
            }
            if (input.isAuthorityTransitionError?.(error)) {
                // The failed request may have reached its old daemon. Never
                // replay it. Preparing B is lifecycle-only and makes the
                // next caller operation usable while preserving ambiguity.
                if (!lifecycleCleanup) {
                    await ensurePreparedAfterObservedAuthority()
                        .catch(() => undefined);
                }
            }
            throw error;
        }
    };
    const requestBase = () => {
        const witness = readDaemonWitness(
            input.readActiveTurnAdmissionWitness,
        );
        return {
            requestId: randomUUID(),
            invocationId: input.invocationId,
            ...(witness ? { witness } : {}),
        };
    };
    type LoggerEntry = Extract<
        RunnerDaemonPluginServiceOperationV1,
        { kind: 'plugin_logger.write_v1' }
    >['entry'];
    const enqueueLoggerEntry = (entry: LoggerEntry): void => {
        try {
            void dispatch({
                kind: 'plugin_logger.write_v1',
                ...requestBase(),
                entry,
            }).catch(() => undefined);
        } catch {
            // Logging remains strictly failure-isolated from plugin work.
        }
    };
    type LogMethod = PluginServices['logger']['debug'];
    const enqueueLog = (
        level: 'debug' | 'info' | 'warn' | 'error',
        message: Parameters<LogMethod>[0],
        fields?: Parameters<LogMethod>[1],
    ): void => {
        try {
            enqueueLoggerEntry({
                kind: 'log',
                level,
                message,
                ...(fields
                    ? {
                        fields:
                            encodeRunnerDaemonPluginServiceWireValueV1(
                                fields,
                            ),
                    }
                    : {}),
            });
        } catch {
            // Invalid plugin-controlled fields cannot affect plugin work.
        }
    };
    const logger = Object.freeze({
        debug(
            message: Parameters<LogMethod>[0],
            fields?: Parameters<LogMethod>[1],
        ) {
            enqueueLog('debug', message, fields);
        },
        info(
            message: Parameters<LogMethod>[0],
            fields?: Parameters<LogMethod>[1],
        ) {
            enqueueLog('info', message, fields);
        },
        warn(
            message: Parameters<LogMethod>[0],
            fields?: Parameters<LogMethod>[1],
        ) {
            enqueueLog('warn', message, fields);
        },
        error(
            message: Parameters<LogMethod>[0],
            fields?: Parameters<LogMethod>[1],
        ) {
            enqueueLog('error', message, fields);
        },
        diagnostic(
            data: Parameters<
                PluginServices['logger']['diagnostic']
            >[0],
        ) {
            try {
                enqueueLoggerEntry({
                    kind: 'diagnostic',
                    data: {
                        code: data.code,
                        severity: data.severity,
                        ...(data.message !== undefined
                            ? { message: data.message }
                            : {}),
                        ...(data.details !== undefined
                            ? {
                                details:
                                    encodeRunnerDaemonPluginServiceWireValueV1(
                                        data.details,
                                    ),
                            }
                            : {}),
                        ...(data.remediation !== undefined
                            ? { remediation: data.remediation }
                            : {}),
                    },
                });
            } catch {
                // Diagnostics stay failure-isolated from plugin work.
            }
        },
    } satisfies PluginServices['logger']);
    const assertAvailable = (serviceId: DaemonServiceId): void => {
        const state = availability(serviceId);
        if (state.status !== 'available') {
            throwUnavailable(serviceId, state);
        }
    };
    const assertSubscriptionAvailable = (
        serviceId: DaemonServiceId,
        available: boolean,
    ): void => {
        assertAvailable(serviceId);
        if (!available) {
            throw new PluginError({
                code: 'plugin_service_subscription_unavailable',
                message:
                    `Plugin service '${serviceId}' subscription is unavailable for this invocation`,
            });
        }
    };
    const invokeProvider = async <TResult>(
        operation: RunnerDaemonProviderOperationIdV1,
        request: unknown,
        signal?: AbortSignal,
    ): Promise<TResult> => {
        assertAvailable('providers');
        return await dispatch<TResult>({
            kind: 'plugin_providers.invoke_v1',
            ...requestBase(),
            operation,
            request: encodeRunnerDaemonPluginServiceWireValueV1(
                request,
            ),
        }, signal ? { signal } : undefined);
    };
    const providers: PluginServices['providers'] = Object.freeze({
        connections: Object.freeze({
            async describe(request: ProviderConnectionsDescribeRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['connections']['describe']
                >>>('connections.describe', request, options?.signal);
            },
            async mutate(request: ProviderConnectionMutationRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['connections']['mutate']
                >>>('connections.mutate', request, options?.signal);
            },
            async bindingStatus(request: ProviderBindingStatusRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['connections']['bindingStatus']
                >>>('connections.bindingStatus', request, options?.signal);
            },
        }),
        catalog: Object.freeze({
            async probe(request: ProviderProbeRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['catalog']['probe']
                >>>('catalog.probe', request, options?.signal);
            },
            async listModels(request: ProviderModelsRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['catalog']['listModels']
                >>>('catalog.listModels', request, options?.signal);
            },
            async setModelLoad(request: ProviderModelLoadRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['catalog']['setModelLoad']
                >>>('catalog.setModelLoad', request, options?.signal);
            },
            async projectModels(request: ProviderModelProjectionRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['catalog']['projectModels']
                >>>('catalog.projectModels', request, options?.signal);
            },
            async mutateModelSettings(request: ProviderModelSettingsMutationRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['catalog']['mutateModelSettings']
                >>>('catalog.mutateModelSettings', request, options?.signal);
            },
        }),
        migrations: Object.freeze({
            async preview(request: ProviderProfileMigrationPreviewRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['migrations']['preview']
                >>>('migrations.preview', request, options?.signal);
            },
            async confirm(request: ProviderProfileMigrationConfirmRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['migrations']['confirm']
                >>>('migrations.confirm', request, options?.signal);
            },
            async confirmConflict(request: ProviderProfileMigrationConflictConfirmRequest, options?: PluginCancellationOptions) {
                return await invokeProvider<Awaited<ReturnType<
                    PluginServices['providers']['migrations']['confirmConflict']
                >>>('migrations.confirmConflict', request, options?.signal);
            },
        }),
    });
    function executeAction<K extends PluginInvocableActionId>(
        actionId: K,
        actionInput: PluginActionInputById[K],
        options?: PluginCancellationOptions,
    ): Promise<PluginActionResultById[K]>;
    function executeAction(
        action: PluginContributionRef,
        actionInput: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<JsonValue | void>;
    async function executeAction(
        actionOrRef: PluginInvocableActionId | PluginContributionRef,
        actionInput: PluginActionInputById[PluginInvocableActionId] | JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<unknown> {
        if (typeof actionOrRef !== 'string') {
            throw new PluginError({
                code:
                    'plugin_action_generation_private_unavailable',
                message:
                    'A retained Runner cannot substitute the current plugin generation for an exact generation-private action handler',
            });
        }
        assertAvailable('actions');
        const wireResult = await dispatch({
            kind: 'plugin_actions.execute_v1',
            ...requestBase(),
            actionId: actionOrRef,
            input:
                encodeRunnerDaemonPluginServiceWireValueV1(
                    actionInput,
                ),
        }, options?.signal
            ? { signal: options.signal }
            : undefined);
        const outputSchema = pluginActionOutputSchemas[actionOrRef];
        const parsedOutput = outputSchema?.safeParse(wireResult);
        if (!parsedOutput?.success) {
            throw new PluginError({
                code: 'plugin_action_result_schema_invalid',
                message:
                    'Plugin action result does not match its canonical output schema',
            });
        }
        return parsedOutput.data;
    }

    async function executeContributedActionWithOrigin(): Promise<never> {
        throw new PluginError({
            code: 'plugin_action_generation_private_unavailable',
            message: 'A retained Runner cannot substitute the current plugin generation for an exact generation-private action handler',
        });
    }

    async function executeAdmittedTargetedOperation(): Promise<never> {
        throw new PluginError({
            code: 'plugin_action_generation_private_unavailable',
            message: 'A retained Runner cannot substitute the current plugin generation for an exact admitted targeted operation',
        });
    }

    const actions: PluginServices['actions'] = Object.freeze({
        execute: executeAction,
        executeAdmittedTargetedOperation,
        executeWithExecutionOrigin: executeContributedActionWithOrigin,
        executeAdmittedTargetedOperationWithExecutionOrigin: executeAdmittedTargetedOperation,
    } satisfies PluginServices['actions']);
    const createStorageScope = (
        scope: keyof PreparedRunnerDaemonPluginServicesSnapshotV1[
            'storageConsistency'
        ],
    ): StorageScopeService => Object.freeze({
        consistency() {
            assertAvailable('storage');
            return prepared.storageConsistency[scope]
                ?? failPreparedStorageConsistency(scope);
        },
        async get<T extends JsonValue = JsonValue>(key: string, options?: { signal?: AbortSignal }) {
            assertAvailable('storage');
            return await dispatch<T | null>({
                kind: 'plugin_storage.get_v1',
                ...requestBase(),
                scope,
                key,
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        async set(key, value, options) {
            assertAvailable('storage');
            await dispatch<null>({
                kind: 'plugin_storage.set_v1',
                ...requestBase(),
                scope,
                key,
                value:
                    encodeRunnerDaemonPluginServiceWireValueV1(
                        value,
                    ),
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        async delete(key, options) {
            assertAvailable('storage');
            await dispatch<null>({
                kind: 'plugin_storage.delete_v1',
                ...requestBase(),
                scope,
                key,
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        async list(options) {
            assertAvailable('storage');
            return await dispatch({
                kind: 'plugin_storage.list_v1',
                ...requestBase(),
                scope,
                ...(options?.cursor
                    ? { cursor: options.cursor }
                    : {}),
                ...(options?.limit !== undefined
                    ? { limit: options.limit }
                    : {}),
                ...(options?.prefix !== undefined
                    ? { prefix: options.prefix }
                    : {}),
            }, options?.signal ? { signal: options.signal } : undefined);
        },
        async transaction(operation, options) {
            assertAvailable('storage');
            const transactionId = randomUUID();
            await dispatch<null>({
                kind: 'plugin_storage.transaction.open_v1',
                ...requestBase(),
                transactionId,
                scope,
            }, options?.signal
                ? { signal: options.signal }
                : undefined);
            const transaction = Object.freeze({
                async get<T extends JsonValue = JsonValue>(
                    key: string,
                    commandOptions?: Readonly<{
                        signal?: AbortSignal;
                    }>,
                ) {
                    return await dispatch<T | null>({
                        kind:
                            'plugin_storage.transaction.get_v1',
                        ...requestBase(),
                        transactionId,
                        key,
                    }, commandOptions?.signal
                        ? { signal: commandOptions.signal }
                        : undefined);
                },
                async set(
                    key: string,
                    value: JsonValue,
                    commandOptions?: Readonly<{
                        signal?: AbortSignal;
                    }>,
                ) {
                    await dispatch<null>({
                        kind:
                            'plugin_storage.transaction.set_v1',
                        ...requestBase(),
                        transactionId,
                        key,
                        value:
                            encodeRunnerDaemonPluginServiceWireValueV1(
                                value,
                            ),
                    }, commandOptions?.signal
                        ? { signal: commandOptions.signal }
                        : undefined);
                },
                async delete(
                    key: string,
                    commandOptions?: Readonly<{
                        signal?: AbortSignal;
                    }>,
                ) {
                    await dispatch<null>({
                        kind:
                            'plugin_storage.transaction.delete_v1',
                        ...requestBase(),
                        transactionId,
                        key,
                    }, commandOptions?.signal
                        ? { signal: commandOptions.signal }
                        : undefined);
                },
            });
            try {
                const value = await operation(transaction);
                await dispatch<null>({
                    kind:
                        'plugin_storage.transaction.commit_v1',
                    ...requestBase(),
                    transactionId,
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
                return value;
            } catch (error) {
                await dispatch<null>({
                    kind:
                        'plugin_storage.transaction.rollback_v1',
                    requestId: randomUUID(),
                    invocationId: input.invocationId,
                    transactionId,
                }, {
                    timeoutMs: 1_000,
                }).catch(() => undefined);
                throw error;
            }
        },
    } satisfies StorageScopeService);
    // The runner protocol carries only the existing daemon KV surface. It has
    // no database operation or file-handle authority, so do not manufacture a
    // second SQLite owner across this process boundary.
    const daemonStorage: DaemonDatabaseStorageScope = Object.freeze({
        ...createStorageScope('daemon'),
        async database(): Promise<never> {
            assertAvailable('storage');
            throw new PluginError({
                code: 'daemon_database_unavailable',
                message: 'Daemon database access is unavailable in the runner process',
            });
        },
    });
    const storage: PluginServices['storage'] = Object.freeze({
        ephemeral: createStorageScope('ephemeral'),
        daemonSession: createStorageScope('daemonSession'),
        daemon: daemonStorage,
    });
    const createDaemonSubscription = <T>(
        serviceId: DaemonServiceId,
        label: string,
        createOpen: (
            subscriptionId: string,
        ) => RunnerDaemonPluginServiceOperationV1,
        decode: (
            event: RunnerDaemonPluginServiceSubscriptionEventV1,
        ) => T | null,
        listener: (event: T) => void | Promise<void>,
        recoverLostHandle: boolean,
        cancellationSignal?: AbortSignal,
    ): Readonly<{ dispose(): void }> => {
        assertAvailable(serviceId);
        const controller = new AbortController();
        let disposed = false;
        let activeSubscriptionId: string | null = null;
        const abortFromInvocation = () => {
            controller.abort(input.signal.reason);
        };
        const abortFromCancellation = () => {
            controller.abort(cancellationSignal?.reason);
            if (activeSubscriptionId) {
                close(activeSubscriptionId);
            }
        };
        if (input.signal.aborted) {
            abortFromInvocation();
        } else {
            input.signal.addEventListener(
                'abort',
                abortFromInvocation,
                { once: true },
            );
        }
        const close = (subscriptionId: string): void => {
            void dispatch<null>({
                kind:
                    'plugin_services.subscription.close_v1',
                requestId: randomUUID(),
                invocationId: input.invocationId,
                subscriptionId,
            }, {
                timeoutMs: 1_000,
            }).catch(() => undefined);
        };
        if (cancellationSignal?.aborted) {
            abortFromCancellation();
        } else {
            cancellationSignal?.addEventListener(
                'abort',
                abortFromCancellation,
                { once: true },
            );
        }
        const deliver = async (event: T): Promise<void> => {
            if (controller.signal.aborted) return;
            try {
                await listener(event);
            } catch {
                input.local.logger.warn(`${label} listener failed`);
            }
        };
        const pump = async (): Promise<void> => {
            while (!controller.signal.aborted) {
                const subscriptionId = randomUUID();
                activeSubscriptionId = subscriptionId;
                try {
                    await dispatch<null>(
                        createOpen(subscriptionId),
                        { signal: controller.signal },
                    );
                } catch (error) {
                    if (
                        !controller.signal.aborted
                        && input.isAuthorityTransitionError?.(
                            error,
                        )
                    ) {
                        continue;
                    }
                    return;
                }
                try {
                    while (!controller.signal.aborted) {
                        const rawEvent =
                            await dispatch<unknown>({
                                kind:
                                    'plugin_services.subscription.next_v1',
                                ...requestBase(),
                                subscriptionId,
                            }, {
                                signal: controller.signal,
                                timeoutMs: null,
                            });
                        const parsed =
                            RunnerDaemonPluginServiceSubscriptionEventV1Schema
                                .safeParse(rawEvent);
                        const event = parsed.success
                            && parsed.data.invocationId
                                === input.invocationId
                            && parsed.data.subscriptionId
                                === subscriptionId
                            ? decode(parsed.data)
                            : null;
                        if (event === null) {
                            throw new PluginError({
                                code:
                                    'plugin_service_subscription_event_invalid',
                                message:
                                    `Daemon returned an invalid ${label} event`,
                            });
                        }
                        await deliver(event);
                    }
                } catch (error) {
                    if (controller.signal.aborted) return;
                    close(subscriptionId);
                    if (
                        recoverLostHandle
                        && readErrorCode(error)
                            === 'plugin_service_subscription_unavailable'
                    ) {
                        continue;
                    }
                    if (
                        !input.isAuthorityTransitionError?.(
                            error,
                        )
                    ) {
                        return;
                    }
                }
            }
        };
        void pump();
        return Object.freeze({
            dispose() {
                if (disposed) return;
                disposed = true;
                input.signal.removeEventListener(
                    'abort',
                    abortFromInvocation,
                );
                cancellationSignal?.removeEventListener(
                    'abort',
                    abortFromCancellation,
                );
                controller.abort();
                if (activeSubscriptionId) {
                    close(activeSubscriptionId);
                }
            },
        });
    };
    const readSettingsScope = (
        scope: SettingsScopeRef,
    ): RunnerDaemonPluginSettingsScopeV1 => {
        if (scope?.kind === 'account' || scope?.kind === 'daemon') {
            return scope.kind;
        }
        throw new PluginError({
            code: 'plugin_settings_scope_unavailable',
            message: 'Plugin Settings scope is unavailable',
        });
    };
    const createScopedSettings = (
        scope: RunnerDaemonPluginSettingsScopeV1,
    ): ScopedSettingsService => Object.freeze({
        async snapshot() {
            assertAvailable('settings');
            return await dispatch<Awaited<ReturnType<
                ScopedSettingsService['snapshot']
            >>>({
                kind: 'plugin_settings.snapshot_v1',
                ...requestBase(),
                scope,
            });
        },
        async get<T extends JsonValue = JsonValue>(id: string) {
            assertAvailable('settings');
            return await dispatch<T | null>({
                kind: 'plugin_settings.get_v1',
                ...requestBase(),
                scope,
                id,
            });
        },
        async set(
            id: string,
            value: JsonValue,
            options: Parameters<ScopedSettingsService['set']>[2],
        ) {
            assertAvailable('settings');
            return await dispatch<Awaited<ReturnType<
                ScopedSettingsService['set']
            >>>({
                kind: 'plugin_settings.set_v1',
                ...requestBase(),
                scope,
                id,
                value:
                    encodeRunnerDaemonPluginServiceWireValueV1(
                        value,
                    ),
                ...(options?.expectedRevision
                    ? {
                        expectedRevision:
                            options.expectedRevision,
                    }
                    : {}),
            });
        },
        async reset(
            id: string,
            options: Parameters<ScopedSettingsService['reset']>[1],
        ) {
            assertAvailable('settings');
            return await dispatch<Awaited<ReturnType<
                ScopedSettingsService['reset']
            >>>({
                kind: 'plugin_settings.reset_v1',
                ...requestBase(),
                scope,
                id,
                ...(options?.expectedRevision
                    ? {
                        expectedRevision:
                            options.expectedRevision,
                    }
                    : {}),
            });
        },
        describe() {
            assertAvailable('settings');
            return prepared.settingsDescriptors[scope];
        },
        watch(listener: Parameters<ScopedSettingsService['watch']>[0]) {
            assertSubscriptionAvailable(
                'settings',
                prepared.subscriptionCapabilities.settingsWatch,
            );
            return createDaemonSubscription(
                'settings',
                'settings watch',
                (subscriptionId) => ({
                    kind: 'plugin_settings.watch.open_v1',
                    ...requestBase(),
                    scope,
                    subscriptionId,
                }),
                (event) => event.kind
                    === 'plugin_settings.watch.event_v1'
                    && event.scope === scope
                    ? {
                        scope: { kind: scope },
                        revision: event.change.revision,
                        changedIds: [
                            ...event.change.changedIds,
                        ],
                        values: Object.fromEntries<JsonValue>(
                            Object.entries(
                                event.change.values,
                            ).map(([id, value]) => [
                                id,
                                decodeRunnerDaemonPluginServiceJsonValueV1(
                                    value,
                                ),
                            ]),
                        ),
                    }
                    : null,
                listener,
                false,
            );
        },
    });
    const settings: PluginServices['settings'] = Object.freeze({
        forScope(scope) {
            return createScopedSettings(readSettingsScope(scope));
        },
    } satisfies PluginServices['settings']);
    const secrets: PluginServices['secrets'] = Object.freeze({
        async status(id) {
            assertAvailable('secrets');
            return await dispatch<Awaited<ReturnType<
                PluginServices['secrets']['status']
            >>>({
                kind: 'plugin_secrets.status_v1',
                ...requestBase(),
                id,
            });
        },
        async get(id, options) {
            assertAvailable('secrets');
            return await dispatch<string>({
                kind: 'plugin_secrets.get_v1',
                ...requestBase(),
                id,
                ...(options?.reason
                    ? { reason: options.reason }
                    : {}),
            });
        },
        async set(id, value, options) {
            assertAvailable('secrets');
            return await dispatch<Awaited<ReturnType<
                PluginServices['secrets']['set']
            >>>({
                kind: 'plugin_secrets.set_v1',
                ...requestBase(),
                id,
                value,
                ...(options?.expectedRevision
                    ? {
                        expectedRevision:
                            options.expectedRevision,
                    }
                    : {}),
            });
        },
        async delete(id, options) {
            assertAvailable('secrets');
            return await dispatch<Awaited<ReturnType<
                PluginServices['secrets']['delete']
            >>>({
                kind: 'plugin_secrets.delete_v1',
                ...requestBase(),
                id,
                ...(options?.expectedRevision
                    ? {
                        expectedRevision:
                            options.expectedRevision,
                    }
                    : {}),
            });
        },
    } satisfies PluginServices['secrets']);
    const hostEvents: PluginServices['events']['host'] =
        Object.freeze({
            subscribe<Id extends HostEventId>(
                target: HostEventTarget<Id>,
                listener: (
                    event: HostEventEnvelope<Id>,
                ) => void | Promise<void>,
            ) {
                return createDaemonSubscription<
                    HostEventEnvelope<Id>
                >(
                    'events',
                    'Host Event subscription',
                    (subscriptionId) => ({
                        kind:
                            'plugin_events.host.subscribe.open_v1',
                        ...requestBase(),
                        subscriptionId,
                        target,
                    }),
                    (candidate) => {
                        if (
                            candidate.kind
                                !== 'plugin_events.host.subscribe.event_v1'
                            || candidate.event.eventId
                                !== target.eventId
                        ) {
                            return null;
                        }
                        if (!hostEventDeliveryMatchesTarget(
                            target,
                            candidate.event.scope,
                        )) {
                            throw new PluginError({
                                code:
                                    'plugin_host_event_scope_mismatch',
                                message:
                                    'Daemon Host Event delivery does not match the subscription target',
                            });
                        }
                        const payload = parseHostEventPayloadV1(
                            target.eventId,
                            decodeRunnerDaemonPluginServiceWireValueV1(
                                candidate.event.payload,
                            ),
                        );
                        if (
                            candidate.event.scope.kind === 'session'
                            && (
                                !('sessionId' in payload)
                                || payload.sessionId !== candidate.event.scope.sessionId
                            )
                        ) {
                            throw new PluginError({
                                code:
                                    'plugin_host_event_scope_mismatch',
                                message:
                                    'Daemon Host Event payload does not match its session scope',
                            });
                        }
                        return Object.freeze({
                            eventId: target.eventId,
                            scope: Object.freeze({
                                ...candidate.event.scope,
                            }),
                            payload,
                        }) as HostEventEnvelope<Id>;
                    },
                    listener,
                    false,
                );
            },
        });
    const events: PluginServices['events'] = Object.freeze({
        plugin: Object.freeze({
        async emit(
            eventId: Parameters<
                PluginServices['events']['plugin']['emit']
            >[0],
            payload: Parameters<
                PluginServices['events']['plugin']['emit']
            >[1],
        ) {
            assertAvailable('events');
            return await dispatch<Awaited<ReturnType<
                PluginServices['events']['plugin']['emit']
            >>>({
                kind: 'plugin_events.emit_v1',
                ...requestBase(),
                eventId,
                payload:
                    encodeRunnerDaemonPluginServiceWireValueV1(
                        payload,
                    ),
            });
        },
        subscribe<T extends JsonValue>(
            event: RunnerPluginEventRef,
            listener: (
                event: Readonly<{
                    ref: RunnerPluginEventRef;
                    payload: T;
                    sequence: number;
                }>,
            ) => void | Promise<void>,
        ) {
            assertSubscriptionAvailable(
                'events',
                prepared.subscriptionCapabilities.eventSubscriptions
                    .some((candidate) =>
                        candidate.pluginId === event.pluginId
                        && candidate.localId === event.localId),
            );
            return createDaemonSubscription<
                Readonly<{
                    ref: RunnerPluginEventRef;
                    payload: T;
                    sequence: number;
                }>
            >(
                'events',
                'event subscription',
                (subscriptionId) => ({
                    kind: 'plugin_events.subscribe.open_v1',
                    ...requestBase(),
                    subscriptionId,
                    event,
                }),
                (candidate) => candidate.kind
                    === 'plugin_events.subscribe.event_v1'
                    ? {
                        ref: candidate.event.ref,
                        payload:
                            decodeRunnerDaemonPluginServiceJsonValueV1<T>(
                                candidate.event.payload,
                            ),
                        sequence:
                            candidate.event.sequence,
                    }
                    : null,
                listener,
                false,
            );
        },
        }),
        host: hostEvents,
    } satisfies PluginServices['events']);
    const httpService: PluginServices['http'] = Object.freeze({
        async request(request) {
            assertAvailable('http');
            return await dispatch<Awaited<ReturnType<
                PluginServices['http']['request']
            >>>({
                kind: 'plugin_fetch.request_v1',
                ...requestBase(),
                request: {
                    url: request.url,
                    redirect: request.redirect,
                    ...(request.method
                        ? { method: request.method }
                        : {}),
                    ...(request.headers
                        ? { headers: request.headers }
                        : {}),
                    ...(request.body
                        ? {
                            body:
                                Buffer.from(request.body)
                                    .toString('base64'),
                        }
                        : {}),
                    ...(request.timeoutMs !== undefined
                        ? { timeoutMs: request.timeoutMs }
                        : {}),
                    ...(request.credentialBinding
                        ? {
                            credentialBinding:
                                encodeRunnerDaemonPluginServiceWireValueV1(
                                    request.credentialBinding,
                                ),
                        }
                        : {}),
                },
            });
        },
        async openWebSocket() {
            // The runner wire owns finite request/response HTTP only. There
            // is no session-runner WebSocket producer or duplex lifecycle.
            throwUnavailable('http', {
                status: 'unavailable',
                code: 'plugin_service_unavailable',
            });
        },
    } satisfies PluginServices['http']);
    const fs: PluginServices['fs'] = Object.freeze({
        async readFile(path, options) {
            assertAvailable('fs');
            return await dispatch<Uint8Array>({
                kind: 'plugin_fs.read_file_v1',
                ...requestBase(),
                path,
                ...(options?.maxBytes !== undefined
                    ? { maxBytes: options.maxBytes }
                    : {}),
            });
        },
        async writeFile(path, data) {
            assertAvailable('fs');
            await dispatch<null>({
                kind: 'plugin_fs.write_file_v1',
                ...requestBase(),
                path,
                data: Buffer.from(data).toString('base64'),
            });
        },
        async stat(path) {
            assertAvailable('fs');
            return await dispatch<Awaited<ReturnType<
                PluginServices['fs']['stat']
            >>>({
                kind: 'plugin_fs.stat_v1',
                ...requestBase(),
                path,
            });
        },
        async list(path, options) {
            assertAvailable('fs');
            return await dispatch<Awaited<ReturnType<
                PluginServices['fs']['list']
            >>>({
                kind: 'plugin_fs.list_v1',
                ...requestBase(),
                path,
                ...(options?.cursor
                    ? { cursor: options.cursor }
                    : {}),
                ...(options?.limit !== undefined
                    ? { limit: options.limit }
                    : {}),
            });
        },
        async remove(path, options) {
            assertAvailable('fs');
            await dispatch<null>({
                kind: 'plugin_fs.remove_v1',
                ...requestBase(),
                path,
                ...(options?.recursive !== undefined
                    ? { recursive: options.recursive }
                    : {}),
            });
        },
    } satisfies PluginServices['fs']);
    const resources: PluginServices['resources'] = Object.freeze({
        describe(id) {
            assertAvailable('resources');
            const descriptor =
                prepared.resourceDescriptors[id];
            if (!descriptor) {
                throw new PluginError({
                    code: 'plugin_resource_undeclared',
                    message: `Plugin resource '${id}' is undeclared`,
                });
            }
            return descriptor;
        },
        async read(id, options) {
            assertAvailable('resources');
            return await dispatch<Awaited<ReturnType<
                PluginServices['resources']['read']
            >>>({
                kind: 'plugin_resources.read_v1',
                ...requestBase(),
                id,
                ...(options?.maxBytes !== undefined
                    ? { maxBytes: options.maxBytes }
                    : {}),
            });
        },
        watch(id, listener) {
            assertSubscriptionAvailable(
                'resources',
                prepared.subscriptionCapabilities.resourceWatches
                    .includes(id),
            );
            return createDaemonSubscription(
                'resources',
                'resource watch',
                (subscriptionId) => ({
                    kind: 'plugin_resources.watch.open_v1',
                    ...requestBase(),
                    subscriptionId,
                    id,
                }),
                (event) => event.kind
                    === 'plugin_resources.watch.event_v1'
                    ? event.change
                    : null,
                listener,
                true,
            );
        },
    } satisfies PluginServices['resources']);
    const mcp: PluginServices['mcp'] = Object.freeze({
        async list(query) {
            assertAvailable('mcp');
            return await dispatch<Awaited<ReturnType<
                PluginServices['mcp']['list']
            >>>({
                kind: 'plugin_mcp.list_v1',
                ...requestBase(),
                ...(query?.sessionId
                    ? { sessionId: query.sessionId }
                    : {}),
                ...(query?.cursor
                    ? { cursor: query.cursor }
                    : {}),
                ...(query?.limit !== undefined
                    ? { limit: query.limit }
                    : {}),
            });
        },
        async discover(provider, query) {
            assertAvailable('mcp');
            return await dispatch<Awaited<ReturnType<
                PluginServices['mcp']['discover']
            >>>({
                kind: 'plugin_mcp.discover_v1',
                ...requestBase(),
                provider,
                ...(query?.input !== undefined
                    ? {
                        input:
                            encodeRunnerDaemonPluginServiceWireValueV1(
                                query.input,
                            ),
                    }
                    : {}),
                ...(query?.cursor
                    ? { cursor: query.cursor }
                    : {}),
                ...(query?.limit !== undefined
                    ? { limit: query.limit }
                    : {}),
            });
        },
        async connect(ref, options) {
            assertAvailable('mcp');
            const clientId = randomUUID();
            await dispatch<null>({
                kind: 'plugin_mcp.connect_v1',
                ...requestBase(),
                clientId,
                ref,
                ...(options.sessionId
                    ? { sessionId: options.sessionId }
                    : {}),
                elicitation: options.elicitation,
            });
            let closed = false;
            let disposal: Promise<void> | null = null;
            const client: PluginMcpClient = Object.freeze({
                async listTools(query) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['listTools']
                    >>>({
                        kind:
                            'plugin_mcp.client.list_tools_v1',
                        ...requestBase(),
                        clientId,
                        ...(query?.cursor
                            ? { cursor: query.cursor }
                            : {}),
                        ...(query?.limit !== undefined
                            ? { limit: query.limit }
                            : {}),
                    }, query?.signal
                        ? { signal: query.signal }
                        : undefined);
                },
                async callTool(name, toolInput, options) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<JsonValue>({
                        kind:
                            'plugin_mcp.client.call_tool_v1',
                        ...requestBase(),
                        clientId,
                        name,
                        input:
                            encodeRunnerDaemonPluginServiceWireValueV1(
                                toolInput,
                            ),
                    }, options?.signal
                        ? { signal: options.signal }
                        : undefined);
                },
                async listResources(query) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['listResources']
                    >>>({
                            kind:
                                'plugin_mcp.client.list_resources_v1',
                            ...requestBase(),
                            clientId,
                            ...(query?.cursor
                                ? { cursor: query.cursor }
                                : {}),
                        }, query?.signal
                            ? { signal: query.signal }
                            : undefined);
                },
                async listResourceTemplates(query) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['listResourceTemplates']
                    >>>({
                            kind:
                                'plugin_mcp.client.list_resource_templates_v1',
                            ...requestBase(),
                            clientId,
                            ...(query?.cursor
                                ? { cursor: query.cursor }
                                : {}),
                        }, query?.signal
                            ? { signal: query.signal }
                            : undefined);
                },
                async readResource(uri, options) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['readResource']
                    >>>({
                            kind:
                                'plugin_mcp.client.read_resource_v1',
                            ...requestBase(),
                            clientId,
                            uri,
                        }, options?.signal
                            ? { signal: options.signal }
                            : undefined);
                },
                async subscribeResource(
                    uri,
                    listener,
                    options,
                ) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return createDaemonSubscription(
                        'mcp',
                        'MCP resource subscription',
                        (subscriptionId) => ({
                            kind: 'plugin_mcp.client.subscribe_resource.open_v1',
                            ...requestBase(),
                            clientId,
                            subscriptionId,
                            uri,
                        }),
                        (event) => event.kind === 'plugin_mcp.client.subscribe_resource.event_v1'
                            ? event.event
                            : null,
                        listener,
                        true,
                        options?.signal,
                    );
                },
                async listPrompts(query) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['listPrompts']
                    >>>({
                            kind:
                                'plugin_mcp.client.list_prompts_v1',
                            ...requestBase(),
                            clientId,
                            ...(query?.cursor
                                ? { cursor: query.cursor }
                                : {}),
                        }, query?.signal
                            ? { signal: query.signal }
                            : undefined);
                },
                async getPrompt(name, args, options) {
                    if (closed) {
                        throw new PluginError({
                            code: 'plugin_mcp_client_closed',
                            message: 'MCP client is closed',
                        });
                    }
                    return await dispatch<Awaited<ReturnType<
                        PluginMcpClient['getPrompt']
                    >>>({
                            kind:
                                'plugin_mcp.client.get_prompt_v1',
                            ...requestBase(),
                            clientId,
                            name,
                            ...(args ? { args } : {}),
                        }, options?.signal
                            ? { signal: options.signal }
                            : undefined);
                },
                dispose() {
                    disposal ??= (async () => {
                        closed = true;
                        await dispatch<null>({
                            kind:
                                'plugin_mcp.client.close_v1',
                            requestId: randomUUID(),
                            invocationId:
                                input.invocationId,
                            clientId,
                        });
                    })();
                    return disposal;
                },
            } satisfies PluginMcpClient);
            return client;
        },
    } satisfies PluginServices['mcp']);
    const notifications: PluginServices['notifications'] =
        Object.freeze({
            async send(request) {
                assertAvailable('notifications');
                return await dispatch<Awaited<ReturnType<
                    PluginServices['notifications']['send']
                >>>({
                    kind: 'plugin_notifications.send_v1',
                    ...requestBase(),
                    request: {
                        clientRequestId:
                            request.clientRequestId,
                        categoryId: request.categoryId,
                        title: request.title,
                        ...(request.body
                            ? { body: request.body }
                            : {}),
                        ...(request.channelIds
                            ? {
                                channelIds: [
                                    ...request.channelIds,
                                ],
                            }
                            : {}),
                        ...(request.data !== undefined
                            ? {
                                data:
                                    encodeRunnerDaemonPluginServiceWireValueV1(
                                        request.data,
                                    ),
                            }
                            : {}),
                    },
                });
            },
            async listChannels(options) {
                assertAvailable('notifications');
                return await dispatch<Awaited<ReturnType<
                    PluginServices['notifications'][
                        'listChannels'
                    ]
                >>>({
                    kind:
                        'plugin_notifications.list_channels_v1',
                    ...requestBase(),
                    ...(options?.cursor
                        ? { cursor: options.cursor }
                        : {}),
                    ...(options?.limit !== undefined
                        ? { limit: options.limit }
                        : {}),
                });
            },
            async listCategories(options) {
                assertAvailable('notifications');
                return await dispatch<Awaited<ReturnType<
                    PluginServices['notifications'][
                        'listCategories'
                    ]
                >>>({
                    kind:
                        'plugin_notifications.list_categories_v1',
                    ...requestBase(),
                    ...(options?.cursor
                        ? { cursor: options.cursor }
                        : {}),
                    ...(options?.limit !== undefined
                        ? { limit: options.limit }
                        : {}),
                });
            },
            async preferences(categoryId) {
                assertAvailable('notifications');
                return await dispatch<Awaited<ReturnType<
                    PluginServices['notifications'][
                        'preferences'
                    ]
                >>>({
                    kind:
                        'plugin_notifications.preferences_v1',
                    ...requestBase(),
                    categoryId,
                });
            },
            watchPreferences(categoryId, listener) {
                assertSubscriptionAvailable(
                    'notifications',
                    prepared.subscriptionCapabilities
                        .notificationPreferencesWatch,
                );
                return createDaemonSubscription(
                    'notifications',
                    'notification-preferences watch',
                    (subscriptionId) => ({
                        kind:
                            'plugin_notifications.watch_preferences.open_v1',
                        ...requestBase(),
                        subscriptionId,
                        categoryId,
                    }),
                    (event) => event.kind
                        === 'plugin_notifications.watch_preferences.event_v1'
                        ? {
                            ...event.preferences,
                            channelIds: [
                                ...event.preferences.channelIds,
                            ],
                        }
                        : null,
                    listener,
                    true,
                );
            },
        } satisfies PluginServices['notifications']);
    const createConnectedAccounts = (
        serviceScope: 'managedProvider' | undefined,
    ): PluginServices['connectedAccounts'] => Object.freeze({
            async getBinding(purpose) {
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                return await dispatch<Awaited<ReturnType<
                    PluginServices['connectedAccounts'][
                        'getBinding'
                    ]
                >>>({
                    kind:
                        'plugin_connected_accounts.get_binding_v1',
                    ...requestBase(),
                    ...(serviceScope ? { serviceScope } : {}),
                    purpose,
                });
            },
            async requestSelection(request) {
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                return await dispatch<Awaited<ReturnType<
                    PluginServices['connectedAccounts'][
                        'requestSelection'
                    ]
                >>>({
                    kind:
                        'plugin_connected_accounts.request_selection_v1',
                    ...requestBase(),
                    ...(serviceScope ? { serviceScope } : {}),
                    purpose: request.purpose,
                    reason: request.reason,
                });
            },
            async materialize(purpose, request, options) {
                if (
                    options
                    && Object.prototype.hasOwnProperty.call(
                        options,
                        'account',
                    )
                ) {
                    throw new PluginError({
                        code:
                            'plugin_connected_account_binding_out_of_scope',
                        message:
                            'Connected Accounts materialization cannot select an account',
                    });
                }
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                return await dispatch<Awaited<ReturnType<
                    PluginServices['connectedAccounts'][
                        'materialize'
                    ]
                >>>({
                    kind:
                        'plugin_connected_accounts.materialize_v1',
                    ...requestBase(),
                    ...(serviceScope ? { serviceScope } : {}),
                    purpose,
                    expectedAccount: options?.expectedAccount
                        ? {
                            service: {
                                ...options.expectedAccount.service,
                            },
                            accountId:
                                options.expectedAccount.accountId,
                        }
                        : undefined,
                    request: request.kind === 'httpHeaders'
                        ? {
                            ...request,
                            headerNames:
                                [...request.headerNames],
                        }
                        : request.kind === 'environment'
                            ? {
                                ...request,
                                keys: [...request.keys],
                            }
                            : {
                                ...request,
                                fileIds: [...request.fileIds],
                            },
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async listAccounts(request, options) {
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                return await dispatch<Awaited<ReturnType<
                    PluginServices['connectedAccounts'][
                        'listAccounts'
                    ]
                >>>({
                    kind:
                        'plugin_connected_accounts.list_accounts_v1',
                    ...requestBase(),
                    ...(serviceScope ? { serviceScope } : {}),
                    purpose: request.purpose,
                    ...(request.limit === undefined
                        ? {}
                        : { limit: request.limit }),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async materializeListedAccount(request, options) {
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                const materialization = request.materialization;
                return await dispatch<Awaited<ReturnType<
                    PluginServices['connectedAccounts'][
                        'materializeListedAccount'
                    ]
                >>>({
                    kind:
                        'plugin_connected_accounts.materialize_listed_account_v1',
                    ...requestBase(),
                    ...(serviceScope ? { serviceScope } : {}),
                    purpose: request.purpose,
                    account: {
                        service: { ...request.account.service },
                        accountId: request.account.accountId,
                    },
                    request: materialization.kind === 'httpHeaders'
                        ? {
                            ...materialization,
                            headerNames:
                                [...materialization.headerNames],
                        }
                        : materialization.kind === 'environment'
                            ? {
                                ...materialization,
                                keys: [...materialization.keys],
                            }
                            : {
                                ...materialization,
                                fileIds: [...materialization.fileIds],
                            },
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            watch(purpose, listener) {
                if (!serviceScope) {
                    assertAvailable('connectedAccounts');
                }
                const controller = new AbortController();
                let disposed = false;
                let activeSubscriptionId: string | null = null;
                const abortFromInvocation = () => {
                    controller.abort(input.signal?.reason);
                };
                if (input.signal?.aborted) {
                    abortFromInvocation();
                } else {
                    input.signal?.addEventListener(
                        'abort',
                        abortFromInvocation,
                        { once: true },
                    );
                }
                const close = (
                    subscriptionId: string,
                ): void => {
                    void dispatch<null>({
                        kind:
                            'plugin_services.subscription.close_v1',
                        requestId: randomUUID(),
                        invocationId: input.invocationId,
                        subscriptionId,
                    }, {
                        timeoutMs: 1_000,
                    }).catch(() => undefined);
                };
                const deliverResync = (): void => {
                    if (controller.signal.aborted) return;
                    try {
                        listener(Object.freeze({ kind: 'resync' }));
                    } catch {
                        input.local.logger.warn(
                            'Connected-account watch listener failed',
                        );
                    }
                };
                const pump = async (): Promise<void> => {
                    while (!controller.signal.aborted) {
                        const subscriptionId = randomUUID();
                        activeSubscriptionId = subscriptionId;
                        try {
                            await dispatch<null>({
                                kind:
                                    'plugin_connected_accounts.watch.open_v1',
                                ...requestBase(),
                                ...(serviceScope
                                    ? { serviceScope }
                                    : {}),
                                subscriptionId,
                                purpose,
                            }, {
                                signal: controller.signal,
                            });
                        } catch (error) {
                            if (
                                !controller.signal.aborted
                                && input.isAuthorityTransitionError?.(
                                    error,
                                )
                            ) {
                                continue;
                            }
                            return;
                        }
                        try {
                            while (!controller.signal.aborted) {
                                const rawEvent =
                                    await dispatch<unknown>({
                                        kind:
                                            'plugin_connected_accounts.watch.next_v1',
                                        ...requestBase(),
                                        ...(serviceScope
                                            ? { serviceScope }
                                            : {}),
                                        subscriptionId,
                                    }, {
                                        signal: controller.signal,
                                        timeoutMs: null,
                                    });
                                const parsed =
                                    RunnerDaemonPluginServiceSubscriptionEventV1Schema
                                        .safeParse(rawEvent);
                                if (
                                    !parsed.success
                                    || parsed.data.invocationId
                                        !== input.invocationId
                                    || parsed.data.subscriptionId
                                        !== subscriptionId
                                ) {
                                    throw new PluginError({
                                        code:
                                            'plugin_service_subscription_event_invalid',
                                        message:
                                            'Daemon returned an invalid connected-account subscription event',
                                    });
                                }
                                deliverResync();
                            }
                        } catch (error) {
                            if (controller.signal.aborted) return;
                            close(subscriptionId);
                            if (
                                readErrorCode(error)
                                === 'plugin_service_subscription_unavailable'
                            ) {
                                continue;
                            }
                            if (
                                !input.isAuthorityTransitionError?.(
                                    error,
                                )
                            ) {
                                return;
                            }
                            continue;
                        }
                    }
                };
                void pump();
                return Object.freeze({
                    dispose() {
                        if (disposed) return;
                        disposed = true;
                        input.signal?.removeEventListener(
                            'abort',
                            abortFromInvocation,
                        );
                        controller.abort();
                        if (activeSubscriptionId) {
                            close(activeSubscriptionId);
                        }
                    },
                });
            },
        } satisfies PluginServices['connectedAccounts']);
    const connectedAccounts = createConnectedAccounts(undefined);
    const managedProviderConnectedAccounts =
        createConnectedAccounts('managedProvider');
    const parseObjectResult = (
        value: unknown,
        code: string,
        message: string,
    ): Record<string, unknown> => {
        if (!isRecord(value)) {
            throw new PluginError({ code, message });
        }
        return value;
    };
    const exec = createStableRunnerPluginExecService({
        signal: input.signal,
        isGenerationCurrent: () =>
            !input.signal.aborted,
        transformAgentChildLaunchEnvironment: (environment) =>
            launchEnvironmentTransformer
                ? launchEnvironmentTransformer(environment)
                : environment,
        agentCli: Object.freeze({
            async checkReadiness(
                request: Parameters<
                    PluginServices['exec']['agentCli'][
                        'checkReadiness'
                    ]
                >[0],
            ) {
                assertAvailable('exec');
                return await dispatch<Awaited<ReturnType<
                    PluginServices['exec']['agentCli'][
                        'checkReadiness'
                    ]
                >>>({
                    kind:
                        'plugin_exec.agent_cli.check_readiness_v1',
                    ...requestBase(),
                    request: {
                        candidates: [...request.candidates],
                        requirement: request.requirement,
                        ...(request.cwd
                            ? { cwd: request.cwd }
                            : {}),
                        ...(request.projectId
                            ? {
                                projectId:
                                    request.projectId,
                            }
                            : {}),
                        ...(request.workspaceId
                            ? {
                                workspaceId:
                                    request.workspaceId,
                            }
                            : {}),
                    },
                }, {
                    ...(request.signal
                        ? { signal: request.signal }
                        : {}),
                });
            },
        } satisfies PluginServices['exec']['agentCli']),
        async resolveSystemTool(request) {
            assertAvailable('exec');
            const raw = parseObjectResult(
                await dispatch<unknown>({
                    kind:
                        'plugin_exec.system_tools.resolve_v1',
                    ...requestBase(),
                    request: {
                        toolId: request.toolId,
                        purpose: request.purpose,
                        ...(request.cwd
                            ? { cwd: request.cwd }
                            : {}),
                        ...(request.preferredPath !== undefined
                            ? {
                                preferredPath:
                                    request.preferredPath,
                            }
                            : {}),
                    },
                }, {
                    ...(request.signal
                        ? { signal: request.signal }
                        : {}),
                }),
                'plugin_exec_system_tool_resolution_invalid',
                'Daemon returned an invalid system-tool resolution',
            );
            if (
                typeof raw.resolutionId !== 'string'
                || !isRecord(raw.result)
            ) {
                throw new PluginError({
                    code:
                        'plugin_exec_system_tool_resolution_invalid',
                    message:
                        'Daemon returned an invalid system-tool resolution',
                });
            }
            return {
                resolutionId: raw.resolutionId,
                result: raw.result as Awaited<ReturnType<
                    PluginServices['exec']['systemTools'][
                        'resolve'
                    ]
                >>,
            };
        },
        async authorizeLaunch(
            request: Parameters<
                PluginServices['exec']['spawn']
            >[0] & Readonly<{ timeoutMs?: number }>,
            options?: Parameters<
                PluginServices['exec']['spawn']
            >[1],
            systemToolResolutionId?: string,
        ) {
            assertAvailable('exec');
            const raw = parseObjectResult(
                await dispatch<unknown>({
                    kind:
                        'plugin_exec.launch.authorize_v1',
                    ...requestBase(),
                    ...(systemToolResolutionId
                        ? { systemToolResolutionId }
                        : {}),
                    request: {
                        executable: request.executable,
                        ...(request.args
                            ? { args: [...request.args] }
                            : {}),
                        ...(request.cwd
                            ? { cwd: request.cwd }
                            : {}),
                        ...(request.env
                            ? { env: { ...request.env } }
                            : {}),
                        ...(request.stdin
                            ? {
                                stdin:
                                    Buffer.from(request.stdin)
                                        .toString('base64'),
                            }
                            : {}),
                        ...(request.maxStdoutBytes !== undefined
                            ? {
                                maxStdoutBytes:
                                    request.maxStdoutBytes,
                            }
                            : {}),
                        ...(request.maxStderrBytes !== undefined
                            ? {
                                maxStderrBytes:
                                    request.maxStderrBytes,
                            }
                            : {}),
                        ...(request.timeoutMs !== undefined
                            ? {
                                timeoutMs:
                                    request.timeoutMs,
                            }
                            : {}),
                    },
                }, options),
                'plugin_exec_launch_authorization_invalid',
                'Daemon returned an invalid process launch authorization',
            );
            if (
                typeof raw.authorizationId !== 'string'
                || !isRunnerAuthorizedLaunchWire(raw.launch)
            ) {
                throw new PluginError({
                    code:
                        'plugin_exec_launch_authorization_invalid',
                    message:
                        'Daemon returned an invalid process launch authorization',
                });
            }
            let released = false;
            const authorizationId = raw.authorizationId;
            const launch = raw.launch;
            const command = launch.command;
            const args = launch.args;
            return Object.freeze({
                command,
                args: Object.freeze([...args]),
                env: Object.freeze({
                    ...launch.env,
                }),
                ...(typeof launch.cwd === 'string'
                    ? { cwd: launch.cwd }
                    : {}),
                ...(typeof launch.stdin === 'string'
                    ? {
                        stdin: new Uint8Array(
                            Buffer.from(
                                launch.stdin,
                                'base64',
                            ),
                        ),
                    }
                    : {}),
                ...(typeof launch.timeoutMs === 'number'
                    ? { timeoutMs: launch.timeoutMs }
                    : {}),
                ...(typeof launch.maxStdoutBytes === 'number'
                    ? {
                        maxStdoutBytes:
                            launch.maxStdoutBytes,
                    }
                    : {}),
                ...(typeof launch.maxStderrBytes === 'number'
                    ? {
                        maxStderrBytes:
                            launch.maxStderrBytes,
                    }
                    : {}),
                ...(launch.windowsVerbatimArguments === true
                    ? { windowsVerbatimArguments: true }
                    : {}),
                release() {
                    if (released) return;
                    released = true;
                    void dispatch<null>({
                        kind:
                            'plugin_exec.launch.release_v1',
                        requestId: randomUUID(),
                        invocationId: input.invocationId,
                        authorizationId,
                    }, {
                        timeoutMs: 1_000,
                    }).catch(() => undefined);
                },
            } satisfies HostAuthorizedPluginExecLaunch);
        },
    });
    let closeStarted = false;
    const closeInvocation = (): void => {
        if (closeStarted) return;
        closeStarted = true;
        void dispatch<null>({
            kind: 'plugin_services.close_v1',
            requestId: randomUUID(),
            invocationId: input.invocationId,
        }, {
            timeoutMs: 1_000,
        }).catch(() => undefined);
    };
    input.signal.addEventListener(
        'abort',
        closeInvocation,
        { once: true },
    );
    if (input.signal.aborted) closeInvocation();
    let managedServices = input.local.managedServices;
    if (input.bindManagedServices) {
        const localExec = input.local.exec;
        let initialBinding = true;
        refreshManagedServicesBinding = () => {
            const bindingRevision = prepareRevision;
            const bootstrap = prepared.managedProvider;
            const rebound = input.bindManagedServices!({
                connectedAccounts,
                exec: localExec,
                managedProvider: bootstrap
                    ? Object.freeze({
                        bootstrap,
                        connectedAccounts:
                            managedProviderConnectedAccounts,
                        exec: localExec,
                        isCurrent: () => (
                            !input.signal.aborted
                            && prepareRevision
                                === bindingRevision
                            && prepared.managedProvider
                                === bootstrap
                        ),
                    })
                    : null,
            });
            if (initialBinding) {
                managedServices = rebound;
                initialBinding = false;
            }
        };
        refreshManagedServicesBinding();
        await startPreparedManagedProvider(prepared, dispatch);
        managedProviderRetention = prepared.managedProvider
            ? retainedFromBootstrap(prepared.managedProvider)
            : null;
        if (
            prepared.managedProvider
            && input.onManagedProviderStarted
        ) {
            const bootstrap = prepared.managedProvider;
            await input.onManagedProviderStarted({
                bootstrap,
                registerLaunchEnvironmentTransformer(transform) {
                    if (launchEnvironmentTransformer) {
                        throw new PluginError({
                            code:
                                'plugin_services_managed_provider_materialization_already_attempted',
                            message:
                                'Managed Provider launch credential transformer is already registered',
                        });
                    }
                    launchEnvironmentTransformer = transform;
                },
                materialize: async ({
                    endpointUrl,
                    credentialPlaceholder,
                }) => {
                    return await dispatch({
                        kind:
                            'plugin_services.managed_provider.materialize_agent_binding_v1',
                        requestId: randomUUID(),
                        invocationId: input.invocationId,
                        retained:
                            retainedFromBootstrap(bootstrap),
                        endpointUrl,
                        credentialPlaceholder,
                    });
                },
            });
        }
    } else if (prepared.managedProvider) {
        throw new PluginError({
            code: 'plugin_services_managed_provider_custody_unavailable',
            message:
                'Runner managed Provider custody binding is unavailable',
        });
    }
    const externalSessions = Object.freeze({
            async capabilities(options) {
                return await dispatch<Awaited<ReturnType<
                    PluginServices['sessions']['external']['capabilities']
                >>>({
                    kind: 'plugin_sessions.external.capabilities_v1',
                    ...requestBase(),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async list(query, options) {
                return await dispatch<Awaited<ReturnType<
                    PluginServices['sessions']['external']['list']
                >>>({
                    kind: 'plugin_sessions.external.list_v1',
                    ...requestBase(),
                    ...(query
                        ? {
                            query:
                                encodeRunnerDaemonPluginServiceWireValueV1(
                                    query,
                                ),
                        }
                        : {}),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async attach(ref, options) {
                return await dispatch<Awaited<ReturnType<
                    PluginServices['sessions']['external']['attach']
                >>>({
                    kind: 'plugin_sessions.external.attach_v1',
                    ...requestBase(),
                    ref: encodeRunnerDaemonPluginServiceWireValueV1(
                        ref,
                    ),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async readTranscript(ref, query, options) {
                return await dispatch<Awaited<ReturnType<
                    PluginServices['sessions']['external'][
                        'readTranscript'
                    ]
                >>>({
                    kind:
                        'plugin_sessions.external.read_transcript_v1',
                    ...requestBase(),
                    ref: encodeRunnerDaemonPluginServiceWireValueV1(
                        ref,
                    ),
                    query:
                        encodeRunnerDaemonPluginServiceWireValueV1(
                            query,
                        ),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
            async followTranscript(ref, options, listener) {
                const subscriptionId = randomUUID();
                const opened = await dispatch<
                    Readonly<{ status: 'opening' }>
                >({
                    kind:
                        'plugin_sessions.external.follow_transcript.open_v1',
                    ...requestBase(),
                    subscriptionId,
                    ref: encodeRunnerDaemonPluginServiceWireValueV1(
                        ref,
                    ),
                    options:
                        encodeRunnerDaemonPluginServiceWireValueV1({
                            ...(options.cursor
                                ? { cursor: options.cursor }
                                : {}),
                        }),
                }, options.signal
                    ? { signal: options.signal }
                    : undefined);
                if (opened.status !== 'opening') {
                    throw new PluginError({
                        code:
                            'plugin_external_follow_acquisition_invalid',
                        message:
                            'Daemon returned an invalid External Sessions follow opening result',
                    });
                }

                const controller = new AbortController();
                type FollowAcquisition =
                    | Readonly<{
                        status: 'following';
                        startingCursor: string | null;
                    }>
                    | Readonly<{
                        status: 'unavailable';
                        code: string;
                    }>;
                let resolveAcquisition!:
                    (result: FollowAcquisition) => void;
                let rejectAcquisition!: (error: unknown) => void;
                let acquisitionSettled = false;
                let pendingAcquisition:
                    | Readonly<{
                        result: FollowAcquisition;
                        error?: never;
                    }>
                    | Readonly<{
                        result?: never;
                        error: PluginError;
                    }>
                    | null = null;
                const acquisition = new Promise<FollowAcquisition>(
                    (resolve, reject) => {
                        resolveAcquisition = (result) => {
                            acquisitionSettled = true;
                            resolve(result);
                        };
                        rejectAcquisition = (error) => {
                            acquisitionSettled = true;
                            reject(error);
                        };
                    },
                );
                let disposal: Promise<void> | null = null;
                let cancellationRequested = false;
                let listenerDeliveryRejected = false;
                const close = async (): Promise<void> => {
                    if (disposal) return await disposal;
                    const attempt = (async () => {
                        try {
                            await dispatch<null>({
                                kind:
                                    'plugin_services.subscription.close_v1',
                                requestId: randomUUID(),
                                invocationId: input.invocationId,
                                subscriptionId,
                            }, {
                                // `timeoutMs: null` waits for the platform
                                // default — minutes, not the disposal boundary
                                // this subscription promises. Bound the close on
                                // the transport exactly as the exact External
                                // Session follow carrier does.
                                timeoutMs:
                                    EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
                            });
                        } finally {
                            // Always cancels the outstanding `next_v1`, whether
                            // the close request settled or timed out.
                            controller.abort();
                        }
                    })();
                    disposal = attempt;
                    try {
                        await attempt;
                    } catch (error) {
                        // A close is allowed to fail once and succeed on retry.
                        // Caching the rejected attempt would make the exact same
                        // cleanup permanently unreachable.
                        if (disposal === attempt) disposal = null;
                        throw error;
                    }
                };
                const detachCallerAbort = (): void => {
                    input.signal.removeEventListener('abort', abort);
                    options.signal?.removeEventListener('abort', abort);
                };
                /**
                 * The single terminalization of this follow attempt. Every
                 * terminal branch runs it, so a follow that never became a
                 * subscription still closes its daemon-side subscription, aborts
                 * the pump, and detaches the caller/invocation abort listeners.
                 * Detaching only on successful disposal accumulated one listener
                 * per unavailable attempt on the invocation-scoped signal.
                 */
                const terminate = async (): Promise<void> => {
                    detachCallerAbort();
                    await close();
                };
                function abort(): void {
                    cancellationRequested = true;
                    if (acquisitionSettled) {
                        void close().catch(() => undefined);
                    }
                }
                if (input.signal.aborted || options.signal?.aborted) {
                    abort();
                } else {
                    input.signal.addEventListener(
                        'abort',
                        abort,
                        { once: true },
                    );
                    options.signal?.addEventListener(
                        'abort',
                        abort,
                        { once: true },
                    );
                }
                void (async () => {
                    let acknowledgement:
                        | 'settled'
                        | 'rejected'
                        | undefined;
                    try {
                        while (!controller.signal.aborted) {
                            const sentAcknowledgement =
                                acknowledgement;
                            const rawEvent = await dispatch<unknown>({
                                kind:
                                    'plugin_services.subscription.next_v1',
                                ...requestBase(),
                                subscriptionId,
                                ...(acknowledgement
                                    ? { acknowledgement }
                                    : {}),
                            }, {
                                signal: controller.signal,
                                timeoutMs: null,
                            });
                            acknowledgement = undefined;
                            if (
                                sentAcknowledgement === 'settled'
                                && pendingAcquisition
                            ) {
                                if (rawEvent !== null) {
                                    throw new PluginError({
                                        code:
                                            'plugin_external_follow_acquisition_invalid',
                                        message:
                                            'Daemon returned an event while acknowledging External Sessions follow acquisition',
                                    });
                                }
                                const pending = pendingAcquisition;
                                pendingAcquisition = null;
                                if (pending.error) {
                                    rejectAcquisition(pending.error);
                                } else {
                                    resolveAcquisition(
                                        pending.result,
                                    );
                                }
                                continue;
                            }
                            if (rawEvent === null) continue;
                            const parsed =
                                RunnerDaemonPluginServiceSubscriptionEventV1Schema
                                    .safeParse(rawEvent);
                            if (
                                !parsed.success
                                || parsed.data.invocationId
                                    !== input.invocationId
                                || parsed.data.subscriptionId
                                    !== subscriptionId
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_service_subscription_event_invalid',
                                    message:
                                        'Daemon returned an invalid External Sessions follow event',
                                });
                            }
                            if (
                                parsed.data.kind
                                === 'plugin_sessions.external.follow_transcript.opened_v1'
                            ) {
                                acknowledgement = 'settled';
                                if (
                                    acquisitionSettled
                                    || pendingAcquisition
                                ) {
                                    throw new PluginError({
                                        code:
                                            'plugin_external_follow_acquisition_invalid',
                                        message:
                                            'Daemon returned duplicate External Sessions follow acquisition settlement',
                                    });
                                }
                                if (parsed.data.result.status === 'failed') {
                                    pendingAcquisition = {
                                        error: new PluginError({
                                            code:
                                                parsed.data.result.code,
                                            message:
                                                parsed.data.result.message,
                                        }),
                                    };
                                } else {
                                    pendingAcquisition = {
                                        result: parsed.data.result,
                                    };
                                }
                                continue;
                            }
                            if (
                                parsed.data.kind
                                !== 'plugin_sessions.external.follow_transcript.event_v1'
                            ) {
                                throw new PluginError({
                                    code:
                                        'plugin_service_subscription_event_invalid',
                                    message:
                                        'Daemon returned an invalid External Sessions follow event kind',
                                });
                            }
                            if (listenerDeliveryRejected) {
                                acknowledgement = 'rejected';
                            } else {
                                try {
                                    await listener(
                                        decodeRunnerDaemonPluginServiceWireValueV1(
                                            parsed.data.event,
                                        ) as Parameters<
                                            PluginServices['sessions']['external'][
                                                'followTranscript'
                                            ]
                                        >[2] extends (
                                            event: infer Event,
                                        ) => unknown ? Event : never,
                                    );
                                    acknowledgement = 'settled';
                                } catch {
                                    listenerDeliveryRejected = true;
                                    acknowledgement = 'rejected';
                                }
                            }
                            if (acknowledgement === 'rejected') {
                                await dispatch<null>({
                                    kind:
                                        'plugin_services.subscription.next_v1',
                                    ...requestBase(),
                                    subscriptionId,
                                    acknowledgement,
                                }, {
                                    signal: controller.signal,
                                    timeoutMs: null,
                                });
                                acknowledgement = undefined;
                                if (acquisitionSettled) {
                                    await close();
                                }
                            }
                        }
                        if (!acquisitionSettled) {
                            rejectAcquisition(new PluginError({
                                code:
                                    'plugin_external_follow_acquisition_failed',
                                message:
                                    'External Sessions follow acquisition ended before settlement',
                            }));
                        }
                    } catch (error) {
                        if (!acquisitionSettled) {
                            rejectAcquisition(
                                isPluginError(error)
                                    ? error
                                    : new PluginError({
                                        code:
                                            'plugin_external_follow_acquisition_failed',
                                        message:
                                            'External Sessions follow acquisition ended before settlement',
                                    }),
                            );
                        }
                        if (!controller.signal.aborted) {
                            await close().catch(() => undefined);
                        }
                    }
                })();
                let acquired: FollowAcquisition;
                try {
                    acquired = await acquisition;
                } catch (error) {
                    await terminate().catch(() => undefined);
                    throw error;
                }
                if (acquired.status === 'unavailable') {
                    await terminate().catch(() => undefined);
                    return acquired;
                }
                if (cancellationRequested) {
                    await terminate().catch(() => undefined);
                    return Object.freeze({
                        status: 'unavailable' as const,
                        code: 'plugin_operation_aborted',
                    });
                }
                if (listenerDeliveryRejected) {
                    await terminate().catch(() => undefined);
                    throw new PluginError({
                        code:
                            'plugin_external_follow_listener_failed',
                        message:
                            'External Sessions follow listener rejected delivery',
                    });
                }
                return Object.freeze({
                    status: 'following' as const,
                    startingCursor: acquired.startingCursor,
                    subscription: Object.freeze({
                        async dispose() {
                            await terminate();
                        },
                    }),
                });
            },
            async takeover(ref, request, options) {
                return await dispatch<Awaited<ReturnType<
                    PluginServices['sessions']['external']['takeover']
                >>>({
                    kind: 'plugin_sessions.external.takeover_v1',
                    ...requestBase(),
                    ref: encodeRunnerDaemonPluginServiceWireValueV1(
                        ref,
                    ),
                    request:
                        encodeRunnerDaemonPluginServiceWireValueV1(
                            request,
                        ),
                }, options?.signal
                    ? { signal: options.signal }
                    : undefined);
            },
        } satisfies PluginServices['sessions']['external']);
    const sessions: PluginServices['sessions'] = Object.freeze({
        ...input.local.sessions,
        external: externalSessions,
    });
    return Object.freeze({
        availability,
        logger,
        storage,
        settings,
        secrets,
        events,
        http: httpService,
        fs,
        exec,
        providers,
        managedServices,
        sessions,
        resources,
        mcp,
        notifications,
        connectedAccounts,
        actions,
        targetedContributions: input.local.targetedContributions,
        interactions: input.local.interactions,
        composerContent: input.local.composerContent,
    });
}
