import * as React from 'react';
import type { SystemTaskResult } from '@happier-dev/protocol';

import { getSystemTasksRunner as getDefaultSystemTaskRunner } from '@/components/systemTasks/systemTasksRuntime';
import { useSystemTaskSnapshot } from '@/components/systemTasks/useSystemTaskSnapshot';
import { waitForSystemTaskResult } from '@/components/systemTasks/createSystemTaskRunner';
import type { SystemTaskRunState, SystemTaskRunner } from '@/components/systemTasks/types';
import { isSystemTaskBridgeUnavailableError, readSystemTaskStartErrorMessage } from '@/components/systemTasks/systemTaskStartError';
import { buildLocalMachineSetupSystemTaskSpec } from '@/components/systemTasks/buildLocalMachineSetupSystemTaskSpec';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { t } from '@/text';

import {
    buildLocalDaemonServiceSystemTaskSpec,
    type LocalDaemonServiceScope,
} from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import {
    adoptLocalComputerSetup,
    publishLocalDaemonStatus,
    readLocalDaemonSharedState,
    startLocalCliUpdate,
    startLocalComputerSetup,
    subscribeLocalDaemonSharedState,
    type LocalDaemonSharedState,
} from './localDaemonSharedState';
import { useThisComputerSetupTask } from '@/components/systemTasks/useThisComputerSetupTask';
import { matchesThisComputerSetupScope } from '@/components/systemTasks/thisComputerSetup/thisComputerSetupScope';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { useAppAccountIdentity } from './useThisComputerConnection';
import { readThisComputerServiceRows, type ThisComputerServiceRow } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';

export type LocalCliUpdateStatus = Readonly<{
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    /** The resolved CLI is the one this app installed and may update in place. */
    managed: boolean;
    /** Where a CLI the app did not install came from (its resolved path), when reported. */
    origin: string | null;
}>;

/**
 * R12: who manages this computer's `happier` command line, and the CLI that is not the managed one
 * (the kept CLI, or an old copy still on the search path). Absent from daemons that predate R12.
 */
export type LocalCliChoiceFacts = Readonly<{
    mode: 'managed' | 'own' | null;
    otherCli: Readonly<{
        command: string;
        origin: 'npm' | 'brew' | 'unknown';
        /** Shown and copyable, never run. */
        removalCommand: string | null;
        updateCommand: string | null;
    }> | null;
}>;

export type LocalDaemonStatusData = Readonly<{
    serviceInstalled: boolean;
    daemonRunning: boolean;
    needsAuth: boolean;
    machineId: string | null;
    daemonServerUrl?: string | null;
    daemonComparableKey?: string | null;
    daemonAccountId?: string | null;
    /** Readable label of the account the relay validated for this daemon (K4), when reported. */
    daemonAccountLabel?: string | null;
    daemonMachineRegistered?: boolean | null;
    /** The CLI's cached update check (K4); `null` when the CLI does not report one. */
    cliUpdate?: LocalCliUpdateStatus | null;
    /** R12's one-CLI answer; `null` when the daemon does not report it. */
    cliChoice?: LocalCliChoiceFacts | null;
    /** R16 — every background service on this computer, one per Home; `null` when not reported. */
    serviceRows?: readonly ThisComputerServiceRow[] | null;
    /** `false` when some service could not be read (it is still listed, as needing attention). */
    serviceRowsComplete?: boolean | null;
    /**
     * The one login-start setting (A13-02, N-16): the common mode of every desktop-managed service
     * on this computer, whatever Home the read is scoped to. `null` = unknown or mixed, never a mode.
     */
    serviceAutostart?: DesktopServiceAutostartMode | null;
    /** Presence in the full managed inventory, before serving-row selection; `null` is unproved. */
    managedServiceInstalled?: boolean | null;
    /**
     * How many desktop-managed services are running, from the full inventory (a default and a pin
     * can share one relay row); `null` when any managed service is unreadable.
     */
    runningManagedServiceCount?: number | null;
}>;

/** Whether this computer's background services start at login (`at-login`) or only on demand. */
export type DesktopServiceAutostartMode = 'at-login' | 'on-demand';

/**
 * A11-08 — the exact command that updates the command line the person kept ("Keep my own"), when
 * this computer knows where it came from; `null` otherwise (Happier's own CLI updates in place).
 */
