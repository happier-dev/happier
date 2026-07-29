import React, { useState, useMemo, useCallback, useRef } from 'react';
import { View, ScrollView, RefreshControl, Platform, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemGroupTitleWithAction } from '@/components/ui/lists/ItemGroupTitleWithAction';
import { ItemList } from '@/components/ui/lists/ItemList';
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
import { Ionicons, Octicons } from '@expo/vector-icons';
import type { Machine, MachineMetadata, Session } from '@/sync/domains/state/storageTypes';
import {
    completeMachineSpawnAttemptCustody,
    machineSpawnNewSession,
    machineStopDaemon,
    machineStopSession,
    machineUpdateMetadata,
    machineExecutionRunsList,
    machineClearReplacementFromAccount,
    machineReplaceInAccount,
    machineRevokeFromAccount,
    machineRevokeWithProviderCleanup,
} from '@/sync/ops';
import {
    createUiSessionSpawnNonce,
    createUiSessionSpawnUserAttemptId,
} from '@/sync/domains/session/spawn/spawnSessionNonce';
import {
    resolveMachineDetailSpawnAttempt,
    type MachineDetailSpawnAttempt,
} from '@/components/machines/machineDetailSpawnAttempt';
import { sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { Modal } from '@/modal';
import { formatPathRelativeToHome, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { tryShowDaemonUnavailableAlertForRpcError, tryShowDaemonUnavailableAlertForRpcFailure } from '@/utils/errors/daemonUnavailableAlert';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { MultiTextInput, type MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { MachineTransferExposureSection } from '@/components/machines/MachineTransferExposureSection';
import { MachineDoctorRuntimeInventorySection } from '@/components/machines/doctorSnapshot/MachineDoctorRuntimeInventorySection';
import {
    buildMachineDoctorSnapshotTargetKey,
    useMachineDoctorSnapshotCollection,
} from '@/components/machines/doctorSnapshot/useMachineDoctorSnapshotCollection';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { resolveTerminalSpawnOptions } from '@/sync/domains/settings/terminalSettings';
import {
    readMachineWindowsRemoteSessionLaunchMode,
    resolveEffectiveWindowsRemoteSessionLaunchMode,
} from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode';
import { Switch } from '@/components/ui/forms/Switch';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import {
    hasProviderMachineStateV1,
    readProviderSettingsFromAccountSettingsV1,
    type DaemonExecutionRunEntry,
} from '@happier-dev/protocol';
import { ExecutionRunRow } from '@/components/sessions/runs/ExecutionRunRow';
import { Text, TextInput } from '@/components/ui/text/Text';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';
import { PathInputBrowseButton } from '@/components/ui/pathBrowser/PathInputBrowseButton';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { runRefreshDiagnosticAction } from '@/utils/system/userInteractionDiagnostics';
import { resolvePreferredBackendTargetFromProjection } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import {
    MachineReplacementPickerModal,
    type MachineReplacementPickerCandidate,
} from '@/components/machines/MachineReplacementPickerModal';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';


const styles = StyleSheet.create((theme) => ({
    pathInputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    pathInput: {
        flex: 1,
        borderRadius: 8,
        backgroundColor: theme.colors.input?.background ?? theme.colors.background.canvas,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        minHeight: 44,
        position: 'relative',
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }) as any,
    },
    inlineSendButton: {
        position: 'absolute',
        right: 8,
        bottom: 10,
        width: 32,
        height: 32,
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
    },
    inlineSendActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    inlineSendInactive: {
        // Use a darker neutral in light theme to avoid blending into input
        backgroundColor: Platform.select({
            ios: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surface.inset,
            android: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surface.inset,
            default: theme.colors.permissionButton?.inactive?.background ?? theme.colors.surface.inset,
        }) as any,
    },
    tmuxInputContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    tmuxFieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 4,
    },
    tmuxTextInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: Platform.select({ ios: 10, default: 12 }),
        fontSize: Platform.select({ ios: 17, default: 16 }),
        lineHeight: Platform.select({ ios: 22, default: 24 }),
        letterSpacing: Platform.select({ ios: -0.41, default: 0.15 }),
        color: theme.colors.input.text,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
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

function resolveMachineReplacementCandidateLabel(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
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
    const [customPath, setCustomPath] = useState('');
    const [isSpawning, setIsSpawning] = useState(false);
    const inputRef = useRef<MultiTextInputHandle>(null);
    const spawnAttemptRef = useRef<MachineDetailSpawnAttempt | null>(null);
    const [showAllPaths, setShowAllPaths] = useState(false);
    const [isHydratingMachine, setIsHydratingMachine] = useState(() => Boolean(machineId) && !machine);
    const machineHydrationRequestedRef = useRef(false);
    const isOnline = !!machine && isMachineOnline(machine);
    const machineSpawnReadiness = useMemo(
        () => resolveMachineSpawnReadiness({ machine, selectedMachineId: machineId }),
        [machine, machineId],
    );
    const machineCanSpawn = machineSpawnReadiness.status === 'ready';
    const metadata = machine?.metadata;
    const isWindowsMachine = metadata?.platform === 'win32';
    const machineWindowsRemoteSessionLaunchMode = readMachineWindowsRemoteSessionLaunchMode(metadata);
    const windowsRemoteSessionLaunchModeOverrideEnabled =
        isWindowsMachine && machineWindowsRemoteSessionLaunchMode !== undefined;

    const terminalUseTmux = useSetting('sessionUseTmux');
    const terminalTmuxSessionName = useSetting('sessionTmuxSessionName');
    const terminalTmuxIsolated = useSetting('sessionTmuxIsolated');
    const terminalTmuxTmpDir = useSetting('sessionTmuxTmpDir');
    const windowsRemoteSessionLaunchModeDefault = useSetting('sessionWindowsRemoteSessionLaunchMode');
    const [terminalTmuxByMachineId, setTerminalTmuxByMachineId] = useSettingMutable('sessionTmuxByMachineId');
    const settings = useSettings();
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
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineId ?? null,
        serverId: machineServerId,
        enabled: Boolean(machineId && machineServerId),
        staleMs: 60_000,
    });
    const preferredBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTargetFromProjection({
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey ?? undefined,
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1 ?? undefined,
            daemonMergedProjectionInputs: daemonMergedProjection.inputs,
        });
    }, [
        daemonMergedProjection.inputs,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
        settings.lastUsedAgent,
        settings.lastUsedBackendTarget,
    ]);
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
                await setActiveServerAndSwitch({ serverId: requestedServerId, scope: 'device' });
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
    const tmuxOverrideEnabled = Boolean(tmuxOverride);
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
        const result = snapshot?.response.results['tool.tmux'];
        if (!result || !result.ok) return null;
        const data = result.data as any;
        return typeof data?.available === 'boolean' ? data.available : null;
    }, [detectedCapabilities]);

    const setTmuxOverrideEnabled = useCallback((enabled: boolean) => {
        if (!machineId) return;
        if (enabled) {
            setTerminalTmuxByMachineId({
                ...terminalTmuxByMachineId,
                [machineId]: {
                    useTmux: terminalUseTmux,
                    sessionName: terminalTmuxSessionName,
                    isolated: terminalTmuxIsolated,
                    tmpDir: terminalTmuxTmpDir,
                },
            });
            return;
        }

        const next = { ...terminalTmuxByMachineId };
        delete next[machineId];
        setTerminalTmuxByMachineId(next);
    }, [
        machineId,
        setTerminalTmuxByMachineId,
        terminalTmuxByMachineId,
        terminalUseTmux,
        terminalTmuxIsolated,
        terminalTmuxSessionName,
        terminalTmuxTmpDir,
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

    const setTmuxOverrideUseTmux = useCallback((next: boolean) => {
        if (next && tmuxAvailable === false) {
            Modal.alert(t('common.error'), t('machine.tmux.notDetectedMessage'));
            return;
        }
        updateTmuxOverride({ useTmux: next });
    }, [tmuxAvailable, updateTmuxOverride]);

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
                const result = await machineRevokeWithProviderCleanup(machineId, {
                    revoke: machineRevokeFromAccount,
                    mutateProviderSettings: async (mutate) => {
                        await sync.mutateAccountSettings((raw) => {
                            const current = readProviderSettingsFromAccountSettingsV1(raw).settings;
                            return { ...raw, providerSettingsV1: mutate(current) };
                        });
                    },
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
    }, [isRevokingMachine, machine?.revokedAt, machineId, providerCleanupPending, router]);

    const replacementCandidates = useMemo<MachineReplacementPickerCandidate[]>(() => {
        if (!machineId) return [];
        return allMachines
            .filter((candidate) => candidate.id !== machineId)
            .filter((candidate) => !candidate.revokedAt)
            .filter((candidate) => !candidate.replacedByMachineId)
            .map((candidate) => {
                const label = resolveMachineReplacementCandidateLabel(candidate);
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

        return sessions.filter(item => {
            if (typeof item === 'string') return false;
            const session = item as Session;
            const ownerMetadata = readSessionOwnerMetadataView(session);
            return readDisplayMachineIdForSession({
                sessionId: session.id,
                metadata: ownerMetadata,
            }) === machineId;
        }) as Session[];
    }, [sessions, machineId]);

    const previousSessions = useMemo(() => {
        return [...machineSessions]
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, 5);
    }, [machineSessions]);

    const recentPaths = useMemo(() => {
        const paths = new Set<string>();
        machineSessions.forEach(session => {
            const ownerMetadata = readSessionOwnerMetadataView(session);
            const path = readDisplayPathForSession({
                sessionId: session.id,
                metadata: ownerMetadata,
            });
            if (path) paths.add(path);
        });
        return Array.from(paths).sort();
    }, [machineSessions]);

    const pathsToShow = useMemo(() => {
        if (showAllPaths) return recentPaths;
        return recentPaths.slice(0, 5);
    }, [recentPaths, showAllPaths]);

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

    const handleRefresh = async () => {
        setIsRefreshing(true);
        try {
            await runRefreshDiagnosticAction({
                action: 'pull_to_refresh',
                screen: 'machine_detail',
            }, async () => {
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
            });
        } finally {
            setIsRefreshing(false);
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
        };
    }, [isOnline, isServerSwitching, machineId, machineServerId]);

    const refreshCapabilities = useCallback(async () => {
        if (!machineId) return;
        // On direct loads/refreshes, machine encryption/socket may not be ready yet.
        // Refreshing machines first makes this much more reliable and avoids misclassifying
        // transient failures as “not supported / update CLI”.
        await sync.refreshMachines();
        refreshDetectedCapabilities({ bypassCache: true });
    }, [machineId, refreshDetectedCapabilities]);

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

    const detectedClisTitle = useMemo(() => {
        const headerTextStyle = [
            Typography.default('regular'),
            {
                color: theme.colors.text.secondary,
                fontSize: Platform.select({ ios: 13, default: 14 }),
                lineHeight: Platform.select({ ios: 18, default: 20 }),
                letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
                textTransform: 'uppercase' as const,
                fontWeight: Platform.select({ ios: 'normal', default: '500' }) as any,
            },
        ];

        const canRefresh = isOnline && detectedCapabilities.status !== 'loading';

        return (
            <ItemGroupTitleWithAction
                title={t('machine.detectedClis')}
                titleStyle={headerTextStyle as any}
                action={{
                    accessibilityLabel: t('common.refresh'),
                    iconName: 'refresh',
                    iconColor: isOnline ? theme.colors.text.secondary : theme.colors.border.default,
                    disabled: !canRefresh,
                    loading: detectedCapabilities.status === 'loading',
                    onPress: () => void refreshCapabilities(),
                }}
            />
        );
    }, [
        detectedCapabilities.status,
        isOnline,
        machine,
        refreshCapabilities,
        theme.colors.border.default,
        theme.colors.text.secondary,
        theme.colors.text.secondary,
    ]);

    const handleRenameMachine = async () => {
        if (!machine || !machineId) return;

        const newDisplayName = await Modal.prompt(
            t('machine.renameTitle'),
            t('machine.renameDescription'),
            {
                defaultValue: machine.metadata?.displayName || '',
                placeholder: machine.metadata?.host || t('machine.renamePlaceholder'),
                cancelText: t('common.cancel'),
                confirmText: t('common.rename')
            }
        );

        if (newDisplayName !== null) {
            setIsRenamingMachine(true);
            try {
                const updatedMetadata = {
                    ...machine.metadata!,
                    displayName: newDisplayName.trim() || undefined
                };
                
                await machineUpdateMetadata(
                    machineId,
                    updatedMetadata,
                    machine.metadataVersion
                );
                
                Modal.alert(t('common.success'), t('machine.renamedSuccess'));
            } catch (error) {
                Modal.alert(
                    t('common.error'),
                    error instanceof Error ? error.message : t('machine.renameFailed')
                );
                // Refresh to get latest state
                await sync.refreshMachines();
            } finally {
                setIsRenamingMachine(false);
            }
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

    const handleStartSession = async (approvedNewDirectoryCreation: boolean = false): Promise<void> => {
        if (!machine || !machineId) return;
        try {
            const pathToUse = (customPath.trim() || '~');
            if (!machineCanSpawn) return;
            setIsSpawning(true);
            const absolutePath = resolveAbsolutePath(pathToUse, machine?.metadata?.homeDir);
            const terminal = resolveTerminalSpawnOptions({
                settings: storage.getState().settings,
                machineId,
            });
            const spawnOptions = {
                machineId: machineId!,
                ...(machineServerId ? { serverId: machineServerId } : {}),
                directory: absolutePath,
                approvedNewDirectoryCreation,
                backendTarget: preferredBackendTarget,
                terminal,
                ...(effectiveWindowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode } : {}),
            } as const;
            const launchSignature = JSON.stringify({
                machineId,
                serverId: machineServerId ?? null,
                directory: absolutePath,
                backendTarget: preferredBackendTarget,
                terminal,
                windowsRemoteSessionLaunchMode: effectiveWindowsRemoteSessionLaunchMode ?? null,
            });
            spawnAttemptRef.current = resolveMachineDetailSpawnAttempt({
                current: spawnAttemptRef.current,
                signature: launchSignature,
                createUserAttemptId: createUiSessionSpawnUserAttemptId,
                createSpawnNonce: createUiSessionSpawnNonce,
            });
            const result = await machineSpawnNewSession({
                ...spawnOptions,
                userAttemptId: spawnAttemptRef.current.userAttemptId,
                spawnNonce: spawnAttemptRef.current.spawnNonce,
            });
            switch (result.type) {
                case 'success':
                    if (result.spawnAttemptCustody?.status === 'completed') {
                        const completed = await completeMachineSpawnAttemptCustody(result.spawnAttemptCustody);
                        if (!completed) {
                            throw new Error('Created session custody could not be completed.');
                        }
                    }
                    spawnAttemptRef.current = null;
                    // Dismiss machine picker & machine detail screen
                    router.back();
                    router.back();
                    if (result.sessionId) {
                        navigateToSession(result.sessionId);
                    } else {
                        Modal.alert(t('common.error'), t('newSession.failedToStart'));
                    }
                    break;
                case 'requestToApproveDirectoryCreation': {
                    const approved = await Modal.confirm(
                        t('newSession.directoryDoesNotExist'),
                        t('newSession.createDirectoryConfirm', { directory: result.directory }),
                        { cancelText: t('common.cancel'), confirmText: t('common.create') }
                    );
                    if (approved) {
                        await handleStartSession(true);
                    }
                    break;
                }
                case 'error':
                    if (result.spawnAttemptCustody?.status !== 'unresolved') {
                        spawnAttemptRef.current = null;
                    }
                    Modal.alert(t('common.error'), result.errorMessage);
                    break;
            }
        } catch (error) {
            let errorMessage = t('newSession.failedToStart');
            if (error instanceof Error && !error.message.includes('Failed to spawn session')) {
                errorMessage = error.message;
            }
            Modal.alert(t('common.error'), errorMessage);
        } finally {
            setIsSpawning(false);
        }
    };

    const handleBrowseCustomPath = useCallback(async () => {
        if (!machineId || !machineCanSpawn) return;
        const selected = await openMachinePathBrowserModal({
            machineId,
            serverId: activeServerId,
            initialPath: resolveAbsolutePath(customPath, machine?.metadata?.homeDir ?? ''),
            title: t('machine.launchNewSessionInDirectory'),
        });
        if (!selected) return;
        setCustomPath(formatPathRelativeToHome(selected, machine?.metadata?.homeDir));
        setTimeout(() => inputRef.current?.focus(), 50);
    }, [activeServerId, customPath, machine?.metadata?.homeDir, machineCanSpawn, machineId]);

    const pastUsedRelativePath = useCallback((session: Session) => {
        return getSessionSubtitle(session);
    }, []);

    const headerBackTitle = t('machine.back');

    const notFoundScreenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle: '',
            headerBackTitle,
        } as const;
    }, [headerBackTitle]);

    const machineName =
        machine?.metadata?.displayName ||
        machine?.metadata?.host ||
        t('machine.unknownMachine');
    const machineIsOnline = machine ? isMachineOnline(machine) : false;

    const headerTitle = React.useCallback(() => {
        if (!machine) return null;
        return (
            <View>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons
                        name="desktop-outline"
                        size={18}
                        color={theme.colors.chrome.header.foreground}
                        style={{ marginRight: 6 }}
                    />
                    <Text style={[Typography.default('semiBold'), { fontSize: 17, color: theme.colors.chrome.header.foreground }]}>
                        {machineName}
                    </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                    <View style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: machineIsOnline ? '#34C759' : '#999',
                        marginRight: 4
                    }} />
                    <Text style={[Typography.default(), {
                        fontSize: 12,
                        color: machineIsOnline ? '#34C759' : '#999'
                    }]}>
                        {machineIsOnline ? t('status.online') : t('status.offline')}
                    </Text>
                </View>
            </View>
        );
    }, [machineIsOnline, machine, machineName, theme.colors.chrome.header.foreground]);

    const headerRight = React.useCallback(() => {
        if (!machine) return null;
        return (
            <Pressable
                onPress={handleRenameMachine}
                hitSlop={10}
                style={{
                    opacity: isRenamingMachine ? 0.5 : 1
                }}
                disabled={isRenamingMachine}
            >
                <Octicons
                    name="pencil"
                    size={20}
                    color={theme.colors.text.primary}
                />
            </Pressable>
        );
    }, [handleRenameMachine, isRenamingMachine, machine, theme.colors.text.primary]);

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerRight,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerRight, headerTitle]);

    if (!machine) {
        if (isHydratingMachine) {
            return (
                <>
                    <Stack.Screen
                        options={notFoundScreenOptions}
                    />
                    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                        <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                        <Text style={[Typography.default(), { fontSize: 16, color: theme.colors.text.secondary, marginTop: 12 }]}>
                            {t('common.loading')}
                        </Text>
                    </View>
                </>
            );
        }
        return (
            <>
                <Stack.Screen
                    options={notFoundScreenOptions}
                />
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <Text style={[Typography.default(), { fontSize: 16, color: theme.colors.text.secondary }]}>
                        {t('machine.notFound')}
                    </Text>
                </View>
            </>
        );
    }

    const spawnButtonDisabled = !customPath.trim() || isSpawning || !machineCanSpawn;

    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            <ItemList
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                    />
                }
                keyboardShouldPersistTaps="handled"
            >
                {/* Launch section */}
                {machine && (
                    <>
                        {!machineCanSpawn && (
                            <ItemGroup>
                                <Item
                                    title={t('machine.offlineUnableToSpawn')}
                                    subtitle={t('machine.offlineHelp')}
                                    subtitleLines={0}
                                    showChevron={false}
                                />
                            </ItemGroup>
                        )}
                        <ItemGroup title={t('machine.launchNewSessionInDirectory')}>
                        <View style={{ opacity: machineCanSpawn ? 1 : 0.5 }}>
                            <View style={styles.pathInputContainer}>
                                <PathInputBrowseButton
                                    onPress={handleBrowseCustomPath}
                                    disabled={!machineCanSpawn}
                                />
                                <View style={[styles.pathInput, { paddingVertical: 8 }]}>
                                    <MultiTextInput
                                        ref={inputRef}
                                        value={customPath}
                                        onChangeText={setCustomPath}
                                        placeholder={t('machine.customPathPlaceholder')}
                                        maxHeight={76}
                                        paddingTop={8}
                                        paddingBottom={8}
                                        paddingRight={48}
                                    />
                                    <Pressable
                                        onPress={() => handleStartSession()}
                                        disabled={spawnButtonDisabled}
                                        style={[
                                            styles.inlineSendButton,
                                            spawnButtonDisabled ? styles.inlineSendInactive : styles.inlineSendActive
                                        ]}
                                    >
                                        <Ionicons
                                            name="play"
                                            size={16}
                                            color={spawnButtonDisabled ? theme.colors.text.secondary : theme.colors.button.primary.tint}
                                            style={{ marginLeft: 1 }}
                                        />
                                    </Pressable>
                                </View>
                            </View>
                            <View style={{ paddingTop: 4 }} />
                            {pathsToShow.map((path, index) => {
                                const display = formatPathRelativeToHome(path, machine.metadata?.homeDir);
                                const isSelected = customPath.trim() === display;
                                const isLast = index === pathsToShow.length - 1;
                                const hideDivider = isLast && pathsToShow.length <= 5;
                                return (
                                    <Item
                                        key={path}
                                        title={display}
                                        leftElement={<Ionicons name="folder-outline" size={18} color={theme.colors.text.secondary} />}
                                        onPress={machineCanSpawn ? () => {
                                            setCustomPath(display);
                                            setTimeout(() => inputRef.current?.focus(), 50);
                                        } : undefined}
                                        disabled={!machineCanSpawn}
                                        selected={isSelected}
                                        showChevron={false}
                                        showDivider={!hideDivider}
                                    />
                                );
                            })}
                            {recentPaths.length > 5 && (
                                <Item
                                    title={showAllPaths ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: recentPaths.length })}
                                    onPress={() => setShowAllPaths(!showAllPaths)}
                                    showChevron={false}
                                    showDivider={false}
                                    titleStyle={{
                                        textAlign: 'center',
                                        color: (theme as any).dark ? theme.colors.button.primary.tint : theme.colors.button.primary.background
                                    }}
                                />
                            )}
                        </View>
                        </ItemGroup>
                    </>
                )}

                {/* Machine-specific tmux override */}
                {!!machineId && (
                    <ItemGroup title={t('profiles.tmux.title')}>
                        <Item
                            title={t('machine.tmux.overrideTitle')}
                            subtitle={tmuxOverrideEnabled ? t('machine.tmux.overrideEnabledSubtitle') : t('machine.tmux.overrideDisabledSubtitle')}
                            rightElement={<Switch value={tmuxOverrideEnabled} onValueChange={setTmuxOverrideEnabled} />}
                            showChevron={false}
                            onPress={() => setTmuxOverrideEnabled(!tmuxOverrideEnabled)}
                        />

                                {tmuxOverrideEnabled && tmuxOverride && (
                            <>
                                <Item
                                    title={t('profiles.tmux.spawnSessionsTitle')}
                                    subtitle={
                                        tmuxAvailable === false
                                            ? t('machine.tmux.notDetectedSubtitle')
                                            : (tmuxOverride.useTmux ? t('profiles.tmux.spawnSessionsEnabledSubtitle') : t('profiles.tmux.spawnSessionsDisabledSubtitle'))
                                    }
                                    rightElement={
                                        <Switch
                                            value={tmuxOverride.useTmux}
                                            onValueChange={setTmuxOverrideUseTmux}
                                            disabled={tmuxAvailable === false && !tmuxOverride.useTmux}
                                        />
                                    }
                                    showChevron={false}
                                    onPress={() => setTmuxOverrideUseTmux(!tmuxOverride.useTmux)}
                                />

                                {tmuxOverride.useTmux && (
                                    <>
                                        <View style={[styles.tmuxInputContainer, { paddingTop: 0 }]}>
                                            <Text style={styles.tmuxFieldLabel}>
                                                {t('profiles.tmuxSession')} ({t('common.optional')})
                                            </Text>
                                            <TextInput
                                                style={styles.tmuxTextInput}
                                                placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                                placeholderTextColor={theme.colors.input.placeholder}
                                                value={tmuxOverride.sessionName}
                                                onChangeText={(value) => updateTmuxOverride({ sessionName: value })}
                                            />
                                        </View>

                                        <Item
                                            title={t('profiles.tmux.isolatedServerTitle')}
                                            subtitle={tmuxOverride.isolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                            rightElement={<Switch value={tmuxOverride.isolated} onValueChange={(next) => updateTmuxOverride({ isolated: next })} />}
                                            showChevron={false}
                                            onPress={() => updateTmuxOverride({ isolated: !tmuxOverride.isolated })}
                                        />

                                        {tmuxOverride.isolated && (
                                            <View style={[styles.tmuxInputContainer, { paddingTop: 0, paddingBottom: 16 }]}>
                                                <Text style={styles.tmuxFieldLabel}>
                                                    {t('profiles.tmuxTempDir')} ({t('common.optional')})
                                                </Text>
                                                <TextInput
                                                    style={styles.tmuxTextInput}
                                                    placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                                    placeholderTextColor={theme.colors.input.placeholder}
                                                    value={tmuxOverride.tmpDir ?? ''}
                                                    onChangeText={(value) => updateTmuxOverride({ tmpDir: value.trim().length > 0 ? value : null })}
                                                    autoCapitalize="none"
                                                    autoCorrect={false}
                                                />
                                            </View>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </ItemGroup>
                )}

                {/* Windows-specific settings */}
                {!!machineId && isWindowsMachine && (
                    <ItemGroup title={t('machine.windows.title')}>
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
                                    icon: <Ionicons name="logo-windows" size={29} color={theme.colors.accent.blue} />,
                                }}
                                rowKind="item"
                                connectToTrigger
                                variant="default"
                            />
                        ) : null}
                    </ItemGroup>
                )}

                {/* Detected CLIs */}
                <ItemGroup title={detectedClisTitle}>
                    <DetectedClisList state={detectedCapabilities} />
                </ItemGroup>

                <ItemGroup title={t('machine.tools.title')}>
                    <Item
                        title={t('machine.tools.installablesTitle')}
                        subtitle={t('machine.tools.installablesSubtitle')}
                        showChevron={true}
                        onPress={() => {
                            if (!machineId) return;
                            router.push(`/machine/${encodeURIComponent(machineId)}/installables?serverId=${encodeURIComponent(activeServerId)}`);
                        }}
                    />
                </ItemGroup>

                {/* Daemon */}
                <ItemGroup title={t('machine.daemon')}>
                        <Item
                            title={t('machine.status')}
                            detail={daemonStatusLabel}
                            detailStyle={{
                                color: daemonStatus === 'likelyAlive' ? '#34C759' : '#FF9500'
                            }}
                            showChevron={false}
                        />
                        <Item
                            title={t('machine.stopDaemon')}
                            titleStyle={{ 
                                color: daemonStatus === 'stopped' ? '#999' : '#FF9500' 
                            }}
                            onPress={daemonStatus === 'stopped' ? undefined : handleStopDaemon}
                            disabled={isStoppingDaemon || daemonStatus === 'stopped'}
                            rightElement={
                                isStoppingDaemon ? (
                                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                ) : (
                                    <Ionicons 
                                        name="stop-circle" 
                                        size={20} 
                                        color={daemonStatus === 'stopped' ? '#999' : '#FF9500'} 
                                    />
                                )
                            }
                        />
                        {machine.daemonState && (
                            <>
                                {machine.daemonState.pid && (
                                    <Item
                                        title={t('machine.lastKnownPid')}
                                        subtitle={String(machine.daemonState.pid)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                {machine.daemonState.httpPort && (
                                    <Item
                                        title={t('machine.lastKnownHttpPort')}
                                        subtitle={String(machine.daemonState.httpPort)}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                                {machine.daemonState.startTime && (
                                    <Item
                                        title={t('machine.startedAt')}
                                        subtitle={new Date(machine.daemonState.startTime).toLocaleString()}
                                    />
                                )}
                                {machine.daemonState.startedWithCliVersion && (
                                    <Item
                                        title={t('machine.cliVersion')}
                                        subtitle={machine.daemonState.startedWithCliVersion}
                                        subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                                    />
                                )}
                            </>
                        )}
                        <Item
                            title={t('machine.daemonStateVersion')}
                            subtitle={String(machine.daemonStateVersion)}
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

                {/* Execution runs */}
                {executionRunsState.status !== 'idle' && (
                    <ItemGroup title={t('runs.title')}>
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
                                subtitle={t('runs.empty')}
                                subtitleStyle={{ color: theme.colors.text.secondary }}
                                showChevron={false}
                            />
                        ) : (
                            (() => {
                                const visibleRuns = showFinishedRuns
                                    ? executionRunsState.runs
                                    : executionRunsState.runs.filter((r) => r.status === 'running');

                                const grouped = new Map<string, DaemonExecutionRunEntry[]>();
                                for (const run of visibleRuns) {
                                    const key = run.happySessionId;
                                    const list = grouped.get(key) ?? [];
                                    list.push(run);
                                    grouped.set(key, list);
                                }
                                const orderedSessionIds = Array.from(grouped.keys()).sort();

                                return orderedSessionIds.flatMap((sessionId) => {
                                    const runs = grouped.get(sessionId) ?? [];
                                    runs.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));

                                    const header = (
                                        <Item
                                            key={`sess-${sessionId}`}
                                            title={t('runs.sessionTitle', { sessionId })}
                                            subtitle={t('runs.openSession')}
                                            subtitleStyle={{ color: theme.colors.text.secondary }}
                                            onPress={() => navigateToSession(sessionId)}
                                            rightElement={<Ionicons name="chevron-forward" size={20} color={theme.colors.text.secondary} />}
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

                                        const canStop = run.status === 'running';
                                        const onStop = async () => {
                                            if (!machineId) return;
                                            if (!canStop) return;
                                            setStoppingRunId(run.runId);
                                            const stopSessionProcess = async () => {
                                                const stopResult = await machineStopSession(machineId, run.happySessionId, { serverId: machineServerId });
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
                                                    run.happySessionId,
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
                                                onPress={() => router.push(`/session/${run.happySessionId}/runs/${run.runId}` as any)}
                                                rightAccessory={canStop ? (
                                                    <Pressable
                                                        accessibilityRole="button"
                                                        accessibilityLabel={t('runs.stop.stopRunA11y')}
                                                        onPress={onStop}
                                                        disabled={stoppingRunId === run.runId}
                                                        style={({ pressed }) => ({
                                                            opacity: pressed ? 0.7 : 1,
                                                        })}
                                                    >
                                                        {stoppingRunId === run.runId ? (
                                                            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                                                        ) : (
                                                            <Ionicons name="stop-circle-outline" size={20} color={theme.colors.accent.orange} />
                                                        )}
                                                    </Pressable>
                                                ) : null}
                                            />
                                        );
                                    });

                                    return [header, ...rows];
                                });
                            })()
                        )}
                    </ItemGroup>
                )}

                {/* Previous Sessions (debug view) */}
                {previousSessions.length > 0 && (
                    <ItemGroup title={t('machine.previousSessionsTitle')}>
                        {previousSessions.map(session => (
                            <Item
                                key={session.id}
                                title={getSessionName(session)}
                                subtitle={getSessionSubtitle(session)}
                                onPress={() => navigateToSession(session.id)}
                                rightElement={<Ionicons name="chevron-forward" size={20} color={theme.colors.text.secondary} />}
                            />
                        ))}
                    </ItemGroup>
                )}

                {/* Machine */}
                <ItemGroup title={t('machine.machineGroup')}>
                        <Item
                            title={t('machine.host')}
                            subtitle={metadata?.host || machineId}
                        />
                        <Item
                            title={t('machine.machineId')}
                            subtitle={machineId}
                            subtitleStyle={{ fontFamily: 'Menlo', fontSize: 12 }}
                        />
                        {metadata?.username && (
                            <Item
                                title={t('machine.username')}
                                subtitle={metadata.username}
                            />
                        )}
                        {metadata?.homeDir && (
                            <Item
                                title={t('machine.homeDirectory')}
                                subtitle={metadata.homeDir}
                                subtitleStyle={{ fontFamily: 'Menlo', fontSize: 13 }}
                            />
                        )}
                        {metadata?.platform && (
                            <Item
                                title={t('machine.platform')}
                                subtitle={metadata.platform}
                            />
                        )}
                        {metadata?.arch && (
                            <Item
                                title={t('machine.architecture')}
                                subtitle={metadata.arch}
                            />
                        )}
                        <Item
                            title={t('machine.lastSeen')}
                            subtitle={machine.activeAt ? new Date(machine.activeAt).toLocaleString() : t('machine.never')}
                        />
                        <Item
                            title={t('machine.metadataVersion')}
                            subtitle={String(machine.metadataVersion)}
                        />
                </ItemGroup>

                <ItemGroup title={t('common.actions')}>
                    {machine.replacedByMachineId ? (
                        <Item
                            testID="machine-replacement-repair-undo"
                            title={t('machine.replacementRepair.undo')}
                            subtitle={t('machine.replacementRepair.undoSubtitle', { machine: machine.replacedByMachineId })}
                            subtitleLines={0}
                            showChevron={false}
                            disabled={isClearingReplacement}
                            loading={isClearingReplacement}
                            onPress={handleClearReplacement}
                        />
                    ) : replacementCandidates.length > 0 ? (
                        <Item
                            testID="machine-replacement-repair-open"
                            title={t('machine.replacementRepair.replaceWithMachine')}
                            subtitle={t('machine.replacementRepair.chooseReplacementSubtitle')}
                            subtitleLines={0}
                            showChevron
                            disabled={replacingMachineId !== null}
                            loading={replacingMachineId !== null}
                            onPress={handleOpenReplacementPicker}
                        />
                    ) : null}
                    <Item
                        title={t('machine.actions.removeMachine')}
                        subtitle={providerCleanupPending
                            ? t('settingsProviders.errors.machineCleanupPendingDescription')
                            : machine.revokedAt
                                ? t('machine.actions.removeMachineAlreadyRemoved')
                                : t('machine.actions.removeMachineSubtitle')}
                        subtitleLines={0}
                        destructive
                        showChevron={false}
                        disabled={isRevokingMachine || (Boolean(machine.revokedAt) && !providerCleanupPending)}
                        loading={isRevokingMachine}
                        onPress={handleRevokeMachine}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
