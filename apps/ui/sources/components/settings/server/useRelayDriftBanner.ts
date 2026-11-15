import * as React from 'react';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import { readCachedMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { createRelayUrlComparableKeySafe, resolveKnownRelayEquivalentUrl } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { resolveThisComputerConnection, type ThisComputerDaemonFacts } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import type { RelayDriftBanner } from './relayDriftTypes';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useAppAccountIdentity } from '@/components/settings/machines/localControl/useThisComputerConnection';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { presentThisComputerConnection } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';

/**
 * Facts from the desktop's own live read of THIS computer's daemon.
 *
 * R10: a banner may only speak about a daemon the app knows something about. The cached doctor
 * snapshot is written only when someone opens Diagnosis (`machineDoctorSnapshotCache`), while
 * `useLocalDaemonControl` refreshes the local status on mount, so on a desktop the live local read
 * is both the fresher fact and usually the only one. It describes this computer whether or not
 * this computer is one of the signed-in account's machines: a daemon signed in to another account
 * (or another Home) is exactly the case no machine list can name (S11).
 *
 * `null` when this computer has no daemon at all: nothing installed and nothing running means
 * nothing that could have drifted, and the relay recorded in a config file is a default, not
 * knowledge of a daemon. Acquiring the first daemon belongs to the setup path.
 */
function daemonFactsFromLocalStatus(
    status: ReturnType<typeof useLocalDaemonControl>['status'],
): ThisComputerDaemonFacts | null {
    if (!status || !status.machineId) {
        return null;
    }
    if (!status.serviceInstalled && !status.daemonRunning) {
        return null;
    }
    return status;
}

function daemonFactsFromDoctorSnapshot(
    cachedDoctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>,
): ThisComputerDaemonFacts | null {
    if (!cachedDoctorSnapshot) {
        return null;
    }
    const daemonSnapshot = cachedDoctorSnapshot.snapshot.daemonStatus;
    const doctorBackgroundService = cachedDoctorSnapshot.snapshot.serviceHealth?.backgroundService;
    return {
        daemonServerUrl: daemonSnapshot?.server?.serverUrl ?? cachedDoctorSnapshot.snapshot.server.serverUrl ?? null,
        daemonAlternateRelayUrls: [
            daemonSnapshot?.server?.publicServerUrl ?? cachedDoctorSnapshot.snapshot.server.publicServerUrl ?? null,
        ],
        daemonAccountId: daemonSnapshot?.auth?.accountId ?? cachedDoctorSnapshot.snapshot.accountId ?? null,
        needsAuth: daemonSnapshot?.auth?.needsAuth,
        serviceInstalled: daemonSnapshot?.service?.installed ?? doctorBackgroundService?.installed,
        daemonRunning: daemonSnapshot?.service?.running ?? doctorBackgroundService?.running,
    };
}

function readAppSameOriginRelayUrl(): string | null {
    const currentOrigin = typeof window !== 'undefined'
        ? window.location?.origin
        : (globalThis as typeof globalThis & { location?: { origin?: string } }).location?.origin;
    const normalizedOrigin = typeof currentOrigin === 'string' ? currentOrigin.trim() : '';
    return normalizedOrigin || null;
}

function resolveDoctorLocalRelayCandidate(params: Readonly<{
    activeRelayUrl: string;
    doctorSnapshot: ReturnType<typeof readCachedMachineDoctorSnapshot>;
}>): string | null {
    const doctorServer = params.doctorSnapshot?.snapshot.server;
    if (!doctorServer) {
        return null;
    }

    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    if (!activeRelayKey) {
        return null;
    }
    const doctorPublicRelayKey = createRelayUrlComparableKeySafe(doctorServer.publicServerUrl);
    const doctorServerUrl = typeof doctorServer.serverUrl === 'string' ? doctorServer.serverUrl.trim() : '';
    const knownPair = doctorPublicRelayKey
        ? resolveKnownRelayEquivalentUrl({
            activeRelayUrl: params.activeRelayUrl,
            daemonRelayUrl: doctorServerUrl,
            daemonAlternateRelayUrls: [doctorServer.publicServerUrl],
        })
        : null;
    if (knownPair) {
        return knownPair;
    }

    const appSameOriginRelayKey = createRelayUrlComparableKeySafe(readAppSameOriginRelayUrl());
    const candidates = [doctorServer.serverUrl, doctorServer.webappUrl];
    for (const candidate of candidates) {
        const normalizedCandidate = typeof candidate === 'string' ? candidate.trim() : '';
        if (!normalizedCandidate) continue;
        const candidateKey = createRelayUrlComparableKeySafe(normalizedCandidate);
        if (!candidateKey || candidateKey === activeRelayKey) continue;
        if (!doctorPublicRelayKey && appSameOriginRelayKey && appSameOriginRelayKey === candidateKey) {
            return normalizedCandidate;
        }
    }

    return null;
}

