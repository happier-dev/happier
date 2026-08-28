import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { isLegacyServiceKeyedCompatibilityCatalogAgent } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import {
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
    isPersistedExecutionRunConnectedServicesLaunchIdentityExact,
    normalizePersistedExecutionRunConnectedServicesLaunchV1,
    ExecutionRunConnectedServicesCleanupReceiptV1Schema,
    type ExecutionRunAgentContributionIdentityV1,
} from '@happier-dev/protocol';

import type { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { ConnectedServiceMaterializationBlockedError } from '../materialize/materializeConnectedServicesForSpawn';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import {
    scopeConnectedAccountPurposeBindingLease,
    type ConnectedAccountPurposeBindingLease,
    type ConnectedAccountPurposeBindingOwner,
} from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import type {
    ConnectedAccountRequestAuthCapabilityDescriptor,
} from '../requestAuth/capabilityFile';
import type {
    ConnectedAccountRequestAuthSubjectRegistry,
} from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
    resolveQualifiedPurposeBindingSnapshotForAgentSpawn,
    resolveQualifiedRequestAuthPurposeBindingsFromSnapshot,
    type AgentSpawnQualifiedPurposeBindingSnapshot,
    type AgentSpawnPurposeContributions,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
    CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES,
    type ConnectedServiceRunMaterializationHandler,
    type ConnectedServiceRunMaterializeRequest,
    type ConnectedServiceRunReleaseHandler,
    type ExecutionRunConnectedServicesRegistrationV1,
} from './materializeContract';

/**
 * Daemon-side execution-run connected-services bridge.
 *
 * ONE resolver: materialization goes through the canonical spawn-auth owner
 * (`resolveConnectedServiceAuthForSpawn`) with a RUN-scoped materialization key (the runId, which
 * is globally unique and path-safe). Run targets register into the shared runtime registry's run
 * keyspace on the canonical runtime registry so its refresh/quota views, canonical group-home
 * ownership, and usage identity cover materialized run roots exactly like session roots. Fail
 * closed: any resolution failure yields a blocked result — the run must not start on the selected
 * auth.
 */

type ResolveAuthForSpawnInput = Pick<
    Parameters<typeof resolveConnectedServiceAuthForSpawn>[0],
    | 'agentId'
    | 'connectedServicesBindingsRaw'
    | 'materializationKey'
    | 'sessionDirectory'
    | 'vendorResumeId'
    | 'resumeReachabilityRequired'
    | 'resolveQualifiedPurposeBindingSnapshot'
    | 'activateQualifiedPurposeBindings'
>;

type ResolveAuthForSpawn = (
    input: ResolveAuthForSpawnInput,
) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

type ExecutionRunAgentPurposeContributions =
    AgentSpawnPurposeContributions
    & Readonly<{
        catalogEntriesById?: Readonly<Record<
            string,
            Pick<AgentCatalogEntry, 'connectedServiceIds'>
        >>;
    }>;

export type ExecutionRunTargetRegistration = Readonly<{
    runKey: string;
    runnerPid: number;
    agentId: CatalogAgentId;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
    sessionId?: string | null;
    sessionDirectory?: string | null;
}>;

export type CreateExecutionRunConnectedServicesBridgeDeps = Readonly<{
    resolveAuthForSpawn: ResolveAuthForSpawn;
    registerRunTargets: (registration: ExecutionRunTargetRegistration) => void;
    unregisterRunTargets: (runKey: string) => void;
    resolveRunMaterializedRoot: (input: Readonly<{
        runKey: string;
        agentId: CatalogAgentId;
    }>) => string | null;
    createAdoptedRootCleanup: (input: Readonly<{
        runKey: string;
        agentId: CatalogAgentId;
        materializedRoot: string;
    }>) => (() => void | Promise<void>) | null;
    captureRunnerIdentity: (input: Readonly<{
        runnerPid: number;
        expectedParentSessionId?: string;
    }>) => Readonly<{
        /** Existing daemon-local tracked-runner identity object; never a newly minted authority. */
        identity: object;
        parentSessionId: string;
        isCurrent(): boolean;
    }> | null;
    acquireAgentPurposeContributions: (input: Readonly<{
        agentId: CatalogAgentId;
    }>) => Promise<Readonly<{
        contributions: ExecutionRunAgentPurposeContributions;
        /**
         * The exact immutable Agent contribution this lease's registry would derive purposes and
         * request-auth uses from. `null` when the registry cannot prove one, which makes the run
         * unadoptable rather than adoptable under whatever generation is current later.
         */
        resolveAgentContributionIdentity(): Promise<
            ExecutionRunAgentContributionIdentityV1 | null
        >;
        isCurrent(): boolean;
        release(): Promise<void>;
    }>>;
    purposeBindingOwner: Pick<
        ConnectedAccountPurposeBindingOwner,
        'activatePurposeBindings'
    >;
    requestAuthRegistry: Pick<
        ConnectedAccountRequestAuthSubjectRegistry,
        'activate' | 'retire'
    >;
    resolveRequestAuthHttpPort: () => number;
    createRedactionLease: () => Readonly<{
        add(values: readonly string[]): void;
        close(): void;
    }>;
    clearTerminalCleanupReceipt: (runKey: string) => Promise<void>;
}>;