export function readKeptCliUpdateCommand(status: LocalDaemonStatusData | null): string | null {
    return status?.cliChoice?.mode === 'own' ? status.cliChoice.otherCli?.updateCommand ?? null : null;
}

function readAutostartMode(value: unknown): DesktopServiceAutostartMode | null {
    return value === 'at-login' || value === 'on-demand' ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCliUpdateStatus(value: unknown): LocalCliUpdateStatus | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const currentVersion = readNonEmptyString(record.currentVersion);
    if (!currentVersion) return null;
    return {
        currentVersion,
        latestVersion: readNonEmptyString(record.latestVersion),
        updateAvailable: record.updateAvailable === true,
        managed: record.managed === true,
        origin: readNonEmptyString(record.origin),
    };
}

function readCliChoiceFacts(value: unknown): LocalCliChoiceFacts | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const mode = record.mode === 'managed' || record.mode === 'own' ? record.mode : null;
    const other = record.otherCli && typeof record.otherCli === 'object' ? record.otherCli as Record<string, unknown> : null;
    const command = readNonEmptyString(other?.command);
    return {
        mode,
        otherCli: other && command
            ? {
                command,
                origin: other.origin === 'npm' || other.origin === 'brew' ? other.origin : 'unknown',
                removalCommand: readNonEmptyString(other.removalCommand),
                updateCommand: readNonEmptyString(other.updateCommand),
            }
            : null,
    };
}

export function readLocalDaemonStatusData(result: SystemTaskResult | null): LocalDaemonStatusData | null {
    if (!result?.ok) {
        return null;
    }

    const data = result.data as Record<string, unknown> | undefined;
    if (!data) {
        return null;
    }

    return {
        serviceInstalled: data.serviceInstalled === true,
        daemonRunning: data.daemonRunning === true,
        needsAuth: data.needsAuth === true,
        machineId: typeof data.machineId === 'string' && data.machineId.trim().length > 0 ? data.machineId.trim() : null,
        daemonServerUrl: typeof data.daemonServerUrl === 'string' && data.daemonServerUrl.trim().length > 0 ? data.daemonServerUrl.trim() : null,
        daemonComparableKey: typeof data.daemonComparableKey === 'string' && data.daemonComparableKey.trim().length > 0 ? data.daemonComparableKey.trim() : null,
        daemonAccountId: typeof data.daemonAccountId === 'string' && data.daemonAccountId.trim().length > 0 ? data.daemonAccountId.trim() : null,
        daemonAccountLabel: readNonEmptyString(data.daemonAccountLabel),
        daemonMachineRegistered: typeof data.daemonMachineRegistered === 'boolean' ? data.daemonMachineRegistered : null,
        cliUpdate: readCliUpdateStatus(data.cliUpdate),
        cliChoice: readCliChoiceFacts(data.cliChoice),
        serviceRows: readThisComputerServiceRows(data.serviceRows),
        serviceRowsComplete: typeof data.serviceRowsComplete === 'boolean' ? data.serviceRowsComplete : null,
        serviceAutostart: readAutostartMode(data.serviceAutostart),
        managedServiceInstalled: typeof data.managedServiceInstalled === 'boolean' ? data.managedServiceInstalled : null,
        runningManagedServiceCount: typeof data.runningManagedServiceCount === 'number'
            && Number.isInteger(data.runningManagedServiceCount) && data.runningManagedServiceCount >= 0
            ? data.runningManagedServiceCount
            : null,
    };
}

/**
 * Reads this computer's status once and shares it with every surface describing this computer —
 * for a change made outside the app's own controls (the tray's native Start / Restart / Stop). A
 * read that fails leaves the last shared status in place.
 */
export async function refreshLocalDaemonStatus(runner: SystemTaskRunner): Promise<void> {
    if (runner.mode === 'unavailable') return;
    const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
    const status = readLocalDaemonStatusData(await waitForSystemTaskResult(runner, taskId));
    if (status) publishLocalDaemonStatus(runner, status);
}

function readErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) {
        return null;
    }
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || null;
}

