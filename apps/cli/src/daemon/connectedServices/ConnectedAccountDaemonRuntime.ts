import { randomUUID } from 'node:crypto';

import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol';
import type {
    ConnectedAccountAttemptResponse,
    ConnectedAccountControlTarget as ConnectedAccountDaemonControlTarget,
    ConnectedAccountDaemonCommand,
    ConnectedAccountDaemonControlCommand,
    ConnectedAccountDaemonControlResponse,
    ConnectedAccountPeerOperationTransport,
    BuiltInLegacyConnectedAccountOperation,
    PluginConnectedAccountAuthenticationModeV2,
    PluginJsonValueV2,
    QualifiedConnectedAccountRef,
    QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import {
    createConnectedAccountAuthenticationAttemptOwner,
    type ConnectedAccountAttemptProviderInvocation,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';
import {
    createConnectedAccountConfigurationOwner,
    type ConnectedAccountConfigurationOwner,
    type ConnectedAccountConfigurationTarget,
} from '@/plugins/runtime/connectedAccounts/configurationOwner';
import {
    revokeQualifiedConnectedAccount,
} from './revokeQualifiedConnectedAccount';
import {
    revokeRevisionedLegacyConnectedAccount,
} from './revokeRevisionedLegacyConnectedAccount';

export type {
    ConnectedAccountAttemptResponse,
    ConnectedAccountControlTarget as ConnectedAccountDaemonControlTarget,
    ConnectedAccountDaemonCommand,
    ConnectedAccountDaemonControlCommand,
    ConnectedAccountDaemonControlResponse,
} from '@happier-dev/protocol';

type AttemptOwnerParams = Parameters<
    typeof createConnectedAccountAuthenticationAttemptOwner
>[0];
type ConfigurationOwnerParams = Parameters<
    typeof createConnectedAccountConfigurationOwner
>[0];
type RevisionedLegacyRevocationInput = Parameters<
    typeof revokeRevisionedLegacyConnectedAccount
>[0];

function sameService(
    left: PluginContributionRef,
    right: PluginContributionRef,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Connected-account daemon control was aborted');
}

function projectConfigurationControlView(
    view: Awaited<
        ReturnType<ConnectedAccountConfigurationOwner['inspect']>
    >,
) {
    const values: Record<string, PluginJsonValueV2> = {};
    for (const [fieldId, value] of Object.entries(view.values)) {
        values[fieldId] = PluginJsonValueV2Schema.parse(value);
    }
    return Object.freeze({
        ...view,
        values: Object.freeze(values),
    });
}

export type ConnectedAccountDaemonPersistence = Readonly<{
    profiles: Readonly<{
        list(
            service: PluginContributionRef,
        ): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
    }>;
    configuration: Omit<ConfigurationOwnerParams, 'isGenerationCurrent'>;
    attempts: Pick<
        AttemptOwnerParams,
        'accounts' | 'oauth' | 'settlement'
    > & Partial<Pick<AttemptOwnerParams, 'deviceTransactions' | 'lateEvidence'>>
      & Readonly<{
          assertAuthenticationActionAllowed?(input: Readonly<{
              intent: 'connect' | 'reconnect';
              service: PluginContributionRef;
              authenticationModeId?: string;
              authenticationModeCardinality?: 'single' | 'multiple';
              configurationState?: 'unconfigured' | 'configured';
          }>): void | Promise<void>;
      }>;
}>;

export type ConnectedAccountDaemonRuntime = Readonly<{
    execute(
        command: ConnectedAccountDaemonCommand,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountAttemptResponse>;
    control(
        command: ConnectedAccountDaemonControlCommand,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountDaemonControlResponse>;
}>;

export type ConnectedAccountConfigurationConsequence = Readonly<{
    accounts: readonly QualifiedConnectedAccountRef[];
    authenticationModeId: string;
    configurationScope: 'service' | 'account';
    behavior: 'refresh' | 'reconnect';
    runtimeConfigurationRevision: string;
}>;

function configurationConsequenceError(
    code: string,
    message: string,
): Error & Readonly<{ code: string; controlStatus: 'conflict' }> {
    return Object.assign(new Error(message), {
        code,
        controlStatus: 'conflict' as const,
    });
}

export function createConnectedAccountDaemonRuntime(params: Readonly<{
    reloadController: PluginReloadController;
    persistence: ConnectedAccountDaemonPersistence;
    resolvePeerOperationTransport?(input: Readonly<{
        service: PluginContributionRef;
        operation: BuiltInLegacyConnectedAccountOperation;
    }>): ConnectedAccountPeerOperationTransport;
    configurationConsequences: Readonly<{
        assertAvailable(): Promise<void>;
        apply(input: Omit<ConnectedAccountConfigurationConsequence, 'accounts'> & Readonly<{
            account: QualifiedConnectedAccountRef;
        }>): Promise<void>;
    }>;
    maxAttempts?: number;
    attemptTtlMs?: number;
    createAttemptId?: () => string;
    createAccountId?: () => string;
    now?: () => number;
    revocation: Pick<
        Parameters<typeof revokeQualifiedConnectedAccount>[0],
        | 'token'
        | 'establishedRuntimeOwner'
        | 'deleteCredential'
        | 'resolveV4Support'
    > & Readonly<{
        legacyCredentialApi?: RevisionedLegacyRevocationInput['api'];
    }>;
}>): ConnectedAccountDaemonRuntime {
    const isPluginGenerationCurrent = async (input: Readonly<{
        pluginId: string;
        generation: string;
        immutableGenerationId: string;
    }>): Promise<boolean> => {
        const lease = params.reloadController.tryAcquireRuntimeRegistry?.() ?? null;
        if (!lease) return false;
        try {
            if (String(lease.registry.generation) !== input.generation) return false;
            const entry = lease.registry.connectedAccountContributions?.list()
                .find((candidate) => candidate.ref.pluginId === input.pluginId);
            if (!entry) return false;
            const runtime = await lease.registry.resolveConnectedAccountRuntime?.(entry.ref);
            return runtime?.immutableGenerationId === input.immutableGenerationId
                && runtime.isCurrent();
        } catch {
            return false;
        } finally {
            await lease.release();
        }
    };
    const configuration = createConnectedAccountConfigurationOwner({
        ...params.persistence.configuration,
        isGenerationCurrent: isPluginGenerationCurrent,
    });
    const runtime: AttemptOwnerParams['runtime'] = Object.freeze({
        async admit(input) {
            const registryLease = await params.reloadController.acquireRuntimeRegistry();
            try {
                const contribution = await registryLease.registry.resolveConnectedAccountRuntime?.(
                    input.service,
                );
                if (!contribution) {
                    throw new Error('Connected-account service runtime is unavailable');
                }
                const descriptor = contribution.descriptor.authentication.modes
                    .find((candidate) => candidate.id === input.modeId);
                if (!descriptor) {
                    throw new Error('Connected-account authentication mode is unavailable');
                }
                return Object.freeze({
                    service: contribution.ref,
                    descriptor,
                    authenticationModeCardinality:
                        contribution.descriptor.authentication.modes.length
                            === 1
                            ? 'single' as const
                            : 'multiple' as const,
                    generation: contribution.generation,
                    immutableGenerationId: contribution.immutableGenerationId,
                });
            } finally {
                await registryLease.release();
            }
        },
        async isCurrent(admission) {
            const registryLease = params.reloadController.tryAcquireRuntimeRegistry?.() ?? null;
            if (!registryLease) return false;
            try {
                const contribution = await registryLease.registry.resolveConnectedAccountRuntime?.(
                    admission.service,
                );
                return Boolean(
                    contribution
                    && contribution.generation === admission.generation
                    && contribution.immutableGenerationId === admission.immutableGenerationId
                    && contribution.isCurrent(),
                );
            } catch {
                return false;
            } finally {
                await registryLease.release();
            }
        },
        async invoke(input: ConnectedAccountAttemptProviderInvocation) {
            const registryLease = await params.reloadController.acquireRuntimeRegistry();
            try {
                const invoker = registryLease.registry.connectedAccountRuntimeInvoker;
                if (!invoker) {
                    throw new Error('Connected-account host runtime invoker is unavailable');
                }
                return await invoker.invokeAuthentication({
                    ...input,
                    isConfigurationCurrent: configuration.isCurrent,
                    configurationRevocationSignal: configuration.currentnessSignal,
                });
            } finally {
                await registryLease.release();
            }
        },
    });
    const attempts = createConnectedAccountAuthenticationAttemptOwner({
        maxAttempts: params.maxAttempts ?? 64,
        attemptTtlMs: params.attemptTtlMs ?? 15 * 60_000,
        createAttemptId: params.createAttemptId ?? (() => `caa_${randomUUID()}`),
        createAccountId: params.createAccountId ?? (() => `ca_${randomUUID()}`),
        now: params.now ?? Date.now,
        accounts: params.persistence.attempts.accounts,
        configuration,
        runtime,
        oauth: params.persistence.attempts.oauth,
        ...(params.persistence.attempts.deviceTransactions
            ? { deviceTransactions: params.persistence.attempts.deviceTransactions }
            : {}),
        ...(params.persistence.attempts.lateEvidence
            ? { lateEvidence: params.persistence.attempts.lateEvidence }
            : {}),
        ...(params.persistence.attempts.assertAuthenticationActionAllowed
            ? {
                assertEffectfulOperationAllowed: ({
                    intent,
                    service,
                    authenticationModeId,
                    authenticationModeCardinality,
                    configurationState,
                }) => params.persistence.attempts
                    .assertAuthenticationActionAllowed?.({
                        intent,
                        service,
                        authenticationModeId,
                        ...(authenticationModeCardinality
                            ? { authenticationModeCardinality }
                            : {}),
                        configurationState,
                    }),
            }
            : {}),
        settlement: params.persistence.attempts.settlement,
    });

    type ControlBasis = Readonly<{
        target: ConnectedAccountConfigurationTarget;
        mode: PluginConnectedAccountAuthenticationModeV2;
        generation: string;
        immutableGenerationId: string;
    }>;

    async function resolveControlBasis(
        target: ConnectedAccountDaemonControlTarget,
    ): Promise<ControlBasis | null> {
        if (target.kind === 'attempt') {
            return await attempts.resolveConfigurationControlTarget({
                attemptId: target.attemptId,
            });
        }
        let service: PluginContributionRef;
        let modeId: string;
        let normalizedTarget: ConnectedAccountConfigurationTarget;
        if (target.kind === 'account') {
            const exact = await params.persistence.attempts.accounts.readExact(
                target.account,
            );
            if (
                !exact
                || !sameService(exact.account.service, target.account.service)
                || exact.account.accountId !== target.account.accountId
            ) {
                return null;
            }
            service = exact.account.service;
            modeId = exact.authenticationModeId;
            normalizedTarget = Object.freeze({
                kind: 'account',
                account: exact.account,
                modeId,
            });
        } else {
            service = target.service;
            modeId = target.modeId;
            normalizedTarget = Object.freeze({
                kind: 'service',
                service: Object.freeze({ ...target.service }),
                modeId,
            });
        }
        const lease = await params.reloadController.acquireRuntimeRegistry();
        try {
            if (!params.reloadController.isRuntimeRegistryCurrent(lease.registry)) {
                return null;
            }
            const contribution =
                await lease.registry.resolveConnectedAccountRuntime?.(service);
            if (
                !contribution
                || !contribution.isCurrent()
                || !sameService(contribution.ref, service)
            ) {
                return null;
            }
            const mode = contribution.descriptor.authentication.modes.find(
                (candidate) => candidate.id === modeId,
            );
            if (!mode) return null;
            return Object.freeze({
                target: normalizedTarget,
                mode,
                generation: contribution.generation,
                immutableGenerationId: contribution.immutableGenerationId,
            });
        } finally {
            await lease.release();
        }
    }

    async function resolveConsequenceAccounts(
        basis: ControlBasis,
    ): Promise<readonly QualifiedConnectedAccountRef[]> {
        if (basis.target.kind === 'attempt') return Object.freeze([]);
        if (basis.target.kind === 'service') {
            const target = basis.target;
            const profiles = await params.persistence.profiles.list(
                target.service,
            );
            return Object.freeze(profiles
                .filter((profile) =>
                    sameService(profile.ref.service, target.service)
                    && profile.authenticationModeId === basis.mode.id)
                .map((profile) => Object.freeze({
                    service: Object.freeze({ ...profile.ref.service }),
                    accountId: profile.ref.accountId,
                })));
        }
        const exact = await params.persistence.attempts.accounts.readExact(
            basis.target.account,
        );
        if (
            !exact
            || !sameService(exact.account.service, basis.target.account.service)
            || exact.account.accountId !== basis.target.account.accountId
            || exact.authenticationModeId !== basis.mode.id
        ) {
            throw configurationConsequenceError(
                'connected_account_configuration_consequence_stale',
                'Connected-account configuration consequence target changed after commit',
            );
        }
        return Object.freeze([Object.freeze({
            service: Object.freeze({ ...exact.account.service }),
            accountId: exact.account.accountId,
        })]);
    }

    return Object.freeze({
        async control(command, options) {
            try {
                assertNotAborted(options?.signal);
                if (command.operation === 'describeService') {
                    const operationTransport = command.requiredOperation
                        ? params.resolvePeerOperationTransport?.({
                            service: command.service,
                            operation: command.requiredOperation,
                        })
                        : undefined;
                    if (
                        command.requiredOperation
                        && operationTransport === undefined
                    ) {
                        throw Object.assign(
                            new Error(
                                'Connected-account peer operation admission is unavailable',
                            ),
                            {
                                code:
                                    'connected_account_peer_operation_admission_unavailable',
                            },
                        );
                    }
                    const lease =
                        await params.reloadController.acquireRuntimeRegistry();
                    try {
                        if (
                            !params.reloadController.isRuntimeRegistryCurrent(
                                lease.registry,
                            )
                        ) {
                            return {
                                status: 'unavailable' as const,
                                code: 'connected_account_runtime_generation_changed',
                            };
                        }
                        const contribution =
                            await lease.registry.resolveConnectedAccountRuntime?.(
                                command.service,
                            );
                        if (
                            !contribution
                            || !contribution.isCurrent()
                            || !sameService(contribution.ref, command.service)
                        ) {
                            return {
                                status: 'unavailable' as const,
                                code: 'connected_account_service_unavailable',
                            };
                        }
                        const accounts =
                            operationTransport?.kind === 'legacy'
                                ? Object.freeze([])
                                : await params.persistence.profiles.list(
                                    command.service,
                                );
                        assertNotAborted(options?.signal);
                        if (
                            !params.reloadController.isRuntimeRegistryCurrent(
                                lease.registry,
                            )
                            || !contribution.isCurrent()
                        ) {
                            return {
                                status: 'conflict' as const,
                                code: 'connected_account_runtime_generation_changed',
                            };
                        }
                        return Object.freeze({
                            status: 'described' as const,
                            service: Object.freeze({ ...contribution.ref }),
                            descriptor: contribution.descriptor,
                            generation: contribution.generation,
                            immutableGenerationId:
                                contribution.immutableGenerationId,
                            accounts: Object.freeze([...accounts]),
                            ...(operationTransport
                                ? { operationTransport }
                                : {}),
                        });
                    } finally {
                        await lease.release();
                    }
                }
                if (command.operation === 'revokeAccount') {
                    const operationTransport =
                        params.resolvePeerOperationTransport?.({
                            service: command.account.service,
                            operation: 'credential_delete',
                        });
                    let result:
                        | Awaited<
                            ReturnType<typeof revokeQualifiedConnectedAccount>
                        >
                        | Awaited<
                            ReturnType<
                                typeof revokeRevisionedLegacyConnectedAccount
                            >
                        >;
                    if (
                        operationTransport?.kind === 'legacy'
                        && operationTransport.peerClass
                            === 'revisioned_v2_v3'
                    ) {
                        const legacyCredentialApi =
                            params.revocation.legacyCredentialApi;
                        if (!legacyCredentialApi) {
                            throw Object.assign(
                                new Error(
                                    'Revisioned legacy Connected Account revocation is unavailable',
                                ),
                                {
                                    code:
                                        'connected_account_daemon_runtime_unavailable',
                                },
                            );
                        }
                        result =
                            await revokeRevisionedLegacyConnectedAccount({
                                account: command.account,
                                serviceId: operationTransport.serviceId,
                                cleanupGroupReferences:
                                    command.cleanupGroupReferences,
                                api: legacyCredentialApi,
                                resolvePeerOperationTransport: () => {
                                    const current =
                                        params.resolvePeerOperationTransport?.({
                                            service:
                                                command.account.service,
                                            operation: 'credential_delete',
                                        });
                                    if (current) return current;
                                    throw Object.assign(
                                        new Error(
                                            'Connected-account peer operation admission is unavailable',
                                        ),
                                        {
                                            code:
                                                'connected_account_peer_operation_admission_unavailable',
                                        },
                                    );
                                },
                            });
                    } else {
                        result = await revokeQualifiedConnectedAccount({
                            ...params.revocation,
                            account: command.account,
                            cleanupGroupReferences:
                                command.cleanupGroupReferences,
                            ...(options?.signal
                                ? { signal: options.signal }
                                : {}),
                        });
                    }
                    assertNotAborted(options?.signal);
                    return result.status === 'deleted'
                        ? Object.freeze({
                            status: 'revoked' as const,
                            account: command.account,
                            remoteStatus: result.remoteStatus,
                        })
                        : Object.freeze({
                            status: 'outcomeUnknown' as const,
                            account: command.account,
                        });
                }
                const basis = await resolveControlBasis(command.target);
                assertNotAborted(options?.signal);
                if (!basis) {
                    return {
                        status: 'unavailable' as const,
                        code: 'connected_account_configuration_target_unavailable',
                    };
                }
                if (command.operation === 'readConfiguration') {
                    const view = await configuration.inspect(basis);
                    assertNotAborted(options?.signal);
                    return Object.freeze({
                        status: 'configuration' as const,
                        ...basis,
                        configuration:
                            projectConfigurationControlView(view),
                    });
                }
                if (basis.target.kind !== 'attempt') {
                    await params.configurationConsequences.assertAvailable();
                    assertNotAborted(options?.signal);
                }
                const replacement = await configuration.replaceForControl({
                    ...basis,
                    expectedRevision: command.expectedRevision,
                    values: command.values,
                    secretValues: command.secretValues,
                });
                assertNotAborted(options?.signal);
                if (replacement.status !== 'committed') {
                    return replacement;
                }
                if (!await configuration.isCurrent(replacement.snapshot)) {
                    return Object.freeze({
                        status: 'conflict' as const,
                        code: 'connected_account_configuration_consequence_stale',
                    });
                }
                const accounts = await resolveConsequenceAccounts(basis);
                assertNotAborted(options?.signal);
                if (!await configuration.isCurrent(replacement.snapshot)) {
                    return Object.freeze({
                        status: 'conflict' as const,
                        code: 'connected_account_configuration_consequence_stale',
                    });
                }
                if (accounts.length > 0 && basis.target.kind !== 'attempt') {
                    const descriptor = basis.mode.configuration;
                    if (!descriptor) {
                        return Object.freeze({
                            status: 'unavailable' as const,
                            code: 'connected_account_configuration_consequence_unavailable',
                        });
                    }
                    const sharedConsequence = Object.freeze({
                        authenticationModeId: basis.mode.id,
                        configurationScope: basis.target.kind === 'service'
                            ? 'service' as const
                            : 'account' as const,
                        behavior: descriptor.changeBehavior,
                        runtimeConfigurationRevision:
                            replacement.snapshot.revision,
                    });
                    const settlements = await Promise.allSettled(
                        accounts.map(async (account) => {
                            await params.configurationConsequences.apply(
                                Object.freeze({
                                    ...sharedConsequence,
                                    account,
                                }),
                            );
                        }),
                    );
                    const failures = settlements
                        .filter((
                            settlement,
                        ): settlement is PromiseRejectedResult =>
                            settlement.status === 'rejected')
                        .map((settlement) => settlement.reason);
                    if (failures.length > 0) {
                        const stale = failures.some((failure) =>
                            failure
                            && typeof failure === 'object'
                            && 'code' in failure
                            && failure.code
                                === 'connected_account_configuration_consequence_stale');
                        throw Object.assign(
                            new AggregateError(
                                failures,
                                'One or more Connected Account configuration consequences did not settle',
                            ),
                            {
                                code: stale
                                    ? 'connected_account_configuration_consequence_stale'
                                    : 'connected_account_configuration_consequence_unavailable',
                            },
                        );
                    }
                    assertNotAborted(options?.signal);
                    if (!await configuration.isCurrent(replacement.snapshot)) {
                        return Object.freeze({
                            status: 'conflict' as const,
                            code: 'connected_account_configuration_consequence_stale',
                        });
                    }
                }
                const view = await configuration.inspect(basis);
                assertNotAborted(options?.signal);
                if (
                    view.revision !== replacement.snapshot.revision
                    || !await configuration.isCurrent(replacement.snapshot)
                ) {
                    return Object.freeze({
                        status: 'conflict' as const,
                        code: 'connected_account_configuration_consequence_stale',
                    });
                }
                return Object.freeze({
                    status: 'configurationCommitted' as const,
                    ...basis,
                    configuration:
                        projectConfigurationControlView(view),
                });
            } catch (error) {
                const code = (
                    error
                    && typeof error === 'object'
                    && 'code' in error
                    && typeof error.code === 'string'
                )
                    ? error.code
                    : 'connected_account_control_unavailable';
                const controlStatus = (
                    error
                    && typeof error === 'object'
                    && 'controlStatus' in error
                    && error.controlStatus === 'conflict'
                ) || code === 'connected_account_configuration_consequence_stale'
                    ? 'conflict' as const
                    : 'unavailable' as const;
                return Object.freeze({
                    status: controlStatus,
                    code,
                });
            }
        },
        async execute(command, options) {
            switch (command.operation) {
                case 'beginConnect':
                    await params.persistence.attempts
                        .assertAuthenticationActionAllowed?.({
                            intent: 'connect',
                            service: command.service,
                            authenticationModeId: command.modeId,
                        });
                    return await attempts.beginConnect({
                        service: command.service,
                        modeId: command.modeId,
                        ...(command.expectedConfigurationRevision === undefined
                            ? {}
                            : { expectedConfigurationRevision: command.expectedConfigurationRevision }),
                    });
                case 'beginReconnect':
                    await params.persistence.attempts
                        .assertAuthenticationActionAllowed?.({
                            intent: 'reconnect',
                            service: command.account.service,
                        });
                    return await attempts.beginReconnect({
                        account: command.account,
                        ...(command.expectedConfigurationRevision === undefined
                            ? {}
                            : { expectedConfigurationRevision: command.expectedConfigurationRevision }),
                    });
                case 'continueConnect':
                    return await attempts.continueConnect({
                        attemptId: command.attemptId,
                        ...(command.expectedConfigurationRevision === undefined
                            ? {}
                            : { expectedConfigurationRevision: command.expectedConfigurationRevision }),
                    });
                case 'submitManual':
                    return await attempts.submitManual({
                        attemptId: command.attemptId,
                        fields: command.fields,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                case 'completeOAuth':
                    return await attempts.completeOAuth({
                        attemptId: command.attemptId,
                        completion: command.completion,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                case 'pollDevice':
                    return await attempts.pollDevice({
                        attemptId: command.attemptId,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                case 'resumeDevice':
                    return await attempts.resumeDevice({ attemptId: command.attemptId });
                case 'reconcile':
                    return await attempts.reconcile({
                        attemptId: command.attemptId,
                        ...(options?.signal ? { signal: options.signal } : {}),
                    });
                case 'cancel':
                    return await attempts.cancel({ attemptId: command.attemptId });
                case 'read':
                    return await attempts.read({ attemptId: command.attemptId });
            }
        },
    });
}

export function createUnavailableConnectedAccountDaemonPersistence():
ConnectedAccountDaemonPersistence {
    return Object.freeze({
        profiles: Object.freeze({
            list: async () => Object.freeze([]),
        }),
        configuration: Object.freeze({
            read: async () => null,
            replace: async () => Object.freeze({
                status: 'unavailable' as const,
                code: 'connected_account_configuration_persistence_unavailable',
            }),
            destroyAttempt: async () => undefined,
            secrets: Object.freeze({
                has: async () => false,
                read: async () => null,
            }),
        }),
        attempts: Object.freeze({
            accounts: Object.freeze({
                readExact: async () => null,
            }),
            oauth: Object.freeze({
                create: async () => {
                    throw new Error('Connected-account OAuth transaction owner is unavailable');
                },
            }),
            settlement: Object.freeze({
                settle: async () => Object.freeze({
                    status: 'unavailable' as const,
                    code: 'connected_account_persistence_unavailable',
                }),
            }),
        }),
    });
}
