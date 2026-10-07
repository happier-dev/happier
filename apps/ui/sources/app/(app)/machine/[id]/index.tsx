import React, { useState, useMemo, useCallback, useRef } from 'react';
import { View, RefreshControl, Platform, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from '@/components/appShell/workspace/destinationRoute';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Typography } from '@/constants/Typography';
import {
    storage,
    useMachine,
    useMachineListByServerId,
    useSessions,
    useSetting,
    useSettingMutable,
    useSettings,
} from '@/sync/domains/state/storage';
import { useActiveServerAccountScope, useSettingsVersion } from '@/sync/store/hooks';
import { seedNewSessionDraftV1 } from '@/components/sessions/new/newSessionDraftSeed';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { Machine, MachineMetadata, Session } from '@/sync/domains/state/storageTypes';
import {
    machineStopDaemon,
    machineStopSession,
    machineUpdateMetadata,
    machineExecutionRunsList,
    machineClearReplacementFromAccount,
    machineReplaceInAccount,
    machineRevokeFromAccount,
    machineRevokeWithProviderCleanup,
} from '@/sync/ops';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { Modal } from '@/modal';
import { buildMachineTerminalSettingsPatch, resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { formatOSPlatform, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { tryShowDaemonUnavailableAlertForRpcError, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { MachineAgentsSection } from '@/components/machines/agents/MachineAgentsSection';
import { AgentSignInPaneHost } from '@/components/machines/agents/AgentSignInPaneHost';
import { MachineTransferExposureSection } from '@/components/machines/MachineTransferExposureSection';
import { MachineDirectConnectionSection } from '@/components/settings/connections/DirectConnectionSettings';
import { MachineDoctorRuntimeInventorySection } from '@/components/machines/doctorSnapshot/MachineDoctorRuntimeInventorySection';
import {
    buildMachineDoctorSnapshotTargetKey,
    useMachineDoctorSnapshotCollection,
} from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshotCollection';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import {
    readMachineWindowsRemoteSessionLaunchMode,
    resolveEffectiveWindowsRemoteSessionLaunchMode,
} from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { Switch } from '@/components/ui/forms/Switch';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { resolveTmuxAvailable } from '@/capabilities/tmuxAvailability';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import {
    hasProviderMachineStateV1,
    readProviderSettingsFromAccountSettingsV1,
    type DaemonExecutionRunEntry,
} from '@happier-dev/protocol';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readExecutionRunSessionAssociation } from '@/components/sessions/runs/readExecutionRunSessionAssociation';
import { Text } from '@/components/ui/text/Text';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import {
    MachineReplacementPickerModal,
    type MachineReplacementPickerCandidate,
} from '@/components/machines/MachineReplacementPickerModal';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { filterUserFacingMachineDetailSessions } from '@/components/machines/machineDetailSessionQueries';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useHappierCollectionLayout } from '@happier-dev/plugin-ui/presentation';