export type ExecutionRunConnectedServicesBridge = Readonly<{
    materialize: ConnectedServiceRunMaterializationHandler;
    release: ConnectedServiceRunReleaseHandler;
    adoptLiveMaterialization: (input: Readonly<{
        runId: string;
        runnerPid: number;
        sessionId: string;
        persistedLaunch: unknown;
    }>) => Promise<boolean>;
    cleanupTerminalMaterialization: (input: Readonly<{
        runId: string;
        runnerPid: number;
        sessionId: string | null;
        receipt: unknown;
    }>) => Promise<boolean>;
    releaseForRunnerExit: (input: Readonly<{
        runnerPid: number;
        runnerIdentity: object;
    }>) => Promise<void>;
}>;

type RunReleaseEntry = {
    activationId: string;
    /**
     * A failed daemon-replacement adoption may retain only exact root-cleanup
     * custody. It must never be mistaken for fresh purpose/request-auth/run
     * target authority on a later idempotent recovery attempt.
     */
    authorityActive: boolean;
    runKey: string;
    runnerPid: number;
    runnerIdentity: object;
    agentId: CatalogAgentId;
    cleanupOnFailure: (() => void | Promise<void>) | null;
    cleanupOnExit: (() => void | Promise<void>) | null;
    cleanupPromise: Promise<void> | null;
    retiring: boolean;
    targetsMayBeRegistered: boolean;
    purposeBindingLease: ConnectedAccountPurposeBindingLease | null;
    requestAuthCapability: ConnectedAccountRequestAuthCapabilityDescriptor | null;
    requestAuthCapabilityRetired: boolean;
    redactionLease: Readonly<{ close(): void }> | null;
    redactionLeaseClosed: boolean;
    contributionLease: Readonly<{ release(): Promise<void> }> | null;
    contributionLeaseReleased: boolean;
};

type PendingRunMaterialization = Readonly<{
    runKey: string;
    runnerPid: number;
    runnerIdentity: object;
}>;

function blocked(errorMessage: string): Readonly<{
    ok: false;
    errorCode: typeof CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked;
    errorMessage: string;
}> {
    return {
        ok: false,
        errorCode: CONNECTED_SERVICE_RUN_MATERIALIZATION_ERROR_CODES.blocked,
        errorMessage,
    };
}

function buildRunKey(input: Pick<ConnectedServiceRunMaterializeRequest, 'runId'>): string {
    return input.runId.trim();
}

function readRuntimeIdentityEnv(env: Readonly<Record<string, string>>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (
            key === HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY
            || key.endsWith('CONNECTED_SERVICE_SELECTION_IDENTITY')
        ) {
            out[key] = value;
        }
    }
    return out;
}