export function useRelayDriftBanner(): RelayDriftBanner | null {
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const localDaemonControl = useLocalDaemonControl({ runner });
    return useRelayDriftBannerFromLocalControl(localDaemonControl, runner);
}

/** A surface that already owns local status consumes it here without starting another read. */
export function useRelayDriftBannerFromLocalControl(
    localDaemonControl: ReturnType<typeof useLocalDaemonControl>,
    runner: SystemTaskRunner,
): RelayDriftBanner | null {
    const activeServerSnapshot = getActiveServerSnapshot();
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.relayDrift, { rows: 'selected' },
    );
    const resolveRelayExecutionTarget = React.useCallback(() => {
        const expectedTarget = administrationTargetSelection.selectedTarget;
        const resolved = administrationTargetSelection.resolveExecutionTarget();
        if (
            expectedTarget === null
            || resolved === null
            || !machineAdministrationTargetsEqual(expectedTarget, resolved.target)
            || !areServerProfileIdentifiersEquivalent(resolved.serverId, activeServerSnapshot.serverId)
        ) {
            return null;
        }
        return resolved;
    }, [activeServerSnapshot.serverId, administrationTargetSelection]);
    const executionTarget = resolveRelayExecutionTarget();
    const [repairTaskId, setRepairTaskId] = React.useState<string | null>(null);
    const [isRepairStarting, setIsRepairStarting] = React.useState(false);
    const repairTaskSnapshot = useSystemTaskSnapshot(runner, repairTaskId);
    const appAccount = useAppAccountIdentity();
    const localDaemonStatus = localDaemonControl.status;
    // The desktop's own read describes this computer and wins; the doctor cache answers only for an
    // administered machine the desktop cannot read itself. The repair always runs on this computer,
    // so it needs the local bridge, and — on the doctor path — that target to be this computer.
    const localDaemonFacts = React.useMemo(() => daemonFactsFromLocalStatus(localDaemonStatus), [localDaemonStatus]);
    const isRepairUnavailable = runner.mode === 'unavailable'
        || localDaemonControl.isUnavailable
        || (localDaemonFacts === null
            && (executionTarget === null || localDaemonStatus?.machineId !== executionTarget.machine.id));

    const cachedDoctorSnapshot = React.useMemo(() => {
        if (!executionTarget) {
            return null;
        }
        return readCachedMachineDoctorSnapshot({
            serverId: executionTarget.serverId,
            machineId: executionTarget.machine.id,
        });
    }, [executionTarget]);

    const activeWebappUrl = resolveWebappUrlFromServerUrl(activeServerSnapshot.serverUrl);
    const activeLocalRelayUrl = React.useMemo(() => {
        if (typeof activeServerSnapshot.activeLocalRelayUrl === 'string' && activeServerSnapshot.activeLocalRelayUrl.trim().length > 0) {
            return activeServerSnapshot.activeLocalRelayUrl.trim();
        }

        const doctorLocalRelayUrl = resolveDoctorLocalRelayCandidate({
            activeRelayUrl: activeServerSnapshot.serverUrl,
            doctorSnapshot: cachedDoctorSnapshot,
        });
        if (doctorLocalRelayUrl) {
            return doctorLocalRelayUrl;
        }

        const appSameOriginRelayUrl = readAppSameOriginRelayUrl();
        if (!appSameOriginRelayUrl) {
            return null;
        }

        if (createRelayUrlComparableKeySafe(appSameOriginRelayUrl) === createRelayUrlComparableKeySafe(activeServerSnapshot.serverUrl)) {
            return null;
        }

        return appSameOriginRelayUrl;
    }, [activeServerSnapshot.activeLocalRelayUrl, activeServerSnapshot.serverUrl, cachedDoctorSnapshot]);
    // R10: no facts from either source, no banner. Only this computer's own read is comparable with
    // the signed-in account; the doctor cache describes another machine and never names one.
    const connection = React.useMemo(() => {
        const daemonFacts = localDaemonFacts
            ?? (executionTarget ? daemonFactsFromDoctorSnapshot(cachedDoctorSnapshot) : null);
        return resolveThisComputerConnection({
            daemon: daemonFacts,
            activeRelayUrl: activeServerSnapshot.serverUrl,
            activeLocalRelayUrl,
            appAccountId: localDaemonFacts ? appAccount.accountId : null,
            appAccountLabel: appAccount.accountLabel,
        });
    }, [
        activeLocalRelayUrl,
        activeServerSnapshot.serverUrl,
        appAccount.accountId,
        appAccount.accountLabel,
        cachedDoctorSnapshot,
        executionTarget,
        localDaemonFacts,
    ]);

    const repairBackgroundService = localDaemonControl.repairBackgroundService;
    const canonicalRepairSnapshot = localDaemonControl.activeTaskSnapshot;
    const visibleRepairTaskSnapshot = canonicalRepairSnapshot ?? repairTaskSnapshot;
    const handleStartRepair = React.useCallback(async () => {
        if (isRepairUnavailable || isRepairStarting || (visibleRepairTaskSnapshot != null && visibleRepairTaskSnapshot.result == null)) {
            return;
        }
        if (!localDaemonFacts) {
            const currentTarget = resolveRelayExecutionTarget();
            if (
                !currentTarget
                || localDaemonControl.status?.machineId !== currentTarget.machine.id
            ) return;
        }
        setIsRepairStarting(true);
        try {
            await repairBackgroundService();
        } finally {
            setIsRepairStarting(false);
        }
    }, [
        isRepairUnavailable,
        isRepairStarting,
        localDaemonFacts,
        visibleRepairTaskSnapshot,
        resolveRelayExecutionTarget,
        repairBackgroundService,
        localDaemonControl.status?.machineId,
    ]);

    const startLocalBackgroundServiceTask = React.useCallback(async (
        kind: 'daemon.service.start.v1' | 'daemon.service.restart.v1',
    ) => {
        if (isRepairUnavailable || isRepairStarting || (repairTaskSnapshot != null && repairTaskSnapshot.result == null)) {
            return;
        }
        if (!localDaemonFacts) {
            const currentTarget = resolveRelayExecutionTarget();
            if (
                !currentTarget
                || localDaemonControl.status?.machineId !== currentTarget.machine.id
            ) return;
        }

        setIsRepairStarting(true);
        try {
            const taskId = await runner.start(buildLocalDaemonServiceSystemTaskSpec(kind));
            setRepairTaskId(taskId);
        } finally {
            setIsRepairStarting(false);
        }
    }, [isRepairStarting, isRepairUnavailable, localDaemonControl.status?.machineId, localDaemonFacts, repairTaskSnapshot, resolveRelayExecutionTarget, runner]);

    const handleCancelRepair = React.useCallback(() => {
        if (canonicalRepairSnapshot && canonicalRepairSnapshot.result == null) {
            localDaemonControl.cancel();
            return;
        }
        if (repairTaskId && repairTaskSnapshot && repairTaskSnapshot.result == null) {
            void runner.cancel(repairTaskId);
        }
    }, [canonicalRepairSnapshot, localDaemonControl, repairTaskId, repairTaskSnapshot, runner]);

    return React.useMemo(() => {
        if (!connection) return null;
        const presentation = presentThisComputerConnection(connection);
        if (!presentation) return null;

        return {
            kind: 'warning',
            title: presentation.title,
            description: presentation.description,
            actionLabel: presentation.actionLabel,
            ...(isRepairUnavailable
                ? {
                    actionDisabled: true,
                    actionHint: t('settings.systemTaskBridgeUnavailable'),
                }
                : localDaemonControl.lastErrorMessage && !isRepairStarting && !visibleRepairTaskSnapshot
                    ? { actionHint: localDaemonControl.lastErrorMessage }
                : {}),
            onPress: connection.status === 'daemon_not_running'
                ? async () => {
                    await startLocalBackgroundServiceTask('daemon.service.restart.v1');
                }
                : handleStartRepair,
            isRepairStarting,
            repairTaskSnapshot: visibleRepairTaskSnapshot,
            onCancelRepair: handleCancelRepair,
        } satisfies RelayDriftBanner;
    }, [
        connection,
        handleCancelRepair,
        handleStartRepair,
        isRepairUnavailable,
        isRepairStarting,
        localDaemonControl.lastErrorMessage,
        visibleRepairTaskSnapshot,
        startLocalBackgroundServiceTask,
    ]);
}