const styles = StyleSheet.create((theme) => ({
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    identifier: {
        ...Typography.mono(),
        fontSize: 12.5,
        color: theme.colors.text.secondary,
    },
    leaveActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    footnote: {
        ...Typography.default('regular'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        marginTop: 10,
        marginHorizontal: 2,
    },
}));

function resolveMachineServerIdFromList(params: Readonly<{
    activeServerId: string;
    machineId: string | undefined;
    machineListByServerId: Readonly<Record<string, readonly Pick<Machine, 'id'>[] | null | undefined>>;
}>): string {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return '';

    const activeServerMachines = params.machineListByServerId[params.activeServerId];
    if (Array.isArray(activeServerMachines) && activeServerMachines.some((machine) => machine.id === machineId)) {
        return params.activeServerId;
    }

    for (const [serverId, machines] of Object.entries(params.machineListByServerId)) {
        if (!Array.isArray(machines)) continue;
        if (machines.some((machine) => machine.id === machineId)) {
            return serverId;
        }
    }

    return '';
}

function resolveMachineReplacementCandidateSubtitle(machine: Machine): string {
    const parts = [
        machine.metadata?.platform,
        machine.metadata?.homeDir,
        machine.id,
    ].filter((part): part is string => Boolean(part));
    return parts.join(' • ');
}

export default function MachineDetailScreen() {
    const { theme } = useUnistyles();
    const { id: machineId, serverId: serverIdParam } = useLocalSearchParams<{ id: string; serverId?: string }>();
    const router = useRouter();
    const shouldContinue = useMountedShouldContinue();
    const sessions = useSessions();
    const machine = useMachine(machineId!);
    const navigateToSession = useNavigateToSession();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isServerSwitching, setIsServerSwitching] = useState(false);
    const [isStoppingDaemon, setIsStoppingDaemon] = useState(false);
    const [isRenamingMachine, setIsRenamingMachine] = useState(false);
    const [isUpdatingWindowsConsoleMode, setIsUpdatingWindowsConsoleMode] = useState(false);
    const [openWindowsRemoteSessionLaunchModeMenu, setOpenWindowsRemoteSessionLaunchModeMenu] = useState(false);
    const [isRevokingMachine, setIsRevokingMachine] = useState(false);
    const [isProviderCleanupPending, setIsProviderCleanupPending] = useState(false);
    const [replacingMachineId, setReplacingMachineId] = useState<string | null>(null);
    const [isClearingReplacement, setIsClearingReplacement] = useState(false);
    const [isHydratingMachine, setIsHydratingMachine] = useState(() => Boolean(machineId) && !machine);
    const machineHydrationRequestedRef = useRef(false);
    const isOnline = !!machine && isMachineOnline(machine);
    const machineCanSpawn = useMemo(
        () => canAttemptMachineSpawn({ machine, selectedMachineId: machineId }),
        [machine, machineId],
    );
    const metadata = machine?.metadata;
    const isWindowsMachine = metadata?.platform === 'win32';
    const machineWindowsRemoteSessionLaunchMode = readMachineWindowsRemoteSessionLaunchMode(metadata);
    const windowsRemoteSessionLaunchModeOverrideEnabled =
        isWindowsMachine && machineWindowsRemoteSessionLaunchMode !== undefined;

    const windowsRemoteSessionLaunchModeDefault = useSetting('sessionWindowsRemoteSessionLaunchMode');
    const [terminalTmuxByMachineId, setTerminalTmuxByMachineId] = useSettingMutable('sessionTmuxByMachineId');
    const settings = useSettings();
    const applySettings = useApplySettings();
    const settingsVersion = useSettingsVersion();
    const expectedSettingsScope = useAccountSettingsScope();
    const activeAccountScope = useActiveServerAccountScope();
    const hasDurableProviderCleanup = useMemo(() => {
        if (!machineId || !machine?.revokedAt) return false;
        return hasProviderMachineStateV1(
            readProviderSettingsFromAccountSettingsV1(settings).settings,
            machineId,
        );
    }, [machine?.revokedAt, machineId, settings]);
    const providerCleanupPending = isProviderCleanupPending || hasDurableProviderCleanup;
    const machineListByServerId = useMachineListByServerId();
    const allMachines = useMemo(() => {
        const byId = new Map<string, Machine>();
        for (const list of Object.values(machineListByServerId)) {
            if (!Array.isArray(list)) continue;
            for (const candidate of list) {
                byId.set(candidate.id, candidate);
            }
        }
        return Array.from(byId.values());
    }, [machineListByServerId]);
    const activeServerId = getActiveServerId();
    const requestedServerId = typeof serverIdParam === 'string' ? serverIdParam.trim() : '';
    const machineListServerId = useMemo(() => resolveMachineServerIdFromList({
        activeServerId,
        machineId,
        machineListByServerId,
    }), [activeServerId, machineId, machineListByServerId]);
    const machineServerId = requestedServerId || machineListServerId || activeServerId;
    const [nameDraft, setNameDraft] = useState<{ machineId: string; serverId: string; value: string } | null>(null);
    const currentNameDraft = nameDraft && nameDraft.machineId === machineId
        && areServerProfileIdentifiersEquivalent(nameDraft.serverId, machineServerId) ? nameDraft : null;
    React.useEffect(() => {
        setNameDraft((draft) => draft && draft.machineId === machineId
            && areServerProfileIdentifiersEquivalent(draft.serverId, machineServerId) ? draft : null);
    }, [machineId, machineServerId]);
    const [executionRunsState, setExecutionRunsState] = useState<
        | { status: 'idle' | 'loading'; runs: readonly DaemonExecutionRunEntry[] }
        | { status: 'loaded'; runs: readonly DaemonExecutionRunEntry[] }
        | { status: 'error'; runs: readonly DaemonExecutionRunEntry[]; error: string }
    >({ status: 'idle', runs: [] });
    const [showFinishedRuns, setShowFinishedRuns] = useState(false);
    const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);

    React.useEffect(() => {
        if (!requestedServerId) return;
        const currentServerId = getActiveServerId();
        if (areServerProfileIdentifiersEquivalent(currentServerId, requestedServerId)) return;

        let cancelled = false;
        setIsServerSwitching(true);
        fireAndForget((async () => {
            try {
                await setActiveServerAndSwitch({
                    serverId: requestedServerId,
                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                });
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                if (!cancelled) {
                    setIsServerSwitching(false);
                }
            }
        })(), { tag: 'MachineDetailScreen.switchServer' });

        return () => {
            cancelled = true;
        };
    }, [requestedServerId]);

    React.useEffect(() => {
        if (!machineId) return;
        if (machine) {
            machineHydrationRequestedRef.current = false;
            if (isHydratingMachine) {
                setIsHydratingMachine(false);
            }
            return;
        }

        if (machineHydrationRequestedRef.current) return;
        machineHydrationRequestedRef.current = true;

        let cancelled = false;
        setIsHydratingMachine(true);
        fireAndForget((async () => {
            try {
                await sync.refreshMachines();
            } finally {
                if (!cancelled) {
                    setIsHydratingMachine(false);
                }
            }
        })(), { tag: 'MachineDetailScreen.hydrateMachine' });

        return () => {
            cancelled = true;
        };
    }, [isHydratingMachine, machine, machineId]);

    const { state: detectedCapabilities, refresh: refreshDetectedCapabilities } = useMachineCapabilitiesCache({
        machineId: machineId ?? null,
        serverId: machineServerId,
        cacheKeySalt: machine?.daemonStateVersion ?? 0,
        enabled: Boolean(machineId && isOnline && !isServerSwitching),
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });
    const detectedCapabilitiesSnapshot = React.useMemo(() => {
        return detectedCapabilities.status === 'loaded'
            ? detectedCapabilities.snapshot
            : detectedCapabilities.status === 'loading'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'error'
                    ? detectedCapabilities.snapshot
                    : undefined;
    }, [detectedCapabilities]);
    const windowsTerminalAvailable =
        isWindowsMachine
        && ((detectedCapabilitiesSnapshot?.response.results as Record<string, any> | undefined)?.['tool.windowsTerminal']?.data?.available === true);
    const effectiveWindowsRemoteSessionLaunchMode = resolveEffectiveWindowsRemoteSessionLaunchMode({
        machineMetadata: metadata,
        settings,
    }).mode;

    const tmuxOverride = machineId ? terminalTmuxByMachineId?.[machineId] : undefined;
    const tmuxOverrideEnabled = Boolean(tmuxOverride || (machineId && settings.sessionTerminalHostByMachineId?.[machineId]));
    const selectedGlobalTerminalHost = resolveTerminalHost({ settings, machineId: null });
    const selectedMachineTerminalHost = resolveTerminalHost({ settings, machineId: machineId ?? null });
    const machineDoctorSnapshotServerId = machineServerId;
    const machineDoctorSnapshotSwitchReady = Boolean(
        machineId
        && !isServerSwitching
        && (!requestedServerId || areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId)),
    );
    const canPrefetchMachineDoctorSnapshot = machineDoctorSnapshotSwitchReady;
    const machineDoctorSnapshotTargets = useMemo(() => {
        if (!machineDoctorSnapshotSwitchReady || !machineId || !machineDoctorSnapshotServerId) return [];
        return [{ machineId, serverId: machineDoctorSnapshotServerId }];
    }, [machineDoctorSnapshotServerId, machineDoctorSnapshotSwitchReady, machineId]);
    const machineDoctorSnapshotPrefetchTargets = useMemo(() => {
        if (!machineDoctorSnapshotSwitchReady || !machineId || !isOnline || !machineDoctorSnapshotServerId) return [];
        return [{ machineId, serverId: machineDoctorSnapshotServerId }];
    }, [isOnline, machineDoctorSnapshotServerId, machineDoctorSnapshotSwitchReady, machineId]);

    const {
        fetchMachineDoctorSnapshots,
        readMachineDoctorSnapshotState,
    } = useMachineDoctorSnapshotCollection({
        machineDoctorSnapshotTargets,
        prefetchMachineDoctorSnapshotTargets: machineDoctorSnapshotPrefetchTargets,
        enabled: canPrefetchMachineDoctorSnapshot,
    });

    const tmuxAvailable = React.useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        return resolveTmuxAvailable(snapshot?.response);
    }, [detectedCapabilities]);

    const setTmuxOverrideEnabled = useCallback((enabled: boolean) => {
        if (!machineId) return;
        applySettings(buildMachineTerminalSettingsPatch({ settings, machineId, host: enabled ? selectedGlobalTerminalHost : null }));
    }, [
        machineId,
        applySettings,
        settings,
        selectedGlobalTerminalHost,
    ]);

    const updateTmuxOverride = useCallback((patch: Partial<NonNullable<typeof tmuxOverride>>) => {
        if (!machineId || !tmuxOverride) return;
        setTerminalTmuxByMachineId({
            ...terminalTmuxByMachineId,
            [machineId]: {
                ...tmuxOverride,
                ...patch,
            },
        });
    }, [machineId, setTerminalTmuxByMachineId, terminalTmuxByMachineId, tmuxOverride]);

    const setTerminalHostOverride = useCallback((next: 'none' | 'tmux' | 'zellij' | 'herdr') => {
        if (next === 'tmux' && tmuxAvailable === false) {
            Modal.alert(t('common.error'), t('machine.tmux.notDetectedMessage'));
            return;
        }
        if (!machineId) return;
        applySettings(buildMachineTerminalSettingsPatch({ settings, machineId, host: next }));
    }, [tmuxAvailable, machineId, applySettings, settings]);

    const handleRevokeMachine = useCallback(() => {
        if (!machineId || isRevokingMachine) return;
        if (machine?.revokedAt && !providerCleanupPending) return;

        fireAndForget((async () => {
            const confirmed = await Modal.confirm(
                t('machine.actions.removeMachine'),
                t('machine.actions.removeMachineConfirmBody'),
                { confirmText: t('common.remove'), destructive: true },
            );
            if (!confirmed) return;

            setIsRevokingMachine(true);
            try {
                const result = await machineRevokeWithProviderCleanup(machineId, expectedSettingsScope, settingsVersion, {
                    revoke: machineRevokeFromAccount,
                    mutateAccountSettingsOnce: sync.mutateAccountSettingsOnce,
                });
                if (!result.ok) {
                    if ('machineRevoked' in result && result.machineRevoked) {
                        setIsProviderCleanupPending(true);
                        await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
                        await Modal.alert(
                            t('common.error'),
                            t('settingsProviders.errors.machineCleanupPendingDescription'),
                        );
                    } else {
                        await Modal.alert(t('common.error'), t('errors.operationFailed'));
                    }
                    return;
                }
                setIsProviderCleanupPending(false);
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
                router.back();
            } finally {
                setIsRevokingMachine(false);
            }
        })(), { tag: 'MachineDetailScreen.revokeMachine' });
    }, [expectedSettingsScope, isRevokingMachine, machine?.revokedAt, machineId, providerCleanupPending, router, settingsVersion]);

    const replacementCandidates = useMemo<MachineReplacementPickerCandidate[]>(() => {
        if (!machineId) return [];
        const candidates = allMachines
            .filter((candidate) => candidate.id !== machineId)
            .filter((candidate) => !candidate.revokedAt)
            .filter((candidate) => !candidate.replacedByMachineId);
        // Candidates are shown together, so same-named machines are told apart by the naming owner.
        const names = resolveMachineDisplayNames(candidates);
        return candidates
            .map((candidate) => {
                const label = names.get(candidate.id) ?? getMachineDisplayName(candidate);
                return {
                    id: candidate.id,
                    label,
                    subtitle: resolveMachineReplacementCandidateSubtitle(candidate),
                    online: isMachineOnline(candidate),
                };
            });
    }, [allMachines, machineId]);

    const handleReplaceMachine = useCallback((replacementMachineId: string, label: string) => {
        if (!machineId || replacingMachineId) return;

        fireAndForget((async () => {
            const confirmed = await Modal.confirm(
                t('machine.replacementRepair.confirmTitle'),
                t('machine.replacementRepair.confirmBody', { machine: label }),
                { confirmText: t('machine.replacementRepair.confirmAction') },
            );
            if (!confirmed) return;

            setReplacingMachineId(replacementMachineId);
            try {
                const result = await machineReplaceInAccount({
                    oldMachineId: machineId,
                    replacementMachineId,
                    confirmActiveOldMachine: machine?.active === true,
                });
                if (!result.ok) {
                    await Modal.alertAsync(t('common.error'), t('machine.replacementRepair.error'));
                    return;
                }
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                setReplacingMachineId(null);
            }
        })(), { tag: 'MachineDetailScreen.replaceMachine' });
    }, [machine?.active, machineId, replacingMachineId]);

    const handleOpenReplacementPicker = useCallback(() => {
        if (!machineId || replacingMachineId || replacementCandidates.length === 0) return;

        Modal.show({
            component: MachineReplacementPickerModal,
            props: {
                candidates: replacementCandidates,
                onSelectCandidate: handleReplaceMachine,
            },
            chrome: {
                kind: 'card',
                title: t('machine.replacementRepair.pickerTitle'),
                testID: 'machine-replacement-picker-modal',
                scrollHost: 'body',
                bodyScroll: 'auto',
                dimensions: { width: 520, maxHeightRatio: 0.86, size: 'md' },
            },
            closeOnBackdrop: true,
        });
    }, [handleReplaceMachine, machineId, replacementCandidates, replacingMachineId]);

    const handleClearReplacement = useCallback(() => {
        if (!machineId || isClearingReplacement) return;

        fireAndForget((async () => {
            const confirmed = await Modal.confirm(
                t('machine.replacementRepair.undoConfirmTitle'),
                t('machine.replacementRepair.undoConfirmBody'),
                { confirmText: t('machine.replacementRepair.undoAction') },
            );
            if (!confirmed) return;

            setIsClearingReplacement(true);
            try {
                const result = await machineClearReplacementFromAccount(machineId);
                if (!result.ok) {
                    await Modal.alertAsync(t('common.error'), t('machine.replacementRepair.error'));
                    return;
                }
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                setIsClearingReplacement(false);
            }
        })(), { tag: 'MachineDetailScreen.clearMachineReplacement' });
    }, [isClearingReplacement, machineId]);

    const machineSessions = useMemo(() => {
        if (!sessions || !machineId) return [];

        return filterUserFacingMachineDetailSessions(sessions).filter(session => {
            const ownerMetadata = readSessionOwnerMetadataView(session);
            return readDisplayMachineIdForSession({
                sessionId: session.id,
                metadata: ownerMetadata,
            }) === machineId;
        });
    }, [sessions, machineId]);

    const previousSessions = useMemo(() => {
        return [...machineSessions]
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 5);
    }, [machineSessions]);

    // Determine daemon status from metadata
    const daemonStatus = useMemo((): 'unknown' | 'stopped' | 'likelyAlive' => {
        if (!machine) return 'unknown';

        if (machine.metadata?.daemonLastKnownStatus === 'shutting-down') {
            return 'stopped';
        }

        // Use machine online status as proxy for daemon status
        return isMachineOnline(machine) ? 'likelyAlive' : 'stopped';
    }, [machine]);
    const daemonStatusLabel =
        daemonStatus === 'likelyAlive'
            ? t('machine.daemonStatus.likelyAlive')
            : daemonStatus === 'stopped'
                ? t('machine.daemonStatus.stopped')
                : t('machine.daemonStatus.unknown');

    const handleStopDaemon = async () => {
        const runStopDaemon = async () => {
            setIsStoppingDaemon(true);
            try {
                const result = await machineStopDaemon(machineId!, { serverId: machineServerId });
                Modal.alert(t('machine.daemonStoppedTitle'), result.message);
                // Refresh to get updated metadata
                await sync.refreshMachines();
            } catch (error) {
                const shown = tryShowDaemonUnavailableAlertForRpcError({
                    error,
                    machine,
                    onRetry: () => {
                        void runStopDaemon();
                    },
                    shouldContinue,
                });
                if (!shown) {
                    Modal.alert(t('common.error'), t('machine.stopDaemonFailed'));
                }
            } finally {
                setIsStoppingDaemon(false);
            }
        };

        // Show confirmation modal using alert with buttons
        Modal.alert(
            t('machine.stopDaemonConfirmTitle'),
            t('machine.stopDaemonConfirmBody'),
            [
                {
                    text: t('common.cancel'),
                    style: 'cancel'
                },
                {
                    text: t('machine.stopDaemon'),
                    style: 'destructive',
                    onPress: async () => {
                        await runStopDaemon();
                    }
                }
            ]
        );
    };

    // inline control below

    /** Reloads everything this page shows about the machine. Both refresh entry points call it. */
    const reloadMachineDetail = async () => {
        await sync.refreshMachines();
        refreshDetectedCapabilities({ bypassCache: true });
        if (canPrefetchMachineDoctorSnapshot && machineDoctorSnapshotPrefetchTargets.length > 0) {
            await fetchMachineDoctorSnapshots(machineDoctorSnapshotPrefetchTargets);
        }
        if (machineId && isOnline && !isServerSwitching) {
            setExecutionRunsState((prev) => ({ status: 'loading', runs: prev.runs }));
            const res = await machineExecutionRunsList(machineId, { serverId: machineServerId });
            if (res.ok) {
                setExecutionRunsState({ status: 'loaded', runs: res.runs });
            } else {
                setExecutionRunsState((prev) => ({ status: 'error', runs: prev.runs, error: res.error }));
            }
        }
    };

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            await runRefreshDiagnosticAction({
                action: 'pull_to_refresh',
                screen: 'machine_detail',
            }, reloadMachineDetail);
        } finally {
            setIsRefreshing(false);
        }
    };

    // The unavailable banner's Retry: the same reload, with its own progress on the button. It is not
    // a pull-to-refresh, so it neither records one nor spins the list's refresh control.
    const [isRetryingAvailability, setIsRetryingAvailability] = useState(false);
    const handleRetryAvailability = async () => {
        setIsRetryingAvailability(true);
        try {
            await reloadMachineDetail();
        } finally {
            setIsRetryingAvailability(false);
        }
    };

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        if (isServerSwitching) return;

        let cancelled = false;
        setExecutionRunsState((prev) => ({ status: 'loading', runs: prev.runs }));
        fireAndForget((async () => {
            const res = await machineExecutionRunsList(machineId, { serverId: machineServerId });
            if (cancelled) return;
            if (res.ok) {
                setExecutionRunsState({ status: 'loaded', runs: res.runs });
            } else {
                setExecutionRunsState((prev) => ({ status: 'error', runs: prev.runs, error: res.error }));
            }
        })(), { tag: 'MachineDetailScreen.fetchExecutionRuns' });

        return () => {
            cancelled = true;
            // A load abandoned because the machine went offline (or the Home changed) has no answer
            // coming: leave "Loading…" rather than hold it forever. Loaded rows stay as they were.
            setExecutionRunsState((prev) => (prev.status === 'loading' ? { status: 'idle', runs: prev.runs } : prev));
        };
    }, [isOnline, isServerSwitching, machineId, machineServerId]);

    const capabilitiesSnapshot = useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        return snapshot ?? null;
    }, [detectedCapabilities]);

    const handleRenameMachine = () => {
        if (!machine || !machineId || isRenamingMachine) return;
        setNameDraft({ machineId, serverId: machineServerId, value: machine.metadata?.displayName || '' });
    };

    const handleSaveMachineName = async () => {
        if (!machine || !machineId || !currentNameDraft || isRenamingMachine || isServerSwitching) return;
        const savedDraft = currentNameDraft;
        setIsRenamingMachine(true);
        try {
            await machineUpdateMetadata(machineId, {
                ...machine.metadata!,
                displayName: savedDraft.value.trim() || undefined,
            }, machine.metadataVersion);
            setNameDraft((draft) => draft === savedDraft ? null : draft);
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('machine.renameFailed')
            );
            await sync.refreshMachines();
        } finally {
            setIsRenamingMachine(false);
        }
    };

    const updateMachineWindowsRemoteSessionLaunchMode = useCallback(async (mode: 'hidden' | 'windows_terminal' | 'console' | null) => {
        if (!machine || !machineId || !machine.metadata) return;
        if (machine.metadata.platform !== 'win32') return;

        setIsUpdatingWindowsConsoleMode(true);
        try {
            const {
                windowsRemoteSessionLaunchMode: _next,
                windowsRemoteSessionConsole: _legacy,
                ...rest
            } = machine.metadata;
            const updatedMetadata: MachineMetadata = {
                ...rest,
                ...(mode ? { windowsRemoteSessionLaunchMode: mode } : {}),
            };

            await machineUpdateMetadata(
                machineId,
                updatedMetadata,
                machine.metadataVersion,
            );
        } catch (error) {
            Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('machine.windows.remoteSessionConsoleUpdateFailed'),
            );
            await sync.refreshMachines();
        } finally {
            setIsUpdatingWindowsConsoleMode(false);
        }
    }, [machine, machineId]);

    const setWindowsRemoteSessionLaunchModeOverrideEnabled = useCallback(async (enabled: boolean) => {
        if (!enabled) {
            await updateMachineWindowsRemoteSessionLaunchMode(null);
            return;
        }
        await updateMachineWindowsRemoteSessionLaunchMode(effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault);
    }, [effectiveWindowsRemoteSessionLaunchMode, updateMachineWindowsRemoteSessionLaunchMode, windowsRemoteSessionLaunchModeDefault]);

    // The composer owns starting a session: once this machine is chosen its path chip lists the
    // machine's recent paths, so the page hands off with the machine and its Home seeded rather than
    // keeping a second launcher of its own.
    const handleStartSession = useCallback(() => {
        const targetServerId = String(machineServerId ?? '').trim();
        if (!machineId || !targetServerId || !activeAccountScope) return;
        const draftId = seedNewSessionDraftV1({
            seed: { placement: { kind: 'exactTarget', serverId: targetServerId, machineId } },
            scope: activeAccountScope,
        });
        if (!draftId) return;
        router.push({ pathname: '/new', params: buildNewSessionLaunchRouteParams({ draftId }) });
    }, [activeAccountScope, machineId, machineServerId, router]);

    const pastUsedRelativePath = useCallback((session: Session) => {
        return getSessionSubtitle(session, machineServerId);
    }, [machineServerId]);

    const headerBackTitle = t('machine.back');

    // The page header names the machine, so the native header keeps a plain, empty title. Hosted in
    // the Settings Machines collection, the collection owns the navigation chrome: no second header.
    const hostedInSettingsCollection = useHappierCollectionLayout() !== null;
    const screenOptions = React.useMemo(() => {
        return {
            headerShown: !hostedInSettingsCollection,
            headerTitle: '',
            headerBackTitle,
        } as const;
    }, [headerBackTitle, hostedInSettingsCollection]);

    const machineName = useMemo(() => {
        if (!machine) return t('machine.unknownMachine');
        // The same name the lists show, told apart when another machine shares it.
        const homeMachines = machineListByServerId[String(machineServerId ?? '')] ?? [];
        const siblings = homeMachines.some((candidate) => candidate.id === machine.id) ? homeMachines : [...homeMachines, machine];
        return resolveMachineDisplayNames(siblings).get(machine.id) ?? t('machine.unknownMachine');
    }, [machine, machineListByServerId, machineServerId]);
    const machineIsOnline = machine ? isMachineOnline(machine) : false;

    const replacedByMachineLabel = React.useMemo(() => {
        const replacedById = machine?.replacedByMachineId;
        if (!replacedById) return null;
        const replacement = allMachines.find((candidate) => candidate.id === replacedById);
        return replacement ? getMachineDisplayName(replacement) : replacedById;
    }, [allMachines, machine?.replacedByMachineId]);

    const headerMeta = React.useMemo((): PageHeaderMetaFact[] => {
        if (!machine) return [];
        const facts: PageHeaderMetaFact[] = [{
            key: 'presence',
            text: machineIsOnline ? t('machineDetailPage.online') : t('machineDetailPage.offline'),
            testID: 'machine-detail-presence',
        }];
        const platformLabel = formatOSPlatform(machine.metadata?.platform);
        if (platformLabel) facts.push({ key: 'platform', text: platformLabel });
        const host = machine.metadata?.host;
        if (host && machine.metadata?.displayName && host !== machine.metadata.displayName) {
            facts.push({ key: 'host', text: host });
        }
        const cliVersion = machine.daemonState?.cliVersion;
        if (cliVersion) facts.push({ key: 'cli', text: t('machineDetailPage.cliVersionFact', { version: cliVersion }) });
        if (replacedByMachineLabel) {
            facts.push({ key: 'replaced', text: t('machineDetailPage.replacedByFact', { machine: replacedByMachineLabel }) });
        }
        return facts;
    }, [machine, machineIsOnline, replacedByMachineLabel]);

    // Entity-header anatomy: presence in the meta, every machine action in one `⋯`.
    const headerMenuActions = React.useMemo((): PageHeaderMenuAction[] => {
        if (!machine) return [];
        const rename: PageHeaderMenuAction = {
            id: 'rename',
            testID: 'machine-detail-menu-rename',
            title: t('machine.renameTitle'),
            loading: isRenamingMachine,
            onSelect: handleRenameMachine,
        };
        if (machine.replacedByMachineId) {
            return [rename, {
                id: 'undo-replacement',
                testID: 'machine-replacement-repair-undo',
                title: t('machine.replacementRepair.undo'),
                loading: isClearingReplacement,
                onSelect: handleClearReplacement,
            }];
        }
        if (replacementCandidates.length > 0) {
            return [rename, {
                id: 'replace',
                testID: 'machine-replacement-repair-open',
                title: t('machine.replacementRepair.replaceWithMachine'),
                loading: replacingMachineId !== null,
                onSelect: handleOpenReplacementPicker,
            }];
        }
        return [rename];
    }, [
        handleClearReplacement,
        handleOpenReplacementPicker,
        handleRenameMachine,
        isClearingReplacement,
        isRenamingMachine,
        machine,
        replacementCandidates.length,
        replacingMachineId,
    ]);

    if (!machine) {
        // The page keeps its identity while the machine loads or when it no longer exists: the same
        // header with a placeholder name, then the state where the sections would be.
        return (
            <>
                <Stack.Screen
                    options={screenOptions}
                />
                <ItemList>
                    <PageHeader
                        testID="machine-detail-header"
                        alwaysShowTitle
                        title={t('machineDetailPage.placeholderTitle')}
                        description={t('machineDetailPage.description')}
                        leading={(
                            <PageHeaderMarkSlot>
                                <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                            </PageHeaderMarkSlot>
                        )}
                    />
                    <ItemGroup surface="none">
                        {isHydratingMachine ? (
                            <SurfaceStateCard
                                testID="machine-detail-loading"
                                kind="loading"
                                title={t('common.loading')}
                            />
                        ) : (
                            <SurfaceStateCard
                                testID="machine-detail-not-found"
                                kind="unavailable"
                                title={t('machine.notFound')}
                            />
                        )}
                    </ItemGroup>
                </ItemList>
            </>
        );
    }

    const removeMachineFootnote = providerCleanupPending
        ? t('settingsProviders.errors.machineCleanupPendingDescription')
        : machine.revokedAt
            ? t('machine.actions.removeMachineAlreadyRemoved')
            : t('machine.actions.removeMachineSubtitle');

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            {/* An agent's own sign-in opens in this page's bottom pane (lab agent-setup T1). */}
            <AgentSignInPaneHost scopeId={`machine:${machineId}`} main={(
            <ItemList
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
                keyboardShouldPersistTaps="handled"
            >
                <PageHeader
                    testID="machine-detail-header"
                    alwaysShowTitle
                    title={machineName}
                    description={t('machineDetailPage.description')}
                    leading={(
                        <PageHeaderMarkSlot>
                            <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                        </PageHeaderMarkSlot>
                    )}
                    meta={headerMeta}
                    actions={(
                        <View style={styles.headerActions}>
                            <RoundButton
                                testID="machine-detail-start-session"
                                size="small"
                                title={t('machineDetailPage.startAction')}
                                disabled={!machineCanSpawn}
                                onPress={handleStartSession}
                            />
                            <PageHeaderMenu testID="machine-detail-menu" actions={headerMenuActions} />
                        </View>
                    )}
                />

                {currentNameDraft ? (
                    <ItemGroup>
                        <SectionContentRow>
                            <FieldItem label={t('machine.renameTitle')} supportingText={t('machine.renameDescription')}>
                                <FieldTextInput
                                    testID="machine-detail-name-input"
                                    accessibilityLabel={t('machine.renameTitle')}
                                    value={currentNameDraft.value}
                                    placeholder={machine.metadata?.host || t('machine.renamePlaceholder')}
                                    editable={!isRenamingMachine}
                                    onChangeText={(value) => setNameDraft((draft) => draft ? { ...draft, value } : draft)}
                                    onSubmitEditing={handleSaveMachineName}
                                />
                            </FieldItem>
                        </SectionContentRow>
                        <SectionContentRow>
                            <View style={styles.leaveActions}>
                                <RoundButton testID="machine-detail-name-save" size="small" title={t('common.save')} loading={isRenamingMachine} disabled={isRenamingMachine || isServerSwitching} action={handleSaveMachineName} />
                                <RoundButton testID="machine-detail-name-cancel" size="small" display="secondary" title={t('common.cancel')} disabled={isRenamingMachine} onPress={() => setNameDraft(null)} />
                            </View>
                        </SectionContentRow>
                    </ItemGroup>
                ) : null}

                {/* What blocks use comes first, with the next action inside it. */}
                {!machineCanSpawn ? (
                    <AttentionBanner
                        testID="machine-detail-unavailable"
                        title={t('machineDetailPage.unavailableTitle')}
                        description={t('machine.offlineHelp')}
                        action={{
                            label: t('common.retry'),
                            onPress: () => void handleRetryAvailability(),
                            loading: isRetryingAvailability,
                            disabled: isRetryingAvailability,
                        }}
                    />
                ) : null}

                {/* Agents first (lab agent-setup M1): what runs here, its sign-in, and setting up more. */}
                {machineId ? (
                    <MachineAgentsSection
                        serverId={machineServerId}
                        machineId={machineId}
                        machineName={machineName}
                    />
                ) : null}

                {/* Machine-specific terminal-host override; tmux details remain available below. */}
                {!!machineId && (
                    <ItemGroup title={t('settingsSessionPages.runtime.terminalHostTitle')} description={t('settingsSessionPages.runtime.pageDescription')}>
                        <Item
                            title={t('machine.tmux.overrideTitle')}
                            subtitle={tmuxOverrideEnabled ? t('machine.tmux.overrideEnabledSubtitle') : t('machine.tmux.overrideDisabledSubtitle')}
                            rightElement={<Switch value={tmuxOverrideEnabled} onValueChange={setTmuxOverrideEnabled} />}
                            showChevron={false}
                            onPress={() => setTmuxOverrideEnabled(!tmuxOverrideEnabled)}
                        />

                        {!tmuxOverrideEnabled && (
                            <Item
                                testID="machine-terminal-effective-host"
                                title={t('settingsSessionPages.runtime.terminalHostTitle')}
                                subtitle={selectedMachineTerminalHost === 'none'
                                    ? t('settingsSessionPages.runtime.terminalHostNone')
                                    : selectedMachineTerminalHost === 'herdr' ? 'Herdr'
                                        : selectedMachineTerminalHost === 'zellij' ? 'Zellij' : 'tmux'}
                                mode="info"
                                showChevron={false}
                            />
                        )}

                        {tmuxOverrideEnabled && (
                            <>
                                <SegmentedChoiceItem<'none' | 'tmux' | 'zellij' | 'herdr'>
                                    title={t('settingsSessionPages.runtime.terminalHostTitle')}
                                    options={[
                                        { id: 'none', label: t('settingsSessionPages.runtime.terminalHostNone') },
                                        { id: 'tmux', label: 'tmux', unavailableReason: tmuxAvailable === false ? t('machine.tmux.notDetectedSubtitle') : undefined },
                                        { id: 'zellij', label: 'Zellij' },
                                        { id: 'herdr', label: 'Herdr' },
                                    ]}
                                    value={selectedMachineTerminalHost}
                                    onChange={setTerminalHostOverride}
                                />

                                {selectedMachineTerminalHost === 'tmux' && tmuxOverride && (
                                    <>
                                        <Item
                                            title={t('profiles.tmuxSession')}
                                            subtitle={t('common.optional')}
                                            showChevron={false}
                                            mode="info"
                                            accessoryLayout="adaptive"
                                            rightElement={(
                                                <FieldTextInput
                                                    accessibilityLabel={t('profiles.tmuxSession')}
                                                    placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                                    value={tmuxOverride.sessionName}
                                                    onChangeText={(value) => updateTmuxOverride({ sessionName: value })}
                                                    autoCapitalize="none"
                                                    monospace
                                                />
                                            )}
                                        />

                                        <Item
                                            title={t('profiles.tmux.isolatedServerTitle')}
                                            subtitle={tmuxOverride.isolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                            rightElement={<Switch value={tmuxOverride.isolated} onValueChange={(next) => updateTmuxOverride({ isolated: next })} />}
                                            showChevron={false}
                                            onPress={() => updateTmuxOverride({ isolated: !tmuxOverride.isolated })}
                                        />

                                        {tmuxOverride.isolated && (
                                            <Item
                                                title={t('profiles.tmuxTempDir')}
                                                subtitle={t('common.optional')}
                                                showChevron={false}
                                                mode="info"
                                                accessoryLayout="adaptive"
                                                rightElement={(
                                                    <FieldTextInput
                                                        accessibilityLabel={t('profiles.tmuxTempDir')}
                                                        placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                                        value={tmuxOverride.tmpDir ?? ''}
                                                        onChangeText={(value) => updateTmuxOverride({ tmpDir: value.trim().length > 0 ? value : null })}
                                                        autoCapitalize="none"
                                                        monospace
                                                    />
                                                )}
                                            />
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </ItemGroup>
                )}

                {/* Windows-specific settings */}
                {!!machineId && isWindowsMachine && (
                    <ItemGroup title={t('machine.windows.title')} description={t('machineDetailPage.windowsSectionDescription')}>
                        <Item
                            title={t('machine.windows.remoteSessionModeOverrideTitle')}
                            subtitle={
                                windowsRemoteSessionLaunchModeOverrideEnabled
                                    ? t('machine.windows.remoteSessionModeOverrideEnabledSubtitle')
                                    : t('machine.windows.remoteSessionModeOverrideDisabledSubtitle')
                            }
                            rightElement={
                                <Switch
                                    value={windowsRemoteSessionLaunchModeOverrideEnabled}
                                    onValueChange={setWindowsRemoteSessionLaunchModeOverrideEnabled}
                                    disabled={isUpdatingWindowsConsoleMode}
                                />
                            }
                            showChevron={false}
                            disabled={isUpdatingWindowsConsoleMode}
                            onPress={() => setWindowsRemoteSessionLaunchModeOverrideEnabled(!windowsRemoteSessionLaunchModeOverrideEnabled)}
                        />
                        {windowsRemoteSessionLaunchModeOverrideEnabled ? (
                            <DropdownMenu
                                open={openWindowsRemoteSessionLaunchModeMenu}
                                onOpenChange={setOpenWindowsRemoteSessionLaunchModeMenu}
                                items={WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.map((option) => ({
                                    id: option.value,
                                    title: t(option.labelKey),
                                    subtitle: option.value === 'windows_terminal' && !windowsTerminalAvailable
                                        ? `${t(option.subtitleKey)} ${t('machine.windows.windowsTerminalUnavailableSuffix')}`
                                        : t(option.subtitleKey),
                                    disabled: option.value === 'windows_terminal' && !windowsTerminalAvailable,
                                }))}
                                selectedId={machineWindowsRemoteSessionLaunchMode ?? effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault}
                                onSelect={(id) => {
                                    if (id === 'hidden' || id === 'windows_terminal' || id === 'console') {
                                        void updateMachineWindowsRemoteSessionLaunchMode(id);
                                    }
                                }}
                                itemTrigger={{
                                    title: t('machine.windows.remoteSessionModeTitle'),
                                    subtitle: t(
                                        WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.find((option) =>
                                            option.value === (machineWindowsRemoteSessionLaunchMode ?? effectiveWindowsRemoteSessionLaunchMode ?? windowsRemoteSessionLaunchModeDefault)
                                        )?.subtitleKey ?? 'windowsRemoteSessionLaunchMode.hiddenSubtitle',
                                    ),
                                }}
                                rowKind="item"
                                connectToTrigger
                                variant="default"
                            />
                        ) : null}
                    </ItemGroup>
                )}

                {/* How this account's devices reach this machine: follow the account or override it here. */}
                {machineId ? (
                    <MachineDirectConnectionSection machineId={machineId} machineName={machineName} />
                ) : null}

                {/* Machine tools that aren't agents (agent parts install through the Agents section). */}
                <ItemGroup title={t('machine.tools.title')}>
                    <Item
                        title={t('machine.tools.installablesTitle')}
                        icon={<Icon name="cube" />}
                        subtitle={t('machine.tools.installablesSubtitle')}
                        showChevron={true}
                        onPress={() => {
                            if (!machineId) return;
                            router.push(`/machine/${encodeURIComponent(machineId)}/installables?serverId=${encodeURIComponent(activeServerId)}`);
                        }}
                    />
                </ItemGroup>

                {/* Execution runs */}
                {executionRunsState.status !== 'idle' && (
                    <ItemGroup title={t('runs.title')} description={t('machineDetailPage.runsSectionDescription')}>
                        <Item
                            title={t('runs.showFinished')}
                            showChevron={false}
                            rightElement={(
                                <Switch
                                    value={showFinishedRuns}
                                    onValueChange={setShowFinishedRuns}
                                    disabled={executionRunsState.status === 'loading'}
                                />
                            )}
                        />
                        {executionRunsState.status === 'loading' ? (
                            <Item
                                title={t('common.loading')}
                                showChevron={false}
                                rightElement={<ActivitySpinner size="small" color={theme.colors.text.secondary} />}
                            />
                        ) : executionRunsState.status === 'error' ? (
                            <Item
                                title={t('common.error')}
                                subtitle={executionRunsState.error}
                                subtitleStyle={{ color: theme.colors.text.secondary }}
                                showChevron={false}
                            />
                        ) : (showFinishedRuns ? executionRunsState.runs : executionRunsState.runs.filter((r) => r.status === 'running')).length === 0 ? (
                            <Item
                                title={t('runs.empty')}
                                mode="info"
                                showChevron={false}
                            />
                        ) : (
                            (() => {
                                const visibleRuns = showFinishedRuns
                                    ? executionRunsState.runs
                                    : executionRunsState.runs.filter((r) => r.status === 'running');

                                const grouped = new Map<string | null, DaemonExecutionRunEntry[]>();
                                for (const run of visibleRuns) {
                                    const key = readExecutionRunSessionAssociation(run);
                                    const list = grouped.get(key) ?? [];
                                    list.push(run);
                                    grouped.set(key, list);
                                }
                                const orderedSessionIds = Array.from(grouped.keys()).sort((left, right) => {
                                    if (left === null || right === null) {
                                        if (left === right) return 0;
                                        return left === null ? 1 : -1;
                                    }
                                    return left.localeCompare(right);
                                });

                                return orderedSessionIds.flatMap((sessionId) => {
                                    const runs = grouped.get(sessionId) ?? [];
                                    runs.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));

                                    const header = sessionId === null ? null : (
                                        <Item
                                            key={`sess-${sessionId}`}
                                            title={t('runs.sessionTitle', { sessionId })}
                                            icon={<Icon name="chat-circle-dots" />}
                                            subtitle={t('runs.openSession')}
                                            subtitleStyle={{ color: theme.colors.text.secondary }}
                                            onPress={() => navigateToSession(sessionId, { serverId: machineServerId })}
                                            showChevron
                                        />
                                    );

                                    const rows = runs.slice(0, 20).map((run) => {
                                        const detailParts: string[] = [t('runs.detail.pid', { pid: run.pid })];
                                        const cpu = (run as any).process?.cpu;
                                        const memory = (run as any).process?.memory;
                                        if (typeof cpu === 'number' && Number.isFinite(cpu)) {
                                            detailParts.push(t('runs.detail.cpu', { percent: cpu.toFixed(1) }));
                                        }
                                        if (typeof memory === 'number' && Number.isFinite(memory)) {
                                            detailParts.push(t('runs.detail.memory', { megabytes: Math.round(memory / (1024 * 1024)) }));
                                        }

                                        const canStop = run.status === 'running' && sessionId !== null;
                                        const onStop = async () => {
                                            if (!machineId) return;
                                            if (!sessionId) return;
                                            if (!canStop) return;
                                            setStoppingRunId(run.runId);
                                            const stopSessionProcess = async () => {
                                                const stopResult = await machineStopSession(machineId, sessionId, { serverId: machineServerId });
                                                if (stopResult.ok) return;

                                                const shownDaemonUnavailable = tryShowDaemonUnavailableAlertForRpcFailure({
                                                    rpcErrorCode: stopResult.errorCode ?? null,
                                                    message: stopResult.error ?? null,
                                                    machine,
                                                    onRetry: () => {
                                                        void stopSessionProcess();
                                                    },
                                                    shouldContinue,
                                                });
                                                if (!shownDaemonUnavailable) {
                                                    Modal.alert(t('common.error'), stopResult.error || t('runs.stop.failedToStopSession'));
                                                }
                                            };
                                            try {
                                                const res = await sessionExecutionRunStop(
                                                    sessionId,
                                                    { runId: run.runId },
                                                    { serverId: machineServerId },
                                                );
                                                if ((res as any)?.ok === false) {
                                                    const confirmed = await Modal.confirm(
                                                        t('runs.stop.stopRunFailedTitle'),
                                                        t('runs.stop.stopRunFailedBody'),
                                                        { confirmText: t('runs.stop.stopSession'), cancelText: t('common.cancel'), destructive: true },
                                                    );
                                                    if (confirmed) {
                                                        await stopSessionProcess();
                                                    } else {
                                                        Modal.alert(t('common.error'), String((res as any).error ?? t('runs.stop.failedToStopRun')));
                                                    }
                                                }
                                            } catch (error) {
                                                const confirmed = await Modal.confirm(
                                                    t('runs.stop.stopRunFailedTitle'),
                                                    t('runs.stop.stopRunFailedBody'),
                                                    { confirmText: t('runs.stop.stopSession'), cancelText: t('common.cancel'), destructive: true },
                                                );
                                                if (confirmed) {
                                                    await stopSessionProcess();
                                                } else {
                                                    Modal.alert(
                                                        t('common.error'),
                                                        error instanceof Error ? error.message : t('runs.stop.failedToStopRun'),
                                                    );
                                                }
                                            } finally {
                                                setStoppingRunId(null);
                                                const refreshed = await machineExecutionRunsList(machineId, { serverId: machineServerId });
                                                if (refreshed.ok) {
                                                    setExecutionRunsState({ status: 'loaded', runs: refreshed.runs });
                                                }
                                            }
                                        };

                                        return (
                                            <ExecutionRunRow
                                                key={run.runId}
                                                run={run as any}
                                                subtitle={`${t('runs.runLabel', { runId: run.runId })} · ${detailParts.join(' · ')}`}
                                                onPress={sessionId ? () => router.push(buildScopedSessionRouteHref({
                                                    sessionId,
                                                    serverId: machineServerId,
                                                    suffix: `/runs/${encodeURIComponent(run.runId)}`,
                                                }) as any) : undefined}
                                                rightAccessory={canStop ? (
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('runs.stop.stopRunA11y')}
                                                        onPress={onStop}
                                                        disabled={stoppingRunId === run.runId}
                                                        style={({ pressed }) => ({
                                                            opacity: pressed ? motionTokens.press.opacity : 1,
                                                        })}
                                                    >
                                                        {stoppingRunId === run.runId ? (
                                                            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                                        ) : (
                                                            <Icon name="stop-circle" size={20} color={theme.colors.accent.orange} />
                                                        )}
                                                    </Pressable>
                                                ) : null}
                                            />
                                        );
                                    });

                                    return header ? [header, ...rows] : rows;
                                });
                            })()
                        )}
                    </ItemGroup>
                )}

                {/* Recent sessions */}
                {previousSessions.length > 0 && (
                    <ItemGroup
                        title={t('machineDetailPage.recentSessionsTitle')}
                        description={t('machineDetailPage.recentSessionsDescription')}
                    >
                        {previousSessions.map(session => (
                            <Item
                                key={session.id}
                                title={getSessionName(session, machineServerId)}
                                icon={<Icon name="chat-circle-dots" />}
                                subtitle={getSessionSubtitle(session, machineServerId)}
                                onPress={() => navigateToSession(session.id, { serverId: machineServerId })}
                                showChevron
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Daemon */}
                <ItemGroup title={t('machine.daemon')} description={t('machineDetailPage.daemonSectionDescription')}>
                        <Item
                            title={t('machine.status')}
                            detail={daemonStatusLabel}
                            detailStyle={daemonStatus === 'likelyAlive' ? undefined : { color: theme.colors.state.warning.foreground }}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            testID="machine-detail-stop-daemon"
                            title={t('machine.stopDaemon')}
                            subtitle={t('machineDetailPage.stopDaemonDescription')}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                            accessoryLayout="adaptive"
                            rightElement={(
                                <RoundButton
                                    testID="machine-detail-stop-daemon-button"
                                    size="small"
                                    display="secondary"
                                    title={t('machineDetailPage.stopDaemonAction')}
                                    disabled={isStoppingDaemon || daemonStatus === 'stopped'}
                                    loading={isStoppingDaemon}
                                    onPress={handleStopDaemon}
                                />
                            )}
                        />
                        {machine.daemonState && (
                            <>
                                {machine.daemonState.pid && (
                                    <Item
                                        title={t('machine.lastKnownPid')}
                                        detail={String(machine.daemonState.pid)}
                                        detailStyle={styles.identifier}
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                                {machine.daemonState.httpPort && (
                                    <Item
                                        title={t('machine.lastKnownHttpPort')}
                                        detail={String(machine.daemonState.httpPort)}
                                        detailStyle={styles.identifier}
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                                {machine.daemonState.startTime && (
                                    <Item
                                        title={t('machine.startedAt')}
                                        detail={new Date(machine.daemonState.startTime).toLocaleString()}
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                                {machine.daemonState.cliVersion && (
                                    <Item
                                        title={t('machine.cliVersion')}
                                        detail={machine.daemonState.cliVersion}
                                        detailStyle={styles.identifier}
                                        mode="info"
                                        showChevron={false}
                                    />
                                )}
                            </>
                        )}
                        <Item
                            title={t('machine.daemonStateVersion')}
                            detail={String(machine.daemonStateVersion)}
                            mode="info"
                            showChevron={false}
                        />
                </ItemGroup>

                {!!machineId && machineDoctorSnapshotSwitchReady && (
                    <MachineDoctorRuntimeInventorySection
                        snapshotState={machineId
                            ? readMachineDoctorSnapshotState({
                                machineId,
                                serverId: machineDoctorSnapshotServerId,
                            })
                            : null}
                        mode="details"
                    />
                )}

                <MachineTransferExposureSection daemonState={machine.daemonState ?? null} />

                {/* Machine details */}
                <ItemGroup title={t('machineDetailPage.detailsTitle')}>
                        <Item
                            title={t('machine.host')}
                            detail={metadata?.host || t('status.unknown')}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            title={t('machine.machineId')}
                            detail={machineId}
                            detailStyle={styles.identifier}
                            copy={machineId}
                            mode="info"
                            showChevron={false}
                        />
                        {metadata?.username && (
                            <Item
                                title={t('machine.username')}
                                detail={metadata.username}
                                mode="info"
                                showChevron={false}
                            />
                        )}
                        {metadata?.homeDir && (
                            <Item
                                title={t('machine.homeDirectory')}
                                detail={metadata.homeDir}
                                detailStyle={styles.identifier}
                                mode="info"
                                showChevron={false}
                            />
                        )}
                        {metadata?.platform && (
                            <Item
                                title={t('machine.platform')}
                                detail={formatOSPlatform(metadata.platform)}
                                mode="info"
                                showChevron={false}
                            />
                        )}
                        {metadata?.arch && (
                            <Item
                                title={t('machine.architecture')}
                                detail={metadata.arch}
                                mode="info"
                                showChevron={false}
                            />
                        )}
                        <Item
                            title={t('machine.lastSeen')}
                            detail={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : t('machine.never')}
                            mode="info"
                            showChevron={false}
                        />
                        <Item
                            title={t('machine.metadataVersion')}
                            detail={String(machine.metadataVersion)}
                            mode="info"
                            showChevron={false}
                        />
                </ItemGroup>

                {/* Leaving: the irreversible action closes the page, with its consequence beneath. */}
                <ItemGroup surface="none" accessibilityLabel={t('machine.actions.removeMachine')}>
                    <View style={styles.leaveActions}>
                        <RoundButton
                            testID="machine-detail-remove"
                            size="small"
                            display="destructive"
                            title={t('machine.actions.removeMachine')}
                            titleNumberOfLines="complete"
                            accessibilityHint={removeMachineFootnote}
                            disabled={isRevokingMachine || (Boolean(machine.revokedAt) && !providerCleanupPending)}
                            loading={isRevokingMachine}
                            onPress={handleRevokeMachine}
                        />
                    </View>
                    <Text testID="machine-detail-remove-footnote" style={styles.footnote}>{removeMachineFootnote}</Text>
                </ItemGroup>
            </ItemList>
            )} />
        </>
    );
}
