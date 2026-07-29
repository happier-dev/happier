import { randomUUID } from 'node:crypto';

import { logger } from '@/ui/logger';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import {
    CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import {
    isPersistedExecutionRunConnectedServicesLaunchIdentityExact,
    normalizePersistedExecutionRunConnectedServicesLaunchV1,
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
    resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn,
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

type ResolveAuthForSpawn = (
    input: Parameters<typeof resolveConnectedServiceAuthForSpawn>[0],
) => ReturnType<typeof resolveConnectedServiceAuthForSpawn>;

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
        contributions: AgentSpawnPurposeContributions;
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
    releaseForRunnerExit: (input: Readonly<{
        runnerPid: number;
        runnerIdentity: object;
    }>) => Promise<void>;
}>;

type RunReleaseEntry = {
    activationId: string;
    runKey: string;
    runnerPid: number;
    runnerIdentity: object;
    agentId: CatalogAgentId;
    cleanupOnExit: (() => void | Promise<void>) | null;
    cleanupPromise: Promise<void> | null;
    retiring: boolean;
    targetsRegistered: boolean;
    purposeBindingLease: ConnectedAccountPurposeBindingLease | null;
    requestAuthCapability: ConnectedAccountRequestAuthCapabilityDescriptor | null;
    requestAuthCapabilityRetired: boolean;
    redactionLease: Readonly<{ close(): void }> | null;
    redactionLeaseClosed: boolean;
    contributionLease: Readonly<{ release(): Promise<void> }> | null;
    contributionLeaseReleased: boolean;
};

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
        options: Readonly<{ skipFilesystem?: boolean }> = {},
    ): Promise<boolean> => {
        entry.cleanupPromise ??= (async () => {
            // Currentness is revoked synchronously before capability or materialized-root I/O.
            entry.retiring = true;
            entry.purposeBindingLease?.dispose();
            if (entry.targetsRegistered) {
                entry.targetsRegistered = false;
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
                await entry.cleanupOnExit?.();
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
        materializedRoot: string | null;
        env: Readonly<Record<string, string>>;
        cleanupOnExit: (() => void | Promise<void>) | null;
        contributionLease?: Awaited<
            ReturnType<
                CreateExecutionRunConnectedServicesBridgeDeps[
                    'acquireAgentPurposeContributions'
                ]
            >
        >;
    }>): Promise<RunReleaseEntry> => {
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
            const purposeSnapshot =
                resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
                    agentId: input.agentId,
                    bindings: input.connectedServicesBindings,
                    contributions: contributionLease.contributions,
                });
            const requestAuthPurposeBindings =
                resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn({
                    agentId: input.agentId,
                    bindings: input.connectedServicesBindings,
                    contributions: contributionLease.contributions,
                });
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
                            subjectId:
                                `${purposeBindingLease.subjectId}/agent:${input.agentId}`,
                            uses: purposeSnapshot.requestAuthUses,
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
                runKey: input.runKey,
                runnerPid: input.runnerPid,
                runnerIdentity: input.runner.identity,
                agentId: input.agentId,
                cleanupOnExit: input.cleanupOnExit,
                cleanupPromise: null,
                retiring: false,
                targetsRegistered: false,
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
            await contributionLease.release().catch(() => undefined);
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
            if (
                current
                && !current.retiring
                && current.runnerPid === input.runnerPid
                && current.runnerIdentity === runner.identity
                && current.agentId === registration.agentId
                && (
                    registration.activationId === undefined
                    || current.activationId === registration.activationId
                )
            ) {
                return true;
            }
            if (!(await cleanupPriorRunKey(registration.runKey))) return false;

            let cleanupOnExit: (() => void | Promise<void>) | null = null;
            if (registration.materializedRoot) {
                cleanupOnExit = deps.createAdoptedRootCleanup({
                    runKey: registration.runKey,
                    agentId: registrationAgentId,
                    materializedRoot: registration.materializedRoot,
                });
                if (!cleanupOnExit) return false;
            }
            let entry: RunReleaseEntry | null = null;
            try {
                entry = await prepareEntry({
                    activationId: registration.activationId ?? randomUUID(),
                    runKey: registration.runKey,
                    runnerPid: input.runnerPid,
                    agentId: registrationAgentId,
                    runner,
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
                    cleanupOnExit,
                });
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
                entry.targetsRegistered = true;
                return true;
            } catch (error) {
                if (entry) {
                    await cleanupEntry(entry, { skipFilesystem: true });
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
            let resolved: Awaited<ReturnType<ResolveAuthForSpawn>>;
            try {
                resolved = await deps.resolveAuthForSpawn({
                    agentId,
                    connectedServicesBindingsRaw: input.connectedServices,
                    materializationKey: runKey,
                    sessionDirectory: input.cwd,
                    vendorResumeId: null,
                    resumeReachabilityRequired: false,
                    resolveRequestAuthPurposeBindings: (bindings) =>
                        resolveQualifiedRequestAuthPurposeBindingsForAgentSpawn({
                            agentId,
                            bindings,
                            contributions: contributionLease.contributions,
                        }),
                } as Parameters<ResolveAuthForSpawn>[0]);
            } catch (error) {
                await contributionLease.release().catch(() => undefined);
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
                await contributionLease.release().catch(() => undefined);
                // The runner only asks when it holds a connected selection; an empty resolution means
                // the selection could not be honored. Fail closed rather than silently running native.
                return blocked('Connected services selection resolved no materialized auth');
            }
            if (resolved.ongoingRuntimeRegistrationAllowed === false) {
                await resolved.cleanupOnFailure?.();
                await contributionLease.release().catch(() => undefined);
                return blocked(
                    'Legacy unfenced connected service materialization cannot be registered as an execution-run runtime target',
                );
            }

            const env: Record<string, string> = { ...resolved.env };
            const materializedRoot = resolved.targetMaterializedRoot
                ? deps.resolveRunMaterializedRoot({ runKey, agentId })
                : null;
            const cleanupOnExit = resolved.cleanupOnExit
                ?? (materializedRoot
                    ? deps.createAdoptedRootCleanup({ runKey, agentId, materializedRoot })
                    : null);
            const connectedServicesBindings = resolved.connectedServicesBindings ?? input.connectedServices;
            const activationId = randomUUID();
            let entry: RunReleaseEntry | null = null;
            try {
                entry = await prepareEntry({
                    activationId,
                    runKey,
                    runnerPid: input.runnerPid,
                    agentId,
                    runner,
                    connectedServicesBindings,
                    materializedRoot,
                    env,
                    cleanupOnExit,
                    contributionLease,
                });
            } catch (error) {
                await resolved.cleanupOnFailure?.();
                return blocked(
                    error instanceof Error
                        ? error.message
                        : 'Execution-run request-auth activation failed',
                );
            }
            const registration: ExecutionRunConnectedServicesRegistrationV1 = {
                v: 1,
                activationId,
                runKey,
                agentId,
                materializationKey: runKey,
                connectedServicesBindings,
                connectedServiceSelectionsEnv: readRuntimeIdentityEnv(env),
                sessionDirectory: input.cwd,
                materializedRoot,
            };
            try {
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
                entry.targetsRegistered = true;
            } catch (error) {
                await cleanupEntry(entry);
                return blocked(
                    error instanceof Error
                        ? error.message
                        : 'Execution-run target registration failed',
                );
            }

            return {
                ok: true,
                activationId,
                env,
                connectedServicesBindings,
                registration,
            };
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
        const entries = [...retainedCleanupByRunKey.values()].filter(
            (entry) =>
                entry.runnerPid === input.runnerPid
                && entry.runnerIdentity === input.runnerIdentity,
        );
        await Promise.all(entries.map(async (entry) => {
            await withRunKeyMutation(entry.runKey, async () => {
                const current = retainedCleanupByRunKey.get(entry.runKey);
                if (
                    current === entry
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
        releaseForRunnerExit,
    };
}
