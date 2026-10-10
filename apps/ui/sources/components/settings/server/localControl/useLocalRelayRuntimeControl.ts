import * as React from 'react';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol';
import { redactSensitiveSystemTaskJsonValue } from '@happier-dev/cli-common/systemTasks';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot, waitForSystemTaskResult } from '@/components/systemTasks';
import type { SystemTaskPromptContinuation, SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { t } from '@/text';
import {
    buildLocalRelayRuntimeSystemTaskSpec,
    type LocalRelayRuntimeTaskOptions,
} from '@/components/systemTasks/specs/localControl/buildLocalRelayRuntimeSystemTaskSpec';
import { readRelayRuntimeStatusData, type RelayRuntimeStatusData } from './relayRuntimeStatus';
import { withPersonalHomeEraseDisconnect } from './personalHomeEraseTaskContinuation';
import { completePersonalHomeErase, type PersonalHomeEraseOutcome } from './personalHomeEraseCompletion';

type RelayRuntimeActionKind =
    | 'relay.runtime.installOrUpdate.v1'
    | 'relay.runtime.start.v1'
    | 'relay.runtime.restart.v1'
    | 'relay.runtime.stop.v1';

type PersonalHomeTaskKind =
    | 'relay.runtime.personal_home.inspect.v1'
    | 'relay.runtime.personal_home.backup.v1'
    | 'relay.runtime.personal_home.verify_backup.v1'
    | 'relay.runtime.personal_home.restore.v1'
    | 'relay.runtime.personal_home.erase.v1'
    | 'relay.runtime.personal_home.claim_owner.v1';

type PersonalHomeInspection = Readonly<{
    homeServerIdentityId: string | null;
    schemaVersion: string | null;
    running: boolean;
    masterSecretPresent: boolean;
    databasePresent: boolean;
    databaseBytes: number;
    backupsCount: number;
    backupsCountComplete: boolean;
    latestBackup: Readonly<{
        path: string;
        createdAt: string;
        archiveBytes: number;
    }> | null;
    layoutPaths: Readonly<{
        dataDir: string;
        configDir: string;
        logsDir: string;
        backupsDir: string;
    }>;
    ownedErasePaths: readonly string[];
    estimatedOwnedBytes: number | null;
    estimatedOwnedBytesComplete: boolean;
    estimatedOwnedBytesReason: string | null;
    destinationEmpty: boolean | null;
    restoreRecovery: Readonly<{ status: 'none' | 'rollback_available' | 'finalization_available' | 'ambiguous'; affectedTargets: readonly string[] }>;
    relocationRecovery: Readonly<{
        operationId: string;
        destinationMachineId: string;
        sourceDescriptorRevision: number;
        primaryAction: 'finish_move';
        /** Absent once publication moved writable authority to the destination:
         * returning would abort a Home that may already have accepted writes. */
        secondaryAction?: 'return_to_source';
    }> | null;
}>;

/**
 * Inspection is either an inspected Home fact set or an explicit failure. Task,
 * bridge, and start failures must stay distinguishable from a genuinely
 * ambiguous Home so callers never read an actionable error as recovery
 * corruption.
 */
export type PersonalHomeInspectionOutcome =
    | Readonly<{ status: 'inspected'; inspection: PersonalHomeInspection }>
    | Readonly<{ status: 'failed'; message: string }>;

type PersonalHomeTaskOutcome =
    | Readonly<{ status: 'completed'; result: Extract<SystemTaskResult, { ok: true }> }>
    | Readonly<{ status: 'failed'; message: string }>;

type SystemTaskStartOutcome =
    | Readonly<{ status: 'started'; taskId: string; spec: SystemTaskSpec }>
    | Readonly<{ status: 'failed'; message: string }>;

type PersonalHomeVerification = Readonly<{
    archivePath: string;
    identityMatchesCurrentHome: string | null;
    homeServerIdentityId: string | null;
    format: string | null;
    version: number | null;
    createdAt: string | null;
    archiveBytes: number | null;
}>;

type PersonalHomeBackupFacts = Readonly<{
    path: string;
    bytes: number;
    sha256: string;
    homeServerIdentityId: string;
    createdAt: string;
    homeNeedsAttention: boolean;
    cleanupRequired: Readonly<{ kind: 'backup_staging'; path: string; error: string }> | null;
}>;

type PersonalHomeRecoveryArchive = PersonalHomeBackupFacts & Readonly<{ verified: true }>;

type PersonalHomeLastOperation =
    | Readonly<{ operation: 'backup'; backup: PersonalHomeBackupFacts }>
    | Readonly<{ operation: 'restore'; restore: Readonly<{ outcome: string; recoveryArchive: PersonalHomeRecoveryArchive | null; error: string | null }> }>
    | Readonly<{ operation: 'erase'; erase: PersonalHomeEraseOutcome }>;

function readPersonalHomeBackupFacts(value: unknown): PersonalHomeBackupFacts | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    const manifest = data.manifest && typeof data.manifest === 'object'
        ? data.manifest as Record<string, unknown>
        : {};
    const path = typeof data.path === 'string' ? data.path.trim() : '';
    const sha256 = typeof data.sha256 === 'string' ? data.sha256.trim() : '';
    const homeServerIdentityId = typeof manifest.homeServerIdentityId === 'string'
        ? manifest.homeServerIdentityId.trim()
        : '';
    const createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt.trim() : '';
    const bytes = typeof data.archiveBytes === 'number'
        && Number.isSafeInteger(data.archiveBytes)
        && data.archiveBytes >= 0
        ? data.archiveBytes
        : null;
    if (!path || !sha256 || !homeServerIdentityId || !createdAt || bytes === null) return null;
    return {
        path,
        bytes,
        sha256,
        homeServerIdentityId,
        createdAt,
        homeNeedsAttention: data.homeNeedsAttention === true,
        cleanupRequired: data.cleanupRequired && typeof data.cleanupRequired === 'object'
            && (data.cleanupRequired as Record<string, unknown>).kind === 'backup_staging'
            && typeof (data.cleanupRequired as Record<string, unknown>).path === 'string'
            && typeof (data.cleanupRequired as Record<string, unknown>).error === 'string'
            ? {
                kind: 'backup_staging',
                path: (data.cleanupRequired as Record<string, unknown>).path as string,
                error: (data.cleanupRequired as Record<string, unknown>).error as string,
            }
            : null,
    };
}

