import * as React from 'react';

import { getDefaultSystemTaskRunner, useSystemTaskSnapshot } from '@/components/systemTasks';
import { usePrimaryMachineFromActiveSelection } from '@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection';
import { readCachedMachineDoctorSnapshot } from '@/components/settings/systemStatus/cache/machineDoctorSnapshotCache';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { useAuth } from '@/auth/context/AuthContext';
import { Modal } from '@/modal';
import { t } from '@/text';
import { classifyRelayDrift, createRelayUrlComparableKeySafe, resolveKnownRelayEquivalentUrl } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import type { RelayDriftBanner } from './relayDriftTypes';

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
    const auth = useAuth();
    const primaryMachineId = usePrimaryMachineFromActiveSelection();
    const activeServerSnapshot = getActiveServerSnapshot();
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const [repairTaskId, setRepairTaskId] = React.useState<string | null>(null);
    const [isRepairStarting, setIsRepairStarting] = React.useState(false);
    const repairTaskSnapshot = useSystemTaskSnapshot(runner, repairTaskId);
    const isRepairUnavailable = runner.mode === 'unavailable';

    const cachedDoctorSnapshot = React.useMemo(() => {
        if (!primaryMachineId || !activeServerSnapshot.serverId) {
            return null;
        }
        return readCachedMachineDoctorSnapshot({
            serverId: activeServerSnapshot.serverId,
            machineId: primaryMachineId,
        });
    }, [activeServerSnapshot.serverId, primaryMachineId]);

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
    const handleStartRepair = React.useCallback(async () => {
        if (isRepairUnavailable || isRepairStarting || (repairTaskSnapshot != null && repairTaskSnapshot.result == null)) {
            return;
        }

        setIsRepairStarting(true);
        try {
            const taskId = await runner.start(buildRelayDriftRepairSystemTaskSpec({
                activeRelayUrl: activeServerSnapshot.serverUrl,
                activeWebappUrl,
                activeLocalRelayUrl,
            }));
            setRepairTaskId(taskId);
        } finally {
            setIsRepairStarting(false);
        }
    }, [
        activeServerSnapshot.serverUrl,
        activeLocalRelayUrl,
        activeWebappUrl,
        isRepairUnavailable,
        isRepairStarting,
        repairTaskSnapshot,
        runner,
    ]);

    const handleCancelRepair = React.useCallback(() => {
        if (!repairTaskId || !repairTaskSnapshot || repairTaskSnapshot.result) {
            return;
        }
        void runner.cancel(repairTaskId);
    }, [repairTaskId, repairTaskSnapshot, runner]);

    const switchToServerUrl = React.useCallback(async (serverUrl: string) => {
        const normalized = String(serverUrl ?? '').trim();
        if (!normalized) {
            return;
        }
        try {
            upsertAndActivateServer({ serverUrl: normalized, source: 'url', scope: 'device' });
            await switchConnectionToActiveServer();
            await auth.refreshFromActiveServer();
        } catch (error) {
            const message = error instanceof Error ? error.message.trim() : '';
            Modal.alert(t('common.error'), message || t('server.failedToConnectToServer'));
        }
    }, [auth]);

    return React.useMemo(() => {
        const daemonSnapshot = cachedDoctorSnapshot?.snapshot.daemonStatus;
        const daemonServer = daemonSnapshot?.server;
        const daemonAuth = daemonSnapshot?.auth;
        const daemonService = daemonSnapshot?.service;
        const classification = classifyRelayDrift({
            activeRelayUrl: activeServerSnapshot.serverUrl,
            activeLocalRelayUrl,
            daemonRelayUrl: daemonServer?.serverUrl ?? cachedDoctorSnapshot?.snapshot.server.serverUrl ?? null,
            daemonAlternateRelayUrls: [
                daemonServer?.publicServerUrl ?? cachedDoctorSnapshot?.snapshot.server.publicServerUrl ?? null,
            ],
            daemonAccountId: daemonAuth?.accountId ?? cachedDoctorSnapshot?.snapshot.accountId ?? null,
            daemonNeedsAuth: daemonAuth?.needsAuth,
            daemonServiceInstalled: daemonService?.installed,
            daemonRunning: daemonService?.running,
        });

        if (classification.status === 'aligned' || classification.repairAction == null) {
            return null;
        }

        const daemonRelayUrl = daemonServer?.serverUrl ?? cachedDoctorSnapshot?.snapshot.server.serverUrl ?? null;
        const activeRelayLabel = toServerUrlDisplay(activeServerSnapshot.serverUrl);
        const daemonRelayLabel = daemonRelayUrl ? toServerUrlDisplay(daemonRelayUrl) : null;

        const description = classification.status === 'daemon_url_mismatch'
            ? t('server.relayDrift.bannerDifferentRelayDescription', {
                activeRelayUrl: activeRelayLabel,
                daemonRelayUrl: daemonRelayLabel ?? t('server.relayDrift.statusUnknown'),
            })
            : classification.status === 'daemon_not_installed'
                ? t('server.relayDrift.bannerNotInstalledDescription', { activeRelayUrl: activeRelayLabel })
                : classification.status === 'daemon_not_running'
                    ? t('server.relayDrift.bannerNotRunningDescription', { activeRelayUrl: activeRelayLabel })
            : classification.status === 'daemon_needs_auth'
                ? t('server.relayDrift.bannerNeedsAuthDescription', { activeRelayUrl: activeRelayLabel })
                : t('server.relayDrift.bannerNotConfiguredDescription', { activeRelayUrl: activeRelayLabel });

        return {
            kind: 'warning',
            title: classification.status === 'daemon_url_mismatch'
                ? t('server.relayDrift.bannerDifferentRelayTitle')
                : classification.status === 'daemon_not_installed'
                    ? t('server.relayDrift.bannerNotInstalledTitle')
                    : classification.status === 'daemon_not_running'
                        ? t('server.relayDrift.bannerNotRunningTitle')
                : classification.status === 'daemon_needs_auth'
                    ? t('server.relayDrift.bannerNeedsAuthTitle')
                    : t('server.relayDrift.bannerNotConfiguredTitle'),
            description,
            actionLabel: classification.status === 'daemon_needs_auth'
                ? t('common.authenticate')
                : t('server.relayDrift.repairAction'),
            ...(isRepairUnavailable
                ? {
                    actionDisabled: true,
                    actionHint: t('settings.systemTaskBridgeUnavailable'),
                }
                : {}),
            onPress: handleStartRepair,
            ...(classification.status === 'daemon_url_mismatch' && daemonRelayUrl
                ? {
                    secondaryActionLabel: t('server.switchToServer'),
                    onSecondaryPress: () => switchToServerUrl(daemonRelayUrl),
                }
                : {}),
            isRepairStarting,
            repairTaskSnapshot,
            onCancelRepair: handleCancelRepair,
        } satisfies RelayDriftBanner;
    }, [
        activeServerSnapshot.serverUrl,
        activeLocalRelayUrl,
        cachedDoctorSnapshot,
        handleCancelRepair,
        handleStartRepair,
        isRepairUnavailable,
        isRepairStarting,
        repairTaskSnapshot,
        switchToServerUrl,
    ]);
}