export function useLocalDaemonControl(options: Readonly<{
    runner?: SystemTaskRunner;
}> = {}) {
    const runner = options.runner ?? getDefaultSystemTaskRunner();
    const activeServerSnapshot = useActiveServerSnapshot();
    // A11-06: repair and setup of the app's Home pair this computer for the app's own account.
    const { accountId: appAccountId } = useAppAccountIdentity();
    const setupApproval = React.useMemo(() => ({ expectedRelayUrl: activeServerSnapshot.serverUrl,
        ...(activeServerSnapshot.serverId ? { serverId: activeServerSnapshot.serverId } : {}),
        ...(appAccountId ? { expectedAccountId: appAccountId } : {}),
    }), [activeServerSnapshot.serverId, activeServerSnapshot.serverUrl, appAccountId]);
    const setupTask = useThisComputerSetupTask({ runner, authRequestApproval: setupApproval });
    const [bridgeUnavailable, setBridgeUnavailable] = React.useState(false);
    const isUnavailable = runner.mode === 'unavailable' || bridgeUnavailable;
    const [statusTaskId, setStatusTaskId] = React.useState<string | null>(null);
    const [startTaskId, setStartTaskId] = React.useState<string | null>(null);
    // One status and one CLI-update run for every surface describing this computer (S-10).
    const subscribeShared = React.useCallback((listener: () => void) => subscribeLocalDaemonSharedState(runner, listener), [runner]);
    const readShared = React.useCallback(() => readLocalDaemonSharedState<LocalDaemonStatusData>(runner), [runner]);
    const shared: LocalDaemonSharedState<LocalDaemonStatusData> = React.useSyncExternalStore(subscribeShared, readShared, readShared);
    const lastStatus = shared.status;
    const setLastStatus = React.useCallback((status: LocalDaemonStatusData) => publishLocalDaemonStatus(runner, status), [runner]);
    const [lastErrorMessage, setLastErrorMessage] = React.useState<string | null>(null);
    const autoRefreshRequestedRef = React.useRef(false);
    const handledStartResultTaskIdRef = React.useRef<string | null>(null);

    const statusSnapshot = useSystemTaskSnapshot(runner, statusTaskId);
    const startSnapshot = useSystemTaskSnapshot(runner, startTaskId);
    const setupIsScoped = shared.setup.scope?.serverUrl === activeServerSnapshot.serverUrl
        && shared.setup.scope?.serverId === (activeServerSnapshot.serverId ?? null)
        && shared.setup.scope?.accountId === (appAccountId ?? null);
    const setupTaskId = setupTask.activeTaskId ?? shared.setup.taskId;
    const retainedSetupSnapshot = useSystemTaskSnapshot(runner, setupTask.activeTaskId ? null : shared.setup.taskId);
    const setupSnapshot = matchesThisComputerSetupScope(runner.getTaskSpec?.(setupTaskId ?? '') ?? null, setupApproval)
        ? setupTask.activeTaskSnapshot ?? retainedSetupSnapshot : null;
    const commandLineSnapshot = runner.getTaskSpec?.(setupTaskId ?? '')?.kind === 'setup.thisComputer.v1' ? setupSnapshot : null;
    const repairSnapshot = commandLineSnapshot ? null : setupSnapshot;
    const cliUpdateSnapshot = useSystemTaskSnapshot(runner, shared.cliUpdate.taskId);

    React.useEffect(() => {
        const taskId = setupTask.activeTaskId;
        const spec = taskId ? runner.getTaskSpec?.(taskId) : null;
        if (taskId && spec) adoptLocalComputerSetup(runner, taskId, spec, setupApproval, readLocalDaemonStatusData);
    }, [runner, setupTask.activeTaskId, setupApproval]);

    const refreshStatus = React.useCallback(async () => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1'));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStatusTaskId(taskId);
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
    }, [isUnavailable, runner]);

    /**
     * Awaited authoritative status read: canonical parser, updates this hook's status state. The
     * default scope is the spec builder's one rule (the app's active server); the Personal Home
     * bootstrap names its own Home. Resolves `null` only when no read could run; a status task that
     * ran and FAILED rejects with its coded error, so a caller never mistakes it for "no daemon".
     */
    const readStatus = React.useCallback(async (
        scope: LocalDaemonServiceScope = {},
    ): Promise<LocalDaemonStatusData | null> => {
        if (isUnavailable) {
            return null;
        }
        let result: SystemTaskResult;
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1', scope));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStatusTaskId(taskId);
            result = await waitForSystemTaskResult(runner, taskId);
        } catch (error) {
            const message = readSystemTaskStartErrorMessage(error);
            const unavailable = isSystemTaskBridgeUnavailableError(error);
            setBridgeUnavailable(unavailable);
            setLastErrorMessage(unavailable
                ? t('settings.systemTaskBridgeUnavailable')
                : (message ?? t('settings.systemTaskStartFailed')));
            return null;
        }
        const nextStatus = readLocalDaemonStatusData(result);
        if (nextStatus) {
            setLastStatus(nextStatus);
            setLastErrorMessage(null);
            return nextStatus;
        }
        const message = readErrorMessage(result) ?? t('settings.systemTaskStartFailed');
        setLastErrorMessage(message);
        throw Object.assign(new Error(message), {
            code: !result.ok && typeof result.error?.code === 'string' ? result.error.code : 'daemon_status_failed',
        });
    }, [isUnavailable, runner, setLastStatus]);

    const runAction = React.useCallback(async (kind: 'daemon.service.start.v1') => {
        if (isUnavailable) {
            return null;
        }
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
            setStartTaskId(taskId);
            handledStartResultTaskIdRef.current = null;
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
    }, [isUnavailable, runner]);

    const startDaemonService = React.useCallback(async () => {
        await runAction('daemon.service.start.v1');
    }, [runAction]);

    /**
     * R17: one update of the managed CLI through the CLI's own acquisition owner (`cli.update.v1`),
     * shared by every surface that offers it; the result is re-read and published to all of them.
     */
    const updateCli = React.useCallback(async () => {
        if (isUnavailable) return;
        await startLocalCliUpdate(runner, readLocalDaemonStatusData);
    }, [isUnavailable, runner]);

    const repairBackgroundService = React.useCallback(async () => {
        if (isUnavailable || !activeServerSnapshot.serverUrl) {
            return null;
        }
        try {
            const taskId = await startLocalComputerSetup(runner, buildRelayDriftRepairSystemTaskSpec({
                activeRelayUrl: activeServerSnapshot.serverUrl,
                activeWebappUrl: resolveWebappUrlFromServerUrl(activeServerSnapshot.serverUrl),
                activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl ?? null,
                activeAccountId: appAccountId,
            }), { expectedRelayUrl: activeServerSnapshot.serverUrl,
                ...(activeServerSnapshot.serverId ? { serverId: activeServerSnapshot.serverId } : {}),
            }, readLocalDaemonStatusData);
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
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
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverId, activeServerSnapshot.serverUrl, appAccountId, isUnavailable, runner]);

    /**
     * R12 "Change who manages the command line": the ordinary setup run, asked to put the one-CLI
     * question again. The setup task owner answers its prompts (the question, service consent,
     * pairing); the answer converges the background service onto the chosen CLI.
     */
    const changeCommandLine = React.useCallback(async () => {
        if (isUnavailable || !activeServerSnapshot.serverUrl) {
            return null;
        }
        try {
            const taskId = await startLocalComputerSetup(runner, buildLocalMachineSetupSystemTaskSpec({
                activeRelayUrl: activeServerSnapshot.serverUrl,
                activeWebappUrl: resolveWebappUrlFromServerUrl(activeServerSnapshot.serverUrl),
                activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl ?? null,
                activeAccountId: appAccountId,
                installService: true,
                startService: true,
                verifyService: true,
                reconsiderCli: true,
            }), { expectedRelayUrl: activeServerSnapshot.serverUrl,
                ...(activeServerSnapshot.serverId ? { serverId: activeServerSnapshot.serverId } : {}),
            }, readLocalDaemonStatusData);
            setBridgeUnavailable(false);
            setLastErrorMessage(null);
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
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverId, activeServerSnapshot.serverUrl, appAccountId, isUnavailable, runner]);

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

    React.useEffect(() => {
        const nextStatus = readLocalDaemonStatusData(statusSnapshot?.result ?? null);
        if (nextStatus) {
            setLastStatus(nextStatus);
            setLastErrorMessage(null);
            return;
        }

        const errorMessage = readErrorMessage(statusSnapshot?.result ?? null);
        if (errorMessage) {
            setLastErrorMessage(errorMessage);
        }
    }, [setLastStatus, statusSnapshot]);

    React.useEffect(() => {
        if (!startSnapshot?.result || handledStartResultTaskIdRef.current === startSnapshot.taskId) {
            return;
        }

        handledStartResultTaskIdRef.current = startSnapshot.taskId;
        if (!startSnapshot.result.ok) {
            setLastErrorMessage(readErrorMessage(startSnapshot.result));
            return;
        }

        // The service start answers with a status; the re-read below confirms it.
        const inlineStatus = readLocalDaemonStatusData(startSnapshot.result);
        if (inlineStatus) {
            setLastStatus(inlineStatus);
            setLastErrorMessage(null);
        }

        void refreshStatus().catch(() => {});
    }, [refreshStatus, setLastStatus, startSnapshot]);


    const cliUpdateRunning = shared.cliUpdate.starting
        || shared.cliUpdate.rereading
        || (cliUpdateSnapshot != null && cliUpdateSnapshot.result == null);
    const activeTaskSnapshot = React.useMemo<SystemTaskRunState | null>(() => {
        const snapshot = repairSnapshot?.result ? null : repairSnapshot
            ?? (commandLineSnapshot?.result ? null : commandLineSnapshot)
            ?? (startSnapshot?.result ? null : startSnapshot)
            ?? (cliUpdateSnapshot?.result ? null : cliUpdateSnapshot);
        return snapshot ?? null;
    }, [cliUpdateSnapshot, commandLineSnapshot, repairSnapshot, startSnapshot]);

    const activeTaskTitle = React.useMemo(() => {
        if (repairSnapshot && repairSnapshot.result == null) {
            return t('machine.repairBackgroundServiceProgressTitle');
        }
        if (commandLineSnapshot && commandLineSnapshot.result == null) {
            return t('machine.thisComputer.cliChoice.change');
        }
        if (startSnapshot && startSnapshot.result == null) {
            return t('machine.daemon');
        }
        if (cliUpdateSnapshot && cliUpdateSnapshot.result == null) {
            return t('machine.thisComputer.cli.progressTitle');
        }
        return null;
    }, [cliUpdateSnapshot, commandLineSnapshot, repairSnapshot, startSnapshot]);

    const isBusy = runner.getActiveSetupTask() !== null || shared.setup.rereading
        || (activeTaskSnapshot != null && activeTaskSnapshot.result == null) || cliUpdateRunning;
    const canStart = !isUnavailable && !isBusy && lastStatus?.serviceInstalled === true && lastStatus.daemonRunning !== true && lastStatus.needsAuth !== true;
    const canRepair = !isUnavailable && !isBusy && Boolean(activeServerSnapshot.serverUrl);
    const canUpdateCli = !isUnavailable && !isBusy
        && lastStatus?.cliUpdate?.managed === true
        && lastStatus.cliUpdate.updateAvailable === true;
    const showInstallBackgroundService = runner.mode === 'tauri' && lastStatus?.serviceInstalled === false;
    const canInstall = runner.mode === 'tauri'
        && !isUnavailable
        && !isBusy
        && lastStatus?.serviceInstalled === false
        && Boolean(activeServerSnapshot.serverUrl);

    return {
        activeRelayUrl: activeServerSnapshot.serverUrl,
        activeTaskSnapshot,
        statusTaskSnapshot: statusSnapshot,
        activeTaskTitle,
        canInstall,
        canRepair,
        canStart,
        canUpdateCli,
        /** The shared CLI update is in flight (started here or on another surface). */
        cliUpdateRunning,
        /** Why the last shared CLI update did not finish, as one sentence (K5 codes). */
        cliUpdateErrorMessage: shared.cliUpdate.errorMessage,
        lastErrorMessage: setupIsScoped ? shared.setup.errorMessage ?? lastErrorMessage : lastErrorMessage,
        showInstallBackgroundService,
        readStatus,
        refreshStatus,
        /** R12: shown only when another command line exists beside the managed one. */
        canChangeCommandLine: canRepair && lastStatus?.cliChoice?.otherCli != null,
        changeCommandLine,
        installBackgroundService: repairBackgroundService,
        repairBackgroundService,
        startDaemonService,
        updateCli,
        status: lastStatus,
        isBusy,
        isUnavailable,
        cancel: React.useCallback(() => {
            const activeTaskId = repairSnapshot && repairSnapshot.result == null
                ? repairSnapshot.taskId
                : commandLineSnapshot && commandLineSnapshot.result == null
                    ? commandLineSnapshot.taskId
                    : startSnapshot && startSnapshot.result == null
                        ? startTaskId
                        : cliUpdateSnapshot && cliUpdateSnapshot.result == null
                            ? cliUpdateSnapshot.taskId
                            : null;
            if (!activeTaskId) {
                return;
            }
            void runner.cancel(activeTaskId);
        }, [cliUpdateSnapshot, commandLineSnapshot, repairSnapshot, runner, startSnapshot, startTaskId]),
    };
}