function readPersonalHomeRelocationRecovery(value: unknown): PersonalHomeInspection['relocationRecovery'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const facts = value as Record<string, unknown>;
    const operationId = typeof facts.operationId === 'string' ? facts.operationId.trim() : '';
    const destinationMachineId = typeof facts.destinationMachineId === 'string' ? facts.destinationMachineId.trim() : '';
    const sourceDescriptorRevision = facts.sourceDescriptorRevision;
    if (facts.status !== 'recovery_available' || !operationId || !destinationMachineId
        || typeof sourceDescriptorRevision !== 'number'
        || !Number.isSafeInteger(sourceDescriptorRevision)
        || sourceDescriptorRevision < 1) {
        return null;
    }
    if (facts.primaryAction !== 'finish_move'
        || (facts.secondaryAction !== undefined && facts.secondaryAction !== 'return_to_source')) {
        return null;
    }
    return {
        operationId,
        destinationMachineId,
        sourceDescriptorRevision,
        primaryAction: 'finish_move',
        ...(facts.secondaryAction === 'return_to_source' ? { secondaryAction: 'return_to_source' as const } : {}),
    };
}

export async function runRelayRuntimeUninstallTask(runner: SystemTaskRunner): Promise<boolean> {
    const taskId = await runner.start(buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.uninstall.v1'));
    const result = await waitForSystemTaskResult(runner, taskId);
    if (!result.ok) {
        const message = readErrorMessage(result);
        throw new Error(message ?? t('settings.systemTaskStartFailed'));
    }
    if ((result.data as Record<string, unknown> | undefined)?.uninstalled !== true) {
        throw new Error('Runtime uninstall did not confirm completion.');
    }
    return true;
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

export function useLocalRelayRuntimeControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [actionTaskId, setActionTaskId] = React.useState<string | null>(null);
    const [lastStatus, setLastStatus] = React.useState<RelayRuntimeStatusData | null>(null);
    const lastStatusRef = React.useRef<RelayRuntimeStatusData | null>(null);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const [inspection, setInspection] = React.useState<PersonalHomeInspection | null>(null);
    const inspectionRef = React.useRef<PersonalHomeInspection | null>(null);
    const [lastVerification, setLastVerification] = React.useState<PersonalHomeVerification | null>(null);
    const [lastOperation, setLastOperation] = React.useState<PersonalHomeLastOperation | null>(null);
    const [operationTaskId, setOperationTaskId] = React.useState<string | null>(null);
    const [activeOperationSpec, setActiveOperationSpec] = React.useState<SystemTaskSpec | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledActionTaskIdRef = React.useRef<string | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const actionSnapshot = useSystemTaskSnapshot(runner, actionTaskId);
    const operationSnapshot = useSystemTaskSnapshot(runner, operationTaskId);

    const startTask = React.useCallback(async (
        kind: RelayRuntimeActionKind | PersonalHomeTaskKind | 'relay.runtime.status.v1',
        taskOptions: LocalRelayRuntimeTaskOptions = {},
    ): Promise<SystemTaskStartOutcome> => {
        try {
            const currentStatus = lastStatusRef.current;
            const spec = buildLocalRelayRuntimeSystemTaskSpec(kind, {
                ...(currentStatus ? { runtimeTarget: { channel: currentStatus.channel, mode: currentStatus.mode } } : {}),
                ...taskOptions,
            });
            const taskId = await runner.start(spec);
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            return { status: 'started', taskId, spec };
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            const failure = unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed'));
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(failure);
            return { status: 'failed', message: failure };
        }
    }, [runner]);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        const started = await startTask('relay.runtime.status.v1');
        if (started.status !== 'started') {
            return null;
        }
        setStatusTaskId(started.taskId);
        return started.taskId;
    }, [isUnavailable, startTask]);

    const runAction = React.useCallback(async (
        kind: RelayRuntimeActionKind | PersonalHomeTaskKind,
        taskOptions: LocalRelayRuntimeTaskOptions = {},
    ): Promise<SystemTaskStartOutcome> => {
        if (isUnavailable) {
            return { status: 'failed', message: t('settings.systemTaskBridgeUnavailable') };
        }
        const started = await startTask(kind, taskOptions);
        if (started.status !== 'started') {
            return started;
        }
        handledActionTaskIdRef.current = null;
        setActionTaskId(started.taskId);
        return started;
    }, [isUnavailable, startTask]);

    const runTaskAndWait = React.useCallback(async (
        kind: RelayRuntimeActionKind | PersonalHomeTaskKind | 'relay.runtime.status.v1',
        taskOptions: LocalRelayRuntimeTaskOptions = {},
    ): Promise<SystemTaskResult | null> => {
        if (isUnavailable) return null;
        const started = kind === 'relay.runtime.status.v1'
            ? await startTask(kind, taskOptions)
            : await runAction(kind, taskOptions);
        if (started.status !== 'started') return null;
        if (kind === 'relay.runtime.status.v1') setStatusTaskId(started.taskId);
        return await waitForSystemTaskResult(runner, started.taskId);
    }, [isUnavailable, runAction, runner, startTask]);

    const readStatus = React.useCallback(async (): Promise<RelayRuntimeStatusData | null> => {
        const result = await runTaskAndWait('relay.runtime.status.v1');
        if (!result?.ok) {
            setLastErrorMessage(readErrorMessage(result));
            return null;
        }
        const status = readRelayRuntimeStatusData(result);
        if (!status) {
            setLastErrorMessage(t('common.unavailable'));
            return null;
        }
        lastStatusRef.current = status;
        setLastStatus(status);
        setLastErrorMessage(null);
        return status;
    }, [runTaskAndWait]);

    React.useEffect(() => {
        if (isUnavailable) {
            return;
        }
        if (autoRefreshRequestedRef.current) {
            return;
        }
        autoRefreshRequestedRef.current = true;
        void refreshStatus().catch(() => {});
    }, [isUnavailable, refreshStatus]);

    // An operation whose prompts are still being answered by the shared runner
    // outlives this surface. Rediscover it on mount so a remount reattaches to
    // the running task instead of stranding it.
    React.useEffect(() => {
        const continued = runner.listPromptContinuations?.().find((registration) => (
            registration.spec.kind === 'remote.ssh.manageHost.v1'
            && registration.spec.params !== null
            && typeof registration.spec.params === 'object'
            && !Array.isArray(registration.spec.params)
            && 'action' in registration.spec.params
            && registration.spec.params.action === 'personalHome.relocate'
        ));
        if (!continued) return;
        setActionTaskId(continued.taskId);
        setOperationTaskId(continued.taskId);
        setActiveOperationSpec({ ...continued.spec, params: redactSensitiveSystemTaskJsonValue(continued.spec.params) });
    }, [runner]);

    React.useEffect(() => {
        const nextStatus = readRelayRuntimeStatusData(statusSnapshot?.result ?? null);
        if (nextStatus) {
            lastStatusRef.current = nextStatus;
            setLastStatus(nextStatus);
            setLastErrorMessage(null);
            return;
        }

        const errorMessage = readErrorMessage(statusSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [statusSnapshot]);

    React.useEffect(() => {
        if (!actionSnapshot?.result || handledActionTaskIdRef.current === actionSnapshot.taskId) {
            return;
        }

        handledActionTaskIdRef.current = actionSnapshot.taskId;
        if (!actionSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(actionSnapshot.result));
            return;
        }

        const inlineStatus = readRelayRuntimeStatusData(actionSnapshot.result);
        if (inlineStatus) {
            lastStatusRef.current = inlineStatus;
            setLastStatus(inlineStatus);
            setLastErrorMessage(null);
        }

        void refreshStatus().catch(() => {});
    }, [actionSnapshot, refreshStatus]);

    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = actionSnapshot?.result ? null : actionSnapshot ?? (statusSnapshot?.result ? null : statusSnapshot);
        return snapshot ?? null;
    }, [actionSnapshot, statusSnapshot]);

    const isBusy = activeTaskSnapshot != null && activeTaskSnapshot.result == null;

    const runPersonalHomeTask = React.useCallback(async (
        kind: PersonalHomeTaskKind,
        taskOptions: LocalRelayRuntimeTaskOptions = {},
        retainSnapshot = true,
        promptContinuation?: SystemTaskPromptContinuation,
    ): Promise<PersonalHomeTaskOutcome> => {
        if (isUnavailable) return { status: 'failed', message: t('settings.systemTaskBridgeUnavailable') };
        const currentStatus = lastStatusRef.current;
        if (currentStatus?.purpose?.kind !== 'personal-home') {
            setLastErrorMessage(t('settings.localRelayRuntime.statusChecking'));
            return { status: 'failed', message: t('settings.localRelayRuntime.statusChecking') };
        }
        const started = await runAction(kind, {
            ...taskOptions,
            runtimeTarget: { channel: currentStatus.channel, mode: currentStatus.mode },
            purpose: currentStatus.purpose,
        });
        if (started.status !== 'started') return started;
        const taskId = started.taskId;
        if (promptContinuation) runner.registerPromptContinuation?.(taskId, promptContinuation);
        if (retainSnapshot) {
            setOperationTaskId(taskId);
            setActiveOperationSpec({ ...started.spec, params: redactSensitiveSystemTaskJsonValue(started.spec.params) });
        }
        const result = await waitForSystemTaskResult(runner, taskId);
        if (!result.ok) {
            const message = readErrorMessage(result);
            setLastErrorMessage(message);
            return { status: 'failed', message: message ?? t('errors.operationFailed') };
        }
        setLastErrorMessage(null);
        return { status: 'completed', result };
    }, [isUnavailable, runAction, runner]);

    const refreshInspection = React.useCallback(async (): Promise<PersonalHomeInspectionOutcome> => {
        const outcome = await runPersonalHomeTask('relay.runtime.personal_home.inspect.v1', {}, false);
        if (outcome.status !== 'completed') return outcome;
        const data = outcome.result.data as Record<string, unknown> | undefined;
        const identity = data?.identity && typeof data.identity === 'object' ? data.identity as Record<string, unknown> : {};
        const masterSecret = data?.masterSecret && typeof data.masterSecret === 'object' ? data.masterSecret as Record<string, unknown> : {};
        const storage = data?.storage && typeof data.storage === 'object' ? data.storage as Record<string, unknown> : {};
        const layout = data?.layout && typeof data.layout === 'object' ? data.layout as Record<string, unknown> : {};
        const restoreRecoveryValue = data?.restoreRecovery && typeof data.restoreRecovery === 'object'
            ? data.restoreRecovery as Record<string, unknown> : {};
        const relocationRecovery = readPersonalHomeRelocationRecovery(data?.relocationRecovery);
        const restoreRecoveryStatus = restoreRecoveryValue.status === 'rollback_available'
            || restoreRecoveryValue.status === 'finalization_available'
            || restoreRecoveryValue.status === 'ambiguous'
            ? restoreRecoveryValue.status : 'none';
        const latestBackupValue = storage.latestBackup && typeof storage.latestBackup === 'object'
            ? storage.latestBackup as Record<string, unknown>
            : null;
        const latestBackup = latestBackupValue
            && typeof latestBackupValue.path === 'string'
            && typeof latestBackupValue.createdAt === 'string'
            && typeof latestBackupValue.archiveBytes === 'number'
            && Number.isFinite(latestBackupValue.archiveBytes)
            && latestBackupValue.archiveBytes >= 0
            ? {
                path: latestBackupValue.path,
                createdAt: latestBackupValue.createdAt,
                archiveBytes: latestBackupValue.archiveBytes,
            }
            : null;
        const facts: PersonalHomeInspection = {
            homeServerIdentityId: typeof identity.homeServerIdentityId === 'string' ? identity.homeServerIdentityId : null,
            schemaVersion: typeof identity.schemaVersion === 'string' ? identity.schemaVersion : null,
            running: data?.running === true,
            masterSecretPresent: masterSecret.present === true,
            databasePresent: storage.databasePresent === true,
            databaseBytes: typeof storage.databaseBytes === 'number' ? storage.databaseBytes : 0,
            backupsCount: typeof storage.backupsCount === 'number' ? storage.backupsCount : 0,
            // Older Personal Home task results predate explicit inventory completeness and their
            // count was exact, so absence retains that released behavior.
            backupsCountComplete: storage.backupsCountComplete !== false,
            latestBackup,
            layoutPaths: {
                dataDir: typeof layout.dataDir === 'string' ? layout.dataDir : '',
                configDir: typeof layout.configDir === 'string' ? layout.configDir : '',
                logsDir: typeof layout.logsDir === 'string' ? layout.logsDir : '',
                backupsDir: typeof layout.backupsDir === 'string' ? layout.backupsDir : '',
            },
            ownedErasePaths: Array.isArray(storage.ownedErasePaths) ? storage.ownedErasePaths.filter((value): value is string => typeof value === 'string') : [],
            estimatedOwnedBytes: typeof storage.estimatedOwnedBytes === 'number' ? storage.estimatedOwnedBytes : null,
            estimatedOwnedBytesComplete: storage.estimatedOwnedBytesComplete !== false,
            estimatedOwnedBytesReason: typeof storage.estimatedOwnedBytesReason === 'string' ? storage.estimatedOwnedBytesReason : null,
            destinationEmpty: typeof storage.destinationEmpty === 'boolean'
                ? storage.destinationEmpty
                : null,
            restoreRecovery: {
                status: restoreRecoveryStatus,
                affectedTargets: Array.isArray(restoreRecoveryValue.affectedTargets)
                    ? restoreRecoveryValue.affectedTargets.filter((value): value is string => typeof value === 'string') : [],
            },
            relocationRecovery,
        };
        inspectionRef.current = facts;
        setInspection(facts);
        return { status: 'inspected', inspection: facts };
    }, [runPersonalHomeTask]);

    const refreshAfterMutation = React.useCallback(() => {
        void refreshStatus().catch(() => {});
        void refreshInspection().catch(() => {});
    }, [refreshInspection, refreshStatus]);

    return {
        activeTaskSnapshot,
        /**
         * Makes an Account the first owner of this computer's ownerless Personal Home, through
         * the deployment-local claim the hosting desktop runs (plan §3.5, decision A(a)).
         */
        claimOwner: React.useCallback(async (accountId: string): Promise<PersonalHomeTaskOutcome> => (
            await runPersonalHomeTask('relay.runtime.personal_home.claim_owner.v1', {
                personalHomeOperation: { accountId },
            }, false)
        ), [runPersonalHomeTask]),
        runTask: React.useCallback(async (kind: RelayRuntimeActionKind | PersonalHomeTaskKind | 'relay.runtime.status.v1', taskOptions: LocalRelayRuntimeTaskOptions = {}) => {
            const started = kind === 'relay.runtime.status.v1'
                ? await startTask(kind, taskOptions)
                : await runAction(kind, taskOptions);
            return started.status === 'started' ? started.taskId : null;
        }, [runAction, startTask]),
        runTaskAndWait,
        backupPersonalHome: React.useCallback(async (input: Readonly<{
            outputPath?: string;
            /** A composed caller may own the next fresh read while it immediately
             * continues into another Home operation under the fail-fast lease. */
            refreshAfterSuccess?: boolean;
        }> = {}) => {
            const outcome = await runPersonalHomeTask('relay.runtime.personal_home.backup.v1', {
                personalHomeOperation: {
                    ...(input.outputPath?.trim() ? { outputPath: input.outputPath.trim() } : {}),
                },
            });
            if (outcome.status !== 'completed') return null;
            const backup = readPersonalHomeBackupFacts(outcome.result.data);
            if (!backup) return null;
            setLastOperation({ operation: 'backup', backup });
            if (input.refreshAfterSuccess !== false) refreshAfterMutation();
            return backup;
        }, [refreshAfterMutation, runPersonalHomeTask]),
        verifyPersonalHomeBackup: React.useCallback(async (input: Readonly<{ archivePath: string }>) => {
            const archivePath = input.archivePath.trim();
            if (!archivePath) return null;
            const outcome = await runPersonalHomeTask('relay.runtime.personal_home.verify_backup.v1', { personalHomeOperation: { archivePath } });
            if (outcome.status !== 'completed') {
                setLastVerification(null);
                return null;
            }
            const data = outcome.result.data as Record<string, unknown> | undefined;
            const manifest = data?.manifest && typeof data.manifest === 'object' ? data.manifest as Record<string, unknown> : {};
            const verification = {
                archivePath,
                identityMatchesCurrentHome: typeof data?.identityMatchesCurrentHome === 'string' ? data.identityMatchesCurrentHome : null,
                homeServerIdentityId: typeof manifest.homeServerIdentityId === 'string' ? manifest.homeServerIdentityId : null,
                format: typeof manifest.format === 'string' ? manifest.format : null,
                version: typeof manifest.version === 'number' && Number.isSafeInteger(manifest.version) ? manifest.version : null,
                createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
                archiveBytes: typeof data?.archiveBytes === 'number' && Number.isSafeInteger(data.archiveBytes) && data.archiveBytes >= 0
                    ? data.archiveBytes
                    : null,
            };
            setLastVerification(verification);
            return verification;
        }, [runPersonalHomeTask]),
        restorePersonalHomeBackup: React.useCallback(async (input: Readonly<{ archivePath: string; overwriteConfirmed: boolean; verification: PersonalHomeVerification }>) => {
            const archivePath = input.archivePath.trim();
            const destinationEmpty = inspectionRef.current?.destinationEmpty;
            if (input.verification.archivePath !== archivePath
                || !input.verification.homeServerIdentityId
                || destinationEmpty == null
                || (!destinationEmpty && !input.overwriteConfirmed)) return null;
            const outcome = await runPersonalHomeTask('relay.runtime.personal_home.restore.v1', { personalHomeOperation: {
                archivePath,
                expectedHomeServerIdentityId: input.verification.homeServerIdentityId,
                ...(input.overwriteConfirmed ? { confirmOverwrite: true } : {}),
            } });
            if (outcome.status !== 'completed') return null;
            const data = outcome.result.data as Record<string, unknown> | undefined;
            const recoveryArchiveFacts = readPersonalHomeBackupFacts(data?.recoveryArchive);
            const restore = {
                outcome: typeof data?.outcome === 'string' ? data.outcome : 'restored',
                recoveryArchive: recoveryArchiveFacts ? { ...recoveryArchiveFacts, verified: true as const } : null,
                error: typeof data?.error === 'string' ? data.error : null,
            };
            setLastOperation({ operation: 'restore', restore });
            refreshAfterMutation();
            return restore;
        }, [refreshAfterMutation, runPersonalHomeTask]),
        recoverPersonalHomeRestore: React.useCallback(async () => {
            if (inspection?.restoreRecovery.status !== 'rollback_available') return null;
            const outcome = await runPersonalHomeTask('relay.runtime.personal_home.restore.v1', { personalHomeOperation: { action: 'recover' } });
            if (outcome.status !== 'completed') return null;
            const data = outcome.result.data as Record<string, unknown> | undefined;
            const restore = {
                outcome: typeof data?.outcome === 'string' ? data.outcome : 'rolled_back',
                recoveryArchive: null,
                error: typeof data?.error === 'string' ? data.error : null,
            };
            setLastOperation({ operation: 'restore', restore });
            refreshAfterMutation();
            return restore;
        }, [inspection?.restoreRecovery.status, refreshAfterMutation, runPersonalHomeTask]),
        erasePersonalHomeData: React.useCallback(async (promptContinuation?: SystemTaskPromptContinuation) => {
            let erasedIdentity = inspectionRef.current?.homeServerIdentityId ?? null;
            // R15 c: the Home is going away. Once the person confirmed the erase — and before the task
            // destroys any data — this computer stops serving it through the same disconnect as
            // removing a Home; when that must not go ahead, the erase is answered "not confirmed".
            const disconnectingContinuation = promptContinuation
                ? withPersonalHomeEraseDisconnect(runner, promptContinuation, identity => { erasedIdentity = identity ?? erasedIdentity; })
                : undefined;
            const outcome = await runPersonalHomeTask(
                'relay.runtime.personal_home.erase.v1',
                {},
                true,
                disconnectingContinuation,
            );
            if (outcome.status !== 'completed') return null;
            const erase = await completePersonalHomeErase(outcome.result, erasedIdentity);
            setLastOperation({ operation: 'erase', erase });
            refreshAfterMutation();
            return erase;
        }, [refreshAfterMutation, runPersonalHomeTask, runner]),
        startExternalOperation: React.useCallback(async (
            spec: SystemTaskSpec,
            options: Readonly<{ promptContinuation?: SystemTaskPromptContinuation;
                startSpec?: (spec: SystemTaskSpec) => Promise<string> }> = {},
        ): Promise<string | null> => {
            if (isUnavailable) return null;
            try {
                const taskId = await (options.startSpec ? options.startSpec(spec) : runner.start(spec));
                if (options.promptContinuation) runner.registerPromptContinuation?.(taskId, options.promptContinuation);
                setBridgeUnavailable(false);
                setLastErrorMessage(null);
                handledActionTaskIdRef.current = null;
                setActionTaskId(taskId);
                setOperationTaskId(taskId);
                setActiveOperationSpec({ ...spec, params: redactSensitiveSystemTaskJsonValue(spec.params) });
                return taskId;
            } catch (error) {
                const message = readSystemTaskStartErrorMessage(error);
                const unavailable = isSystemTaskBridgeUnavailableError(error);
                setBridgeUnavailable(unavailable);
                setLastErrorMessage(unavailable
                    ? t('settings.systemTaskBridgeUnavailable')
                    : (message ?? t('settings.systemTaskStartFailed')));
                return null;
            }
        }, [isUnavailable, runner]),
        inspection,
        lastOperation,
        lastVerification,
        operationSnapshot,
        activeOperationSpec,
        refreshInspection,
        dismissOperationResult: React.useCallback(() => {
            setOperationTaskId(null);
            setActiveOperationSpec(null);
            setLastOperation(null);
        }, []),
        cancelTask: React.useCallback(async (taskId: string) => {
            await runner.cancel(taskId);
        }, [runner]),
        respondToTaskPrompt: React.useCallback(async (taskId: string, answer: unknown) => {
            await runner.respond(taskId, answer);
        }, [runner]),
        installOrUpdate: React.useCallback(async () => {
            await runAction('relay.runtime.installOrUpdate.v1');
        }, [runAction]),
        isBusy,
        isUnavailable,
        lastErrorMessage,
        refreshStatus,
        readStatus,
        startRelay: React.useCallback(async () => {
            await runAction('relay.runtime.start.v1');
        }, [runAction]),
        restartRelay: React.useCallback(async () => {
            await runAction('relay.runtime.restart.v1');
        }, [runAction]),
        status: lastStatus,
        stopRelay: React.useCallback(async () => {
            await runAction('relay.runtime.stop.v1');
        }, [runAction]),
    };
}