export function createExecutionRunConnectedServicesBridge(
    deps: CreateExecutionRunConnectedServicesBridgeDeps,
): ExecutionRunConnectedServicesBridge {
    const retainedCleanupByRunKey = new Map<string, RunReleaseEntry>();
    const pendingMaterializationByRunKey =
        new Map<string, PendingRunMaterialization>();
    const mutationTailByRunKey = new Map<string, Promise<void>>();

    const withRunKeyMutation = async <T>(
        runKey: string,
        operation: () => Promise<T>,
    ): Promise<T> => {
        const prior = mutationTailByRunKey.get(runKey) ?? Promise.resolve();
        let complete!: () => void;
        const ownCompletion = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const tail = prior.catch(() => undefined).then(
            async () => await ownCompletion,
        );
        mutationTailByRunKey.set(runKey, tail);
        await prior.catch(() => undefined);
        try {
            return await operation();
        } finally {
            complete();
            if (mutationTailByRunKey.get(runKey) === tail) {
                mutationTailByRunKey.delete(runKey);
            }
        }
    };

    const cleanupEntry = async (
        entry: RunReleaseEntry,
        options: Readonly<{
            beforeAdmission?: boolean;
            skipFilesystem?: boolean;
            clearTerminalReceipt?: boolean;
        }> = {},
    ): Promise<boolean> => {
        entry.cleanupPromise ??= (async () => {
            // Currentness is revoked synchronously before capability or materialized-root I/O.
            entry.retiring = true;
            entry.purposeBindingLease?.dispose();
            if (entry.targetsMayBeRegistered) {
                entry.targetsMayBeRegistered = false;
                deps.unregisterRunTargets(entry.runKey);
            }
            if (
                entry.requestAuthCapability
                && !entry.requestAuthCapabilityRetired
            ) {
                entry.requestAuthCapabilityRetired = true;
                try {
                    await deps.requestAuthRegistry.retire(
                        entry.requestAuthCapability,
                    );
                } catch (error) {
                    // Registry retirement removes authority synchronously. A later full-root cleanup
                    // is the bounded filesystem fallback for a failed capability-file unlink.
                    logger.debug(
                        '[DAEMON RUN] Execution-run request-auth capability file cleanup failed',
                        {
                            runId: entry.runKey,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );
                }
            }
            if (entry.redactionLease && !entry.redactionLeaseClosed) {
                entry.redactionLeaseClosed = true;
                entry.redactionLease.close();
            }
            if (entry.contributionLease && !entry.contributionLeaseReleased) {
                entry.contributionLeaseReleased = true;
                await entry.contributionLease.release().catch((error) => {
                    logger.debug(
                        '[DAEMON RUN] Execution-run Agent contribution lease release failed',
                        {
                            runId: entry.runKey,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );
                });
            }
            if (!options.skipFilesystem) {
                const cleanupFilesystem = options.beforeAdmission
                    ? entry.cleanupOnFailure ?? entry.cleanupOnExit
                    : entry.cleanupOnExit;
                await cleanupFilesystem?.();
                if (options.clearTerminalReceipt !== false) {
                    await deps.clearTerminalCleanupReceipt(entry.runKey);
                }
            }
        })();
        try {
            await entry.cleanupPromise;
        } catch (error) {
            entry.cleanupPromise = null;
            logger.debug(
                '[DAEMON RUN] Execution-run connected services cleanup failed',
                {
                    runId: entry.runKey,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            );
            return false;
        }
        if (retainedCleanupByRunKey.get(entry.runKey) === entry) {
            retainedCleanupByRunKey.delete(entry.runKey);
        }
        return true;
    };

    const cleanupPriorRunKey = async (runKey: string): Promise<boolean> => {
        const previousEntry = retainedCleanupByRunKey.get(runKey);
        return previousEntry ? await cleanupEntry(previousEntry) : true;
    };

    const cleanupUnadmittedMaterialization = async (input: Readonly<{
        runKey: string;
        cleanupFilesystem: (() => void | Promise<void>) | null;
        contributionLease: Readonly<{ release(): Promise<void> }>;
    }>): Promise<void> => {
        const cleanupResults = await Promise.allSettled([
            Promise.resolve().then(async () => {
                await input.cleanupFilesystem?.();
            }),
            Promise.resolve().then(async () => {
                await input.contributionLease.release();
            }),
        ]);
        for (const result of cleanupResults) {
            if (result.status === 'fulfilled') continue;
            logger.debug(
                '[DAEMON RUN] Unadmitted execution-run materialization cleanup failed',
                {
                    runId: input.runKey,
                    error:
                        result.reason instanceof Error
                            ? result.reason.message
                            : String(result.reason),
                },
            );
        }
    };

    const prepareEntry = async (input: Readonly<{
        activationId: string;
        runKey: string;
        runnerPid: number;
        agentId: CatalogAgentId;
        runner: NonNullable<
            ReturnType<CreateExecutionRunConnectedServicesBridgeDeps['captureRunnerIdentity']>
        >;
        connectedServicesBindings: Parameters<
            typeof resolveQualifiedPurposeBindingSnapshotForAgentSpawn
        >[0]['bindings'];
        qualifiedPurposeBindingSnapshot?: AgentSpawnQualifiedPurposeBindingSnapshot | null;
        materializedRoot: string | null;
        env: Readonly<Record<string, string>>;
        cleanupOnFailure: (() => void | Promise<void>) | null;
        cleanupOnExit: (() => void | Promise<void>) | null;
        contributionLease?: Awaited<
            ReturnType<
                CreateExecutionRunConnectedServicesBridgeDeps[
                    'acquireAgentPurposeContributions'
                ]
            >
        >;
    }>): Promise<RunReleaseEntry> => {
        const contributionLeaseProvided = input.contributionLease !== undefined;
        const contributionLease =
            input.contributionLease
            ?? await deps.acquireAgentPurposeContributions({
                agentId: input.agentId,
            });
        let purposeBindingLease: ConnectedAccountPurposeBindingLease | null =
            null;
        let requestAuthCapability:
            ConnectedAccountRequestAuthCapabilityDescriptor
            | null = null;
        let redactionLease:
            ReturnType<CreateExecutionRunConnectedServicesBridgeDeps[
                'createRedactionLease'
            ]>
            | null = null;
        let activationOpen = true;
        let entry: RunReleaseEntry | null = null;
        try {
            const purposeSnapshot = input.qualifiedPurposeBindingSnapshot !== undefined
                ? input.qualifiedPurposeBindingSnapshot
                : resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                    agentId: input.agentId,
                    bindings: input.connectedServicesBindings,
                    contributions: contributionLease.contributions,
                });
            const requestAuthPurposeBindings =
                resolveQualifiedRequestAuthPurposeBindingsFromSnapshot(
                    purposeSnapshot,
                );
            const subjectIsCurrent = (): boolean => {
                if (
                    !input.runner.isCurrent()
                    || !contributionLease.isCurrent()
                ) {
                    return false;
                }
                if (activationOpen) return true;
                return entry !== null
                    && !entry.retiring
                    && retainedCleanupByRunKey.get(input.runKey) === entry;
            };
            if (purposeSnapshot?.purposes.length) {
                purposeBindingLease =
                    deps.purposeBindingOwner.activatePurposeBindings({
                        subject: {
                            kind: 'execution_run',
                            runId: input.runKey,
                            runnerPid: input.runnerPid,
                            agentId: input.agentId,
                            isCurrent: subjectIsCurrent,
                        },
                        purposes: purposeSnapshot.purposes,
                        bindings: purposeSnapshot.bindings,
                    });
            }
            if (requestAuthPurposeBindings.length > 0) {
                const legacyConnectedServiceCatalogAgent =
                    isLegacyServiceKeyedCompatibilityCatalogAgent(
                        contributionLease.contributions.catalogEntriesById?.[
                            input.agentId
                        ],
                    );
                const capabilityPath =
                    input.materializedRoot
                        ? resolveConnectedAccountRequestAuthCapabilityPath(
                            input.materializedRoot,
                        )
                        : '';
                if (
                    !purposeBindingLease
                    || !purposeSnapshot?.requestAuthUses?.length
                    || !input.materializedRoot
                    || input.env[
                        CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV
                    ] !== capabilityPath
                ) {
                    throw new Error(
                        'execution_run_request_auth_materialization_unavailable',
                    );
                }
                redactionLease = deps.createRedactionLease();
                requestAuthCapability =
                    await deps.requestAuthRegistry.activate({
                        subject: scopeConnectedAccountPurposeBindingLease({
                            lease: purposeBindingLease,
                            subjectId: purposeBindingLease.subjectId,
                            uses: purposeSnapshot.requestAuthUses,
                            ...(legacyConnectedServiceCatalogAgent
                                ? {
                                    legacyServiceKeyedCompatibility:
                                        true as const,
                                }
                                : {}),
                            registerRedaction: redactionLease.add,
                        }),
                        materializedRootDir: input.materializedRoot,
                        materializationId: input.runKey,
                        httpPort: deps.resolveRequestAuthHttpPort(),
                    });
                if (requestAuthCapability.path !== capabilityPath) {
                    throw new Error(
                        'execution_run_request_auth_capability_path_mismatch',
                    );
                }
            }
            if (!subjectIsCurrent()) {
                throw new Error('execution_run_authority_not_current');
            }
            entry = {
                activationId: input.activationId,
                authorityActive: true,
                runKey: input.runKey,
                runnerPid: input.runnerPid,
                runnerIdentity: input.runner.identity,
                agentId: input.agentId,
                cleanupOnFailure: input.cleanupOnFailure,
                cleanupOnExit: input.cleanupOnExit,
                cleanupPromise: null,
                retiring: false,
                targetsMayBeRegistered: false,
                purposeBindingLease,
                requestAuthCapability,
                requestAuthCapabilityRetired: false,
                redactionLease,
                redactionLeaseClosed: false,
                contributionLease,
                contributionLeaseReleased: false,
            };
            retainedCleanupByRunKey.set(input.runKey, entry);
            activationOpen = false;
            return entry;
        } catch (error) {
            activationOpen = false;
            purposeBindingLease?.dispose();
            if (requestAuthCapability) {
                await deps.requestAuthRegistry
                    .retire(requestAuthCapability)
                    .catch(() => undefined);
            }
            redactionLease?.close();
            if (!contributionLeaseProvided) {
                await contributionLease.release().catch(() => undefined);
            }
            throw error;
        }
    };

    const adoptLiveMaterialization: ExecutionRunConnectedServicesBridge[
        'adoptLiveMaterialization'
    ] = async (input) => {
        const normalized =
            normalizePersistedExecutionRunConnectedServicesLaunchV1(
                input.persistedLaunch,
            );
        if (
            !normalized
            || !isPersistedExecutionRunConnectedServicesLaunchIdentityExact({
                markerRunId: input.runId,
                normalized,
            })
        ) {
            return false;
        }
        const registration = normalized.registration;
        const registrationAgentId = registration.agentId;
        if (
            registration.materializationKey !== registration.runKey
            || !isCatalogAgentId(registrationAgentId)
        ) {
            return false;
        }
        return await withRunKeyMutation(registration.runKey, async () => {
            const runner = deps.captureRunnerIdentity({
                runnerPid: input.runnerPid,
                expectedParentSessionId: input.sessionId,
            });
            if (!runner || !runner.isCurrent()) return false;
            const current = retainedCleanupByRunKey.get(registration.runKey);
            const matchesCurrentRunner = Boolean(
                current
                && !current.retiring
                && current.runnerPid === input.runnerPid
                && current.runnerIdentity === runner.identity
                && current.agentId === registration.agentId
                && (
                    registration.activationId === undefined
                    || current.activationId === registration.activationId
                )
            );
            if (matchesCurrentRunner && current?.authorityActive) {
                return true;
            }

            // A run key names one execution-run materialization. A distinct
            // live runner claiming that key cannot safely inherit or replace
            // the incumbent's cleanup: doing either would either delete the
            // incumbent root or leave the newly discovered root without a
            // release/exit fence. Refuse before creating an unowned cleanup
            // closure; the existing entry remains the sole exact custody.
            if (current && !matchesCurrentRunner) {
                logger.debug(
                    '[DAEMON RUN] Execution-run adoption refused for conflicting live run-key custody',
                    { runId: input.runId, runnerPid: input.runnerPid },
                );
                return false;
            }

            // Retain only the exact existing materialized-root custody before
            // checking whether fresh authority can be reconstructed. A live
            // runner proves the root still needs cleanup, but does not prove a
            // current registry declaration may become its authority.
            let cleanupOnExit: (() => void | Promise<void>) | null = null;
            let cleanupOnlyEntry: RunReleaseEntry | null = null;
            if (registration.materializedRoot) {
                cleanupOnExit = matchesCurrentRunner && current
                    ? current.cleanupOnExit
                    : deps.createAdoptedRootCleanup({
                        runKey: registration.runKey,
                        agentId: registrationAgentId,
                        materializedRoot: registration.materializedRoot,
                    });
                if (!cleanupOnExit) {
                    logger.debug(
                        '[DAEMON RUN] Execution-run adoption refused without exact adopted-root cleanup custody',
                        { runId: input.runId, runnerPid: input.runnerPid },
                    );
                    return false;
                }
                if (!current) {
                    cleanupOnlyEntry = {
                        activationId: registration.activationId ?? randomUUID(),
                        authorityActive: false,
                        runKey: registration.runKey,
                        runnerPid: input.runnerPid,
                        runnerIdentity: runner.identity,
                        agentId: registrationAgentId,
                        cleanupOnFailure: null,
                        cleanupOnExit,
                        cleanupPromise: null,
                        retiring: false,
                        targetsMayBeRegistered: false,
                        purposeBindingLease: null,
                        requestAuthCapability: null,
                        requestAuthCapabilityRetired: false,
                        redactionLease: null,
                        redactionLeaseClosed: false,
                        contributionLease: null,
                        contributionLeaseReleased: false,
                    };
                    retainedCleanupByRunKey.set(
                        registration.runKey,
                        cleanupOnlyEntry,
                    );
                } else if (matchesCurrentRunner) {
                    cleanupOnlyEntry = current;
                }
            }
            // A live runner proves only that a process still exists, never which build of the
            // Agent it is executing. Purposes and request-auth uses below are derived from the
            // registry current RIGHT NOW, so adoption is only sound when that registry still
            // offers the exact contribution generation this run was launched with. A record whose
            // writer could not prove one — including a predecessor-shaped marker — is unproven
            // and must not be upgraded into fresh request-auth authority.
            let contributionLease: Awaited<ReturnType<
                CreateExecutionRunConnectedServicesBridgeDeps[
                    'acquireAgentPurposeContributions'
                ]
            >>;
            try {
                contributionLease = await deps.acquireAgentPurposeContributions({
                    agentId: registrationAgentId,
                });
            } catch (error) {
                logger.debug(
                    '[DAEMON RUN] Execution-run adoption refused while recovering Agent contribution authority',
                    {
                        runId: input.runId,
                        runnerPid: input.runnerPid,
                        error: error instanceof Error ? error.message : String(error),
                    },
                );
                return false;
            }
            const releaseUnusedLease = async (reason: string): Promise<false> => {
                await contributionLease.release().catch(() => undefined);
                logger.debug(
                    '[DAEMON RUN] Execution-run adoption refused without exact Agent generation correspondence',
                    { runId: input.runId, runnerPid: input.runnerPid, reason },
                );
                return false;
            };
            const currentAgentContribution = await contributionLease
                .resolveAgentContributionIdentity();
            const launchedAgentContribution = registration.agentContribution;
            if (!launchedAgentContribution) {
                return await releaseUnusedLease('launch_generation_unproven');
            }
            if (
                !currentAgentContribution
                || currentAgentContribution.pluginId
                    !== launchedAgentContribution.pluginId
                || currentAgentContribution.localId
                    !== launchedAgentContribution.localId
                || currentAgentContribution.immutableGenerationId
                    !== launchedAgentContribution.immutableGenerationId
            ) {
                return await releaseUnusedLease('current_generation_differs');
            }

            // The cleanup-only entry above is this exact root's existing
            // custody. Reusing it through the authority transition prevents a
            // valid A→B recovery from deleting B's root before it is admitted.
            if (!cleanupOnlyEntry && !(await cleanupPriorRunKey(registration.runKey))) {
                return await releaseUnusedLease('prior_run_cleanup_failed');
            }
            let entry: RunReleaseEntry | null = null;
            try {
                entry = await prepareEntry({
                    activationId: registration.activationId ?? randomUUID(),
                    runKey: registration.runKey,
                    runnerPid: input.runnerPid,
                    agentId: registrationAgentId,
                    runner,
                    contributionLease,
                    connectedServicesBindings:
                        registration.connectedServicesBindings,
                    materializedRoot: registration.materializedRoot,
                    env: registration.materializedRoot
                        ? {
                            [CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]:
                                resolveConnectedAccountRequestAuthCapabilityPath(
                                    registration.materializedRoot,
                                ),
                        }
                        : {},
                    cleanupOnFailure: null,
                    cleanupOnExit,
                });
                entry.targetsMayBeRegistered = true;
                deps.registerRunTargets({
                    runKey: registration.runKey,
                    runnerPid: input.runnerPid,
                    agentId: registrationAgentId,
                    materializationKey: registration.materializationKey,
                    connectedServicesBindingsRaw:
                        registration.connectedServicesBindings,
                    connectedServiceSelectionsEnv:
                        registration.connectedServiceSelectionsEnv,
                    sessionId: runner.parentSessionId,
                    sessionDirectory: registration.sessionDirectory,
                });
                return true;
            } catch (error) {
                if (entry) {
                    // The entry owns the lease once `prepareEntry` returns it.
                    await cleanupEntry(entry, { skipFilesystem: true });
                    // `prepareEntry` temporarily replaces the cleanup-only
                    // incumbent while authority is staged. If target
                    // registration fails, restore that exact root custody;
                    // no authority survives, but release/runner-exit must still
                    // delete the already-materialized root exactly once.
                    if (
                        cleanupOnlyEntry
                        && !cleanupOnlyEntry.retiring
                        && runner.isCurrent()
                        && !retainedCleanupByRunKey.has(registration.runKey)
                    ) {
                        retainedCleanupByRunKey.set(
                            registration.runKey,
                            cleanupOnlyEntry,
                        );
                    }
                } else {
                    await contributionLease.release().catch(() => undefined);
                }
                logger.debug(
                    '[DAEMON RUN] Exact execution-run request-auth adoption failed closed',
                    {
                        runId: input.runId,
                        runnerPid: input.runnerPid,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                );
                return false;
            }
        });
    };

    const materialize: ConnectedServiceRunMaterializationHandler = async (input) => {
        const runKey = buildRunKey(input);
        return await withRunKeyMutation(runKey, async () => {
            const agentId = input.agentId.trim();
            if (!isCatalogAgentId(agentId)) {
                return blocked(`Execution-run connected services are not supported for backend '${agentId}'`);
            }

            const runner = deps.captureRunnerIdentity({
                runnerPid: input.runnerPid,
            });
            if (!runner || !runner.isCurrent()) {
                return blocked(
                    'Execution-run connected services runner identity is not current',
                );
            }
            if (!(await cleanupPriorRunKey(runKey))) {
                return blocked(
                    'Previous run materialization cleanup failed',
                );
            }

            const pendingMaterialization: PendingRunMaterialization = {
                runKey,
                runnerPid: input.runnerPid,
                runnerIdentity: runner.identity,
            };
            pendingMaterializationByRunKey.set(runKey, pendingMaterialization);
            try {
                let contributionLease: Awaited<
                    ReturnType<
                        CreateExecutionRunConnectedServicesBridgeDeps[
                            'acquireAgentPurposeContributions'
                        ]
                    >
                >;
                try {
                    contributionLease =
                        await deps.acquireAgentPurposeContributions({ agentId });
                } catch (error) {
                    return blocked(
                        error instanceof Error
                            ? error.message
                            : 'Agent purpose contributions are unavailable',
                    );
                }
                if (!runner.isCurrent()) {
                    await cleanupUnadmittedMaterialization({
                        runKey,
                        cleanupFilesystem: null,
                        contributionLease,
                    });
                    return blocked(
                        'Execution-run connected services runner identity is not current',
                    );
                }
                let resolved: Awaited<ReturnType<ResolveAuthForSpawn>>;
                try {
                    resolved = await deps.resolveAuthForSpawn({
                        agentId,
                        connectedServicesBindingsRaw: input.connectedServices,
                        materializationKey: runKey,
                        sessionDirectory: input.cwd,
                        vendorResumeId: null,
                        resumeReachabilityRequired: false,
                        resolveQualifiedPurposeBindingSnapshot: (bindings) =>
                            resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                                agentId,
                                bindings,
                                contributions: contributionLease.contributions,
                            }),
                        activateQualifiedPurposeBindings: (snapshot) =>
                            deps.purposeBindingOwner.activatePurposeBindings({
                                subject: {
                                    kind: 'execution_run',
                                    runId: runKey,
                                    runnerPid: input.runnerPid,
                                    agentId,
                                    isCurrent: () => (
                                        runner.isCurrent()
                                        && contributionLease.isCurrent()
                                    ),
                                },
                                purposes: snapshot.purposes,
                                bindings: snapshot.bindings,
                            }),
                    });
                } catch (error) {
                    await cleanupUnadmittedMaterialization({
                        runKey,
                        cleanupFilesystem: null,
                        contributionLease,
                    });
                    if (error instanceof ConnectedServiceMaterializationBlockedError) {
                        logger.warn('[DAEMON RUN] Execution-run connected services materialization blocked; failing closed', {
                            runId: input.runId,
                            agentId,
                            diagnostics: error.diagnostics.map((diagnostic) => ({
                                code: diagnostic.code,
                                serviceId: diagnostic.serviceId,
                                reason: diagnostic.reason,
                                severity: diagnostic.severity,
                            })),
                        });
                        const reason = error.diagnostics.map((diagnostic) => diagnostic.reason).filter(Boolean).join('; ');
                        return blocked(reason || 'Connected service materialization blocked');
                    }
                    logger.warn('[DAEMON RUN] Execution-run connected services resolution failed; failing closed', {
                        runId: input.runId,
                        agentId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return blocked(error instanceof Error ? error.message : 'Connected services resolution failed');
                }

                if (!resolved) {
                    await cleanupUnadmittedMaterialization({
                        runKey,
                        cleanupFilesystem: null,
                        contributionLease,
                    });
                    // The runner only asks when it holds a connected selection; an empty resolution means
                    // the selection could not be honored. Fail closed rather than silently running native.
                    return blocked('Connected services selection resolved no materialized auth');
                }

                let cleanupOnFailure: (() => void | Promise<void>) | null =
                    resolved.materializationPurposeLease
                        ? async () => {
                            await Promise.resolve(resolved.cleanupOnFailure?.());
                            await resolved.materializationPurposeLease?.dispose();
                        }
                        : resolved.cleanupOnFailure;
                let entry: RunReleaseEntry | null = null;
                try {
                    const env: Record<string, string> = { ...resolved.env };
                    const materializedRoot = resolved.targetMaterializedRoot
                        ? deps.resolveRunMaterializedRoot({ runKey, agentId })
                        : null;
                    const cleanupOnExit = resolved.cleanupOnExit
                        ?? (materializedRoot
                            ? deps.createAdoptedRootCleanup({ runKey, agentId, materializedRoot })
                            : null);
                    cleanupOnFailure ??= cleanupOnExit;
                    if (resolved.ongoingRuntimeRegistrationAllowed === false) {
                        throw new Error(
                            'Legacy unfenced connected service materialization cannot be registered as an execution-run runtime target',
                        );
                    }
                    const connectedServicesBindings = resolved.connectedServicesBindings ?? input.connectedServices;
                    const activationId = randomUUID();
                    const agentContribution = await contributionLease
                        .resolveAgentContributionIdentity();
                    entry = await prepareEntry({
                        activationId,
                        runKey,
                        runnerPid: input.runnerPid,
                        agentId,
                        runner,
                        connectedServicesBindings,
                        qualifiedPurposeBindingSnapshot:
                            resolved.qualifiedPurposeBindingSnapshot,
                        materializedRoot,
                        env,
                        cleanupOnFailure,
                        cleanupOnExit,
                        contributionLease,
                    });
                    await resolved.materializationPurposeLease?.dispose();
                    const registration: ExecutionRunConnectedServicesRegistrationV1 = {
                        v: 1,
                        activationId,
                        runKey,
                        agentId,
                        ...(agentContribution ? { agentContribution } : {}),
                        materializationKey: runKey,
                        connectedServicesBindings,
                        connectedServiceSelectionsEnv: readRuntimeIdentityEnv(env),
                        sessionDirectory: input.cwd,
                        materializedRoot,
                    };
                    entry.targetsMayBeRegistered = true;
                    deps.registerRunTargets({
                        runKey,
                        runnerPid: input.runnerPid,
                        agentId,
                        materializationKey: runKey,
                        connectedServicesBindingsRaw: connectedServicesBindings,
                        connectedServiceSelectionsEnv:
                            registration.connectedServiceSelectionsEnv,
                        sessionId: runner.parentSessionId,
                        sessionDirectory: input.cwd,
                    });

                    return {
                        ok: true,
                        activationId,
                        env,
                        connectedServicesBindings,
                        registration,
                    };
                } catch (error) {
                    if (entry) {
                        await cleanupEntry(entry, { beforeAdmission: true });
                    } else {
                        await cleanupUnadmittedMaterialization({
                            runKey,
                            cleanupFilesystem: cleanupOnFailure,
                            contributionLease,
                        });
                    }
                    return blocked(
                        error instanceof Error
                            ? error.message
                            : 'Execution-run connected services admission failed',
                    );
                }
            } finally {
                if (
                    pendingMaterializationByRunKey.get(runKey)
                    === pendingMaterialization
                ) {
                    pendingMaterializationByRunKey.delete(runKey);
                }
            }
        });
    };

    const cleanupTerminalMaterialization: ExecutionRunConnectedServicesBridge[
        'cleanupTerminalMaterialization'
    ] = async (input) => {
        const parsed = ExecutionRunConnectedServicesCleanupReceiptV1Schema
            .safeParse(input.receipt);
        if (!parsed.success || parsed.data.runKey !== input.runId) return false;
        if (!isCatalogAgentId(parsed.data.agentId)) return false;
        return await withRunKeyMutation(parsed.data.runKey, async () => {
            const current = retainedCleanupByRunKey.get(parsed.data.runKey);
            if (current) {
                if (current.activationId !== parsed.data.activationId) {
                    return false;
                }
                return await cleanupEntry(current, {
                    clearTerminalReceipt: false,
                });
            }
            const materializedRoot = deps.resolveRunMaterializedRoot({
                runKey: parsed.data.runKey,
                agentId: parsed.data.agentId,
            });
            if (!materializedRoot) return true;
            const cleanup = deps.createAdoptedRootCleanup({
                runKey: parsed.data.runKey,
                agentId: parsed.data.agentId,
                materializedRoot,
            });
            if (!cleanup) return false;
            const runner = input.sessionId
                ? deps.captureRunnerIdentity({
                    runnerPid: input.runnerPid,
                    expectedParentSessionId: input.sessionId,
                })
                : null;
            if (runner?.isCurrent()) {
                const cleanupOnlyEntry: RunReleaseEntry = {
                    activationId: parsed.data.activationId,
                    authorityActive: false,
                    runKey: parsed.data.runKey,
                    runnerPid: input.runnerPid,
                    runnerIdentity: runner.identity,
                    agentId: parsed.data.agentId,
                    cleanupOnFailure: null,
                    cleanupOnExit: cleanup,
                    cleanupPromise: null,
                    retiring: false,
                    targetsMayBeRegistered: false,
                    purposeBindingLease: null,
                    requestAuthCapability: null,
                    requestAuthCapabilityRetired: false,
                    redactionLease: null,
                    redactionLeaseClosed: false,
                    contributionLease: null,
                    contributionLeaseReleased: false,
                };
                retainedCleanupByRunKey.set(parsed.data.runKey, cleanupOnlyEntry);
                return await cleanupEntry(cleanupOnlyEntry, {
                    clearTerminalReceipt: false,
                });
            }
            try {
                await cleanup();
                return true;
            } catch (error) {
                logger.debug(
                    '[DAEMON RUN] Terminal execution-run materialized-root cleanup failed',
                    {
                        runId: parsed.data.runKey,
                        error: error instanceof Error ? error.message : String(error),
                    },
                );
                return false;
            }
        });
    };

    const release: ConnectedServiceRunReleaseHandler = async (input) => {
        const runKey = buildRunKey(input);
        return await withRunKeyMutation(runKey, async () => {
            const entry = retainedCleanupByRunKey.get(runKey);
            if (
                !entry
                || entry.runnerPid !== input.runnerPid
                || entry.activationId !== input.activationId
            ) {
                return { ok: true, released: false };
            }
            return {
                ok: true,
                released: await cleanupEntry(entry),
            };
        });
    };

    const releaseForRunnerExit: ExecutionRunConnectedServicesBridge[
        'releaseForRunnerExit'
    ] = async (input) => {
        const runKeys = new Set<string>();
        for (const entry of retainedCleanupByRunKey.values()) {
            if (
                entry.runnerPid === input.runnerPid
                && entry.runnerIdentity === input.runnerIdentity
            ) {
                runKeys.add(entry.runKey);
            }
        }
        for (const pending of pendingMaterializationByRunKey.values()) {
            if (
                pending.runnerPid === input.runnerPid
                && pending.runnerIdentity === input.runnerIdentity
            ) {
                runKeys.add(pending.runKey);
            }
        }
        await Promise.all([...runKeys].map(async (runKey) => {
            await withRunKeyMutation(runKey, async () => {
                const current = retainedCleanupByRunKey.get(runKey);
                if (
                    current
                    && current.runnerPid === input.runnerPid
                    && current.runnerIdentity === input.runnerIdentity
                ) {
                    await cleanupEntry(current);
                }
            });
        }));
    };

    return {
        materialize,
        release,
        adoptLiveMaterialization,
        cleanupTerminalMaterialization,
        releaseForRunnerExit,
    };
}
