import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PendingConnectedAccountAttemptTransaction } from '@/api/client/connectedAccountAttemptTransactionApi';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
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
import { logger } from '@/ui/logger';
import type { PluginSourceCustody } from '@/plugins/runtime/sourceAuthority';
import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    type ConnectedAccountRuntimeLease,
} from '@/plugins/runtime/connectedAccounts/contributionRegistry';
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

function safeLogCode(value: unknown): string | null {
    return typeof value === 'string' && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
        ? value
        : null;
}

function safeDiagnosticCode(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'code');
    return descriptor && 'value' in descriptor ? safeLogCode(descriptor.value) : null;
}

function attemptCorrelationHash(attemptId: string | null): string | null {
    return attemptId === null ? null : createHash('sha256')
        .update('happier.connected-account.attempt-log.v1\0')
        .update(attemptId)
        .digest('hex')
        .slice(0, 24);
}

function logAuthenticationAttempt(input: Readonly<{
    operation: string;
    service: PluginContributionRef | null;
    attemptId: string | null;
    status: ConnectedAccountAttemptResponse['status'];
    code: unknown;
    diagnostic: unknown;
    settlementPhase: string;
}>): void {
    logger.info('[DAEMON RUN] Connected Account authentication attempt', {
        operation: input.operation,
        serviceId: input.service
            ? `${input.service.pluginId}/${input.service.localId}` : null,
        attemptCorrelationHash: attemptCorrelationHash(input.attemptId),
        status: input.status,
        code: safeLogCode(input.code),
        diagnosticCode: safeDiagnosticCode(input.diagnostic),
        settlementPhase: input.settlementPhase,
    });
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
    configuration: Omit<ConfigurationOwnerParams, 'isRuntimeCurrent'>;
    attempts: Pick<
        AttemptOwnerParams,
        'accounts' | 'oauth' | 'settlement'
    > & Partial<Pick<AttemptOwnerParams, 'deviceTransactions' | 'lateEvidence'>>
      & Readonly<{
          listPending?(service: PluginContributionRef): Promise<readonly PendingConnectedAccountAttemptTransaction[]>;
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

export function createConnectedAccountDaemonConfigurationOwner(params: Readonly<{
    reloadController: Pick<PluginReloadController, 'tryAcquireRuntimeRegistry'>;
    persistence: ConnectedAccountDaemonPersistence['configuration'];
}>): ConnectedAccountConfigurationOwner {
    const isPluginRuntimeCurrent = async (input: Readonly<{
        pluginId: string;
        occurrenceId: string;
        sourceCustody: PluginSourceCustody;
    }>): Promise<boolean> => {
        const lease = params.reloadController.tryAcquireRuntimeRegistry();
        if (!lease) return false;
        try {
            // Currentness is a host fact the cold projection already carries; asking it
            // must not boot the plugin whose currentness is in question.
            const entry = lease.registry.connectedAccountContributions?.list()
                .find((candidate) => candidate.ref.pluginId === input.pluginId);
            if (!entry) return false;
            return entry.occurrenceId === input.occurrenceId
                && pluginSourceCustodyV1Equal(entry.sourceCustody, input.sourceCustody)
                && entry.isCurrent();
        } catch {
            return false;
        } finally {
            await lease.release();
        }
    };
    return createConnectedAccountConfigurationOwner({
        ...params.persistence,
        isRuntimeCurrent: isPluginRuntimeCurrent,
    });
}

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
    configurationOwner?: ConnectedAccountConfigurationOwner;
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
}>): ConnectedAccountDaemonRuntime & Readonly<{ dispose(): void }> {
    const configuration = params.configurationOwner
        ?? createConnectedAccountDaemonConfigurationOwner({
            reloadController: params.reloadController,
            persistence: params.persistence.configuration,
        });
    const runtime: AttemptOwnerParams['runtime'] = Object.freeze({
        async admit(input) {
            let registryLease = await params.reloadController.acquireRuntimeRegistry();
            try {
                const original = registryLease.registry.connectedAccountContributions?.describe(input.service);
                let contribution: ConnectedAccountRuntimeLease | null | undefined;
                try {
                    contribution = await registryLease.registry.resolveConnectedAccountRuntime?.(input.service);
                } catch (error) {
                    if (
                        !(error instanceof ConnectedAccountRuntimeInvocationNotStartedError)
                        || !original
                        || params.reloadController.isRuntimeRegistryCurrent(registryLease.registry)
                    ) throw error;
                    // Lazy activation yielded across publication, before a provider
                    // callback existed. Refresh from the existing current pointer.
                    await registryLease.release();
                    registryLease = await params.reloadController.acquireRuntimeRegistry();
                    contribution = await registryLease.registry.resolveConnectedAccountRuntime?.(input.service);
                    if (
                        !contribution
                        || !sameService(contribution.ref, original.ref)
                        || !pluginSourceCustodyV1Equal(contribution.sourceCustody, original.sourceCustody)
                        || !isDeepStrictEqual(
                            contribution.descriptor.authentication.modes.find((mode) => mode.id === input.modeId),
                            original.descriptor.authentication.modes.find((mode) => mode.id === input.modeId),
                        )
                    ) throw error;
                }
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
                    occurrenceId: contribution.occurrenceId,
                    sourceCustody: contribution.sourceCustody,
                });
            } finally {
                await registryLease.release();
            }
        },
        async isCurrent(admission) {
            const registryLease = params.reloadController.tryAcquireRuntimeRegistry();
            if (!registryLease) return false;
            try {
                // A currentness question is answered from the cold projection: the executable
                // runtime is resolved by `invoke`, which is the call that needs it.
                const contribution =
                    registryLease.registry.connectedAccountContributions?.describe(
                        admission.service,
                    ) ?? null;
                return Boolean(
                    contribution
                    && contribution.occurrenceId === admission.occurrenceId
                    && pluginSourceCustodyV1Equal(
                        contribution.sourceCustody,
                        admission.sourceCustody,
                    )
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
        onBackgroundTransition: ({ response, service, settlementPhase }) => {
            logAuthenticationAttempt({
                operation: 'beginProviderFlow',
                service,
                attemptId: 'attemptId' in response ? response.attemptId ?? null : null,
                status: response.status,
                code: 'code' in response ? response.code : null,
                diagnostic: 'diagnostic' in response ? response.diagnostic : null,
                settlementPhase,
            });
        },
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
        occurrenceId: string;
        sourceCustody: PluginSourceCustody;
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
                || !sameQualifiedConnectedAccountRef(exact.account, target.account)
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
            // A control basis is an authentication-mode descriptor plus the runtime
            // identity to fence on. Both are cold facts the contribution projection
            // already holds, and `readConfiguration` never reaches the plugin at all —
            // so resolving the executable runtime here would boot a plugin to answer a
            // question about stored configuration.
            const contribution =
                lease.registry.connectedAccountContributions?.describe(service)
                ?? null;
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
                occurrenceId: contribution.occurrenceId,
                sourceCustody: contribution.sourceCustody,
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
            || !sameQualifiedConnectedAccountRef(exact.account, basis.target.account)
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
        dispose() {
            attempts.dispose();
        },
        async control(command, options) {
            try {
                assertNotAborted(options?.signal);
                if (command.operation === 'listPendingAttempts') {
                    if (!params.persistence.attempts.listPending) {
                        throw Object.assign(new Error('Connected-account discovery is unavailable'), {
                            code: 'connected_account_attempt_discovery_unavailable',
                        });
                    }
                    const attempts = await params.persistence.attempts.listPending(command.service);
                    assertNotAborted(options?.signal);
                    return Object.freeze({ status: 'pendingAttempts' as const, attempts });
                }
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
                        // Discovery answers from the descriptor. Booting the plugin to
                        // describe it is what couples Settings and offline inspection to
                        // runtime activation; the cold projection carries the descriptor,
                        // the generation identity and the currentness closure.
                        const contribution =
                            lease.registry.connectedAccountContributions?.describe(
                                command.service,
                            ) ?? null;
                        if (
                            !contribution
                            || !sameService(contribution.ref, command.service)
                        ) {
                            return {
                                status: 'unavailable' as const,
                                code: 'connected_account_service_unavailable',
                            };
                        }
                        // A retired generation is a currentness fact, not an absent
                        // service. The executable path reported these apart by throwing;
                        // the cold path must keep them apart without activating.
                        if (!contribution.isCurrent()) {
                            return {
                                status: 'unavailable' as const,
                                code: 'connected_account_runtime_generation_changed',
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
                            occurrenceId: contribution.occurrenceId,
                            sourceCustody: contribution.sourceCustody,
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
                    // The revocation has settled at its canonical owner. A
                    // caller detaching now cannot undo the credential delete,
                    // so the committed outcome is reported rather than
                    // reclassified as an unavailable control result.
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
                if (replacement.status !== 'committed') {
                    assertNotAborted(options?.signal);
                    return replacement;
                }
                // Past this point the configuration mutation is committed at
                // its canonical owner. Caller cancellation is authoritative
                // only before commit; the required post-commit consequence and
                // the settled result must still be produced.
                if (!await configuration.isCurrent(replacement.snapshot)) {
                    return Object.freeze({
                        status: 'conflict' as const,
                        code: 'connected_account_configuration_consequence_stale',
                    });
                }
                const accounts = await resolveConsequenceAccounts(basis);
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
                    if (!await configuration.isCurrent(replacement.snapshot)) {
                        return Object.freeze({
                            status: 'conflict' as const,
                            code: 'connected_account_configuration_consequence_stale',
                        });
                    }
                }
                const view = await configuration.inspect(basis);
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
            const attemptId = 'attemptId' in command ? command.attemptId : null;
            const before = attemptId ? attempts.inspectObservability(attemptId) : null;
            const directService = command.operation === 'beginConnect'
                ? command.service
                : command.operation === 'beginReconnect'
                    ? command.account.service
                    : null;
            const report = (input: Readonly<{
                status: ConnectedAccountAttemptResponse['status'];
                attemptId: string | null;
                code: unknown;
                diagnostic: unknown;
            }>) => {
                const context = input.attemptId
                    ? attempts.inspectObservability(input.attemptId) ?? before
                    : before;
                const service = context?.service ?? directService;
                logAuthenticationAttempt({
                    operation: command.operation,
                    service,
                    attemptId: input.attemptId,
                    status: input.status,
                    code: safeLogCode(input.code),
                    diagnostic: input.diagnostic,
                    settlementPhase: context?.settlementPhase ?? 'notPrepared',
                });
            };
            try {
            const response: ConnectedAccountAttemptResponse = await (async () => {
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
                    return await attempts.read({
                        attemptId: command.attemptId,
                        ...(command.restoreKind ? { restoreKind: command.restoreKind } : {}),
                    });
            }
            })();
            report({
                status: response.status,
                attemptId: 'attemptId' in response ? response.attemptId ?? attemptId : attemptId,
                code: 'code' in response ? response.code : null,
                diagnostic: 'diagnostic' in response ? response.diagnostic : null,
            });
            return response;
            } catch (error) {
                report({
                    status: 'unavailable',
                    attemptId,
                    code: error && typeof error === 'object' && 'code' in error ? error.code : 'connected_account_attempt_unavailable',
                    diagnostic: null,
                });
                throw error;
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
                admit: async () => undefined,
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
