import * as React from 'react';
import { AppHeaderCloseButton } from '@/components/navigation/AppHeaderCloseButton';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';

import { useAllMachines, useAllSessionListRenderables, useSetting, useSettingMutable, useSettingsSelector } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { getRecentMachinesFromSessions } from '@/utils/sessions/recentMachines';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { invalidateMachineEnvPresence } from '@/hooks/machine/useMachineEnvPresence';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { HeaderTitleWithAction } from '@/components/navigation/HeaderTitleWithAction';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useNewSessionServerTargetState } from '@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState';
import { useNewSessionActiveServerSource } from '@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource';
import { useNewSessionPickerRoutePresentation } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { invalidateMachinePoolProjection } from '@/sync/engine/machines/machinePoolProjection';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { useMachinePoolSelection } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import { buildMachineDestinationModel } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import {
    resolveTemporaryComputerDestinationProjectionState,
    useTemporaryComputerAvailability,
} from '@/components/sessions/new/hooks/useTemporaryComputerAvailability';
import type { RunnerArtifactTarget } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { resolveTemporaryComputerAgentCompatibility } from '@/components/sessions/new/hooks/temporaryComputerAgentCompatibility';
import { resolveTemporaryComputerLaunchBlock } from '@/components/sessions/new/hooks/temporaryComputerLaunchReadiness';
import {
    describeTemporaryComputerLaunchBlock,
    describeTemporaryComputerUnavailability,
} from '@/components/sessions/new/hooks/temporaryComputerCopy';
import { buildTemporaryComputerSelectionRows } from '@/components/sessions/new/components/machineSelection/buildTemporaryComputerSelectionRows';
import { createTemporaryComputerCreatorDependencies } from '@/components/sessions/new/hooks/creator/temporaryComputerCreatorDependencies';
import { resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';

function useMachinePickerScreenOptions(params: Readonly<{
    title: string;
    onBack: () => void;
    onRefresh: () => void;
    isRefreshing: boolean;
    theme: { colors: { chrome: { header: { foreground: string } }; text: { secondary: string } } };
}>) {
    // K2 picker route chrome: the native title plus Cancel, nothing else above the list.
    const headerLeft = React.useCallback(() => (
        <AppHeaderCloseButton
            testID="new-session-machine-picker-cancel"
            appearance="text"
            onPress={params.onBack}
        />
    ), [params.onBack]);

    const headerTitle = React.useCallback(({ tintColor }: { children: string; tintColor?: string }) => (
        <HeaderTitleWithAction
            title={params.title}
            tintColor={tintColor ?? params.theme.colors.chrome.header.foreground}
            actionLabel={t('common.refresh')}
            actionIconName="arrow-clockwise"
            actionColor={params.theme.colors.text.secondary}
            actionDisabled={params.isRefreshing}
            actionLoading={params.isRefreshing}
            onActionPress={params.onRefresh}
        />
    ), [params.isRefreshing, params.onRefresh, params.theme.colors.chrome.header.foreground, params.theme.colors.text.secondary, params.title]);
    const presentation = useNewSessionPickerRoutePresentation();

    return React.useMemo(() => ({
        headerShown: true,
        title: params.title,
        headerTitle,
        headerBackTitle: t('common.back'),
        presentation,
        headerLeft,
    }), [headerLeft, headerTitle, params.title, presentation]);
}

export function useMachinePickerScreenModel() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{
        agentType?: string;
        backendTarget?: string;
        backendTargetKey?: string;
        dataId?: string;
        draftId?: string;
        machinePoolId?: string;
        selectedId?: string;
        spawnServerId?: string;
    }>();
    const currentRouteParamsValue = pickNewSessionRouteParams(params);
    const currentRouteParamsKey = JSON.stringify(currentRouteParamsValue);
    const currentRouteParams = React.useMemo(
        () => currentRouteParamsValue,
        // Expo Router can return a new object for an unchanged route. Route values, not that
        // wrapper identity, own the callbacks exposed to navigation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [currentRouteParamsKey],
    );
    const pickerFallbackHref = React.useMemo(
        () => buildNewSessionPickerFallbackHref(currentRouteParams),
        [currentRouteParams],
    );
    const accountSettings = useSettingsSelector((settings) => ({
        serverSelectionGroups: settings.serverSelectionGroups,
        serverSelectionActiveTargetKind: settings.serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: settings.serverSelectionActiveTargetId,
    }));
    const homeViewSelectionSettings = useHomeViewSelectionSettings();
    const settings = React.useMemo(() => ({ ...accountSettings, ...homeViewSelectionSettings }), [accountSettings, homeViewSelectionSettings]);
    const activeServerSource = useNewSessionActiveServerSource();
    const machines = useAllMachines();
    const sessions = useAllSessionListRenderables();
    const useMachinePickerSearch = useSetting('useMachinePickerSearch');
    const [favoriteMachines, setFavoriteMachines] = useSettingMutable('favoriteMachines');

    const [isRefreshing, setIsRefreshing] = React.useState(false);
    const [refreshToken, setRefreshToken] = React.useState(0);
    const autoSelectedSingleMachineRef = React.useRef(false);
    const requestedMachineId = typeof params.selectedId === 'string' ? params.selectedId : null;
    const restoredExecutionTarget = React.useMemo(() => {
        const dataId = typeof params.dataId === 'string' ? params.dataId.trim() : '';
        return dataId ? peekTempData<NewSessionData>(dataId)?.executionTarget ?? null : null;
    }, [params.dataId]);
    const requestedServerId = typeof params.spawnServerId === 'string' ? params.spawnServerId.trim() : null;
    const activeServerId = activeServerSource.activeServerId;
    const {
        allowedTargetServerIds,
        resolvedSettingsTarget,
        targetServerId,
        targetServerProfile,
        rejectedRequestedServerId,
    } = useNewSessionServerTargetState({
        settings,
        activeServerId: activeServerSource.activeServerId,
        serverProfiles: activeServerSource.serverProfiles,
        request: {
            spawnServerIdParam: requestedServerId,
        },
    });
    // A route Machine ID is qualified by its requested Home. When that Home is normalized away,
    // the same opaque Machine ID on the fallback Home is not the requested target and must not be
    // silently accepted. The user may explicitly select that fallback Machine afterwards.
    const selectedMachineId = rejectedRequestedServerId ? null : requestedMachineId;
    // Keep this mounted route on the same Home-group source as Simple and Wizard. A removed exact
    // Home in Settings intentionally leaves `targetServerId` unresolved until the user chooses a
    // destination, but it must not erase the canonical fallback Homes from the picker itself.
    const destinationServerIdsInput = allowedTargetServerIds.length > 0
        ? allowedTargetServerIds
        : resolvedSettingsTarget.allowedServerIds;
    const destinationServerIdsKey = destinationServerIdsInput.join('\u0000');
    const destinationServerIds = React.useMemo(
        () => destinationServerIdsKey ? destinationServerIdsKey.split('\u0000') : [],
        [destinationServerIdsKey],
    );
    const selectedServerId = targetServerId;
    const selectedAccountScopeResolution = useServerCredentialAccountScopeResolution(selectedServerId);
    const selectedAccountScope = selectedAccountScopeResolution.kind === 'bound'
        ? selectedAccountScopeResolution.scope
        : null;
    const serverScopeRefreshToken = React.useMemo(() => {
        return `${activeServerSource.serverProfilesSignature}\u0000${refreshToken}`;
    }, [activeServerSource.serverProfilesSignature, refreshToken]);
    const serverScopedMachineGroups = useServerScopedMachineOptions({
        allowedServerIds: destinationServerIds,
        activeServerId,
        activeMachines: machines,
        refreshToken: serverScopeRefreshToken,
    });
    const machinePoolGroups = useMachinePoolGroups(serverScopedMachineGroups);
    // Route target parseability is not Runner authoring compatibility. This
    // picker composes the same creator producers the launch path uses, from the
    // same entitled catalog store, so the destination row it offers is exactly
    // the one launch can prepare and materialize. It must never advertise a
    // target launch would refuse, and must never hide one launch would accept.
    const pickerAgentTarget = React.useMemo(() => {
        const backendTarget = resolveBackendTargetFromRouteParams(params);
        return backendTarget ? resolveAgentExecutionTargetForBackendTarget({ backendTarget }) : null;
    }, [params]);
    const pickerBackendTargetKey = React.useMemo(() => {
        const backendTarget = resolveBackendTargetFromRouteParams(params);
        return backendTarget ? resolveBackendTargetKeyV2(backendTarget) : null;
    }, [params]);
    const pickerCredentialResourcesEnabled = useFeatureEnabled('teams.credentialResources', {
        scopeKind: 'spawn',
        serverId: selectedServerId,
    });
    const pickerTeamCredentialCatalog = useHomeTeamCredentialModelCatalog({
        serverId: selectedServerId,
        enabled: pickerCredentialResourcesEnabled,
    });
    const pickerCreatorDependencies = React.useMemo(() => (
        createTemporaryComputerCreatorDependencies({
            teamCredentialServerId: selectedServerId,
            teamCredentialResources: pickerTeamCredentialCatalog.resources,
            currentTeamCredentialResourceKeys: pickerTeamCredentialCatalog.currentResourceKeys,
            // The picker never launches, so it holds no model selection. Only the
            // Agent/artifact/broker intersection decides whether the row is real.
            selectedTeamCredentialModel: null,
            // This route resolves its Agent target from route params alone, so
            // it can only ever hold a bundled contribution identity; an
            // installed Agent's catalog and marketplace index belong to the New
            // Session screen's focused machine.
            agentCatalogMachineId: null,
            projectedAgentsById: {},
            installedPluginPackagesById: {},
        })
    ), [pickerTeamCredentialCatalog.currentResourceKeys, pickerTeamCredentialCatalog.resources, selectedServerId]);
    const temporaryComputerAvailability = useTemporaryComputerAvailability({
        serverId: selectedServerId,
        accountScope: selectedAccountScope,
        profile: targetServerProfile,
        interactive: true,
    });
    // Agent/broker compatibility is launch readiness, not destination
    // eligibility: it explains the row instead of deleting it. The picker holds
    // no model selection, so it reports only the authoring-side intersection.
    const temporaryComputerLaunchBlock = resolveTemporaryComputerLaunchBlock({
        ready: resolveTemporaryComputerAgentCompatibility({
            catalogEntryPresent: pickerBackendTargetKey !== null,
            canonicalAgentTargetPresent: pickerAgentTarget !== null,
            creatorReadinessProducerPresent: pickerAgentTarget !== null
                && pickerBackendTargetKey !== null
                && pickerCreatorDependencies.dependencies.isAuthoringCompatible({
                    backendTargetKey: pickerBackendTargetKey,
                    agentTarget: pickerAgentTarget,
                }),
        }),
        gaps: pickerCreatorDependencies.readGaps().filter((gap) => gap !== 'team_credential_model_unselected'),
    });
    const temporaryComputerProjectionState = resolveTemporaryComputerDestinationProjectionState(
        temporaryComputerAvailability,
    );
    const temporaryComputerRowCount = temporaryComputerAvailability.status === 'available'
        ? temporaryComputerAvailability.artifacts.length
        : 0;
    const machineDestinationModel = React.useMemo(() => buildMachineDestinationModel({
        groups: serverScopedMachineGroups,
        poolGroups: machinePoolGroups,
        temporaryComputerProjection: {
            state: temporaryComputerProjectionState,
            rowCount: temporaryComputerRowCount,
        },
    }), [machinePoolGroups, serverScopedMachineGroups, temporaryComputerProjectionState, temporaryComputerRowCount]);
    const machinesForSelectedServer = React.useMemo(() => {
        return serverScopedMachineGroups.find((group) => group.serverId === selectedServerId)?.machines ?? [];
    }, [selectedServerId, serverScopedMachineGroups]);
    const selectedMachine = React.useMemo(() => {
        if (!selectedMachineId) return null;
        return machinesForSelectedServer.find((machine) => machine.id === selectedMachineId) ?? null;
    }, [machinesForSelectedServer, selectedMachineId]);

    const handleRefresh = React.useCallback(async (refreshPools: boolean) => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        try {
            await Promise.allSettled([
                sync.refreshMachinesThrottled({ staleMs: 0, force: true }),
                ...(refreshPools
                    ? destinationServerIds.map((serverId) => invalidateMachinePoolProjection(serverId, { forceFeatures: true }))
                    : []),
            ]);

            if (selectedMachineId && selectedServerId) {
                invalidateMachineEnvPresence({ machineId: selectedMachineId, serverId: selectedServerId });
                await Promise.all([
                    prefetchMachineCapabilities({
                        machineId: selectedMachineId,
                        serverId: selectedServerId,
                        request: CAPABILITIES_REQUEST_NEW_SESSION,
                    }),
                ]);
            }
            setRefreshToken((value) => value + 1);
        } finally {
            setIsRefreshing(false);
        }
    }, [destinationServerIds, isRefreshing, selectedMachineId, selectedServerId]);
    // Recovery is a direct call into the existing owners: the canonical Pool projection refresh and
    // the existing Machine Pool settings route. No recovery queue, retry timer or status store.
    const handleRefreshPools = React.useCallback((serverId: string) => {
        fireAndForget(
            invalidateMachinePoolProjection(serverId, { forceFeatures: true }),
            { tag: 'MachinePickerScreen.refreshMachinePools' },
        );
    }, []);
    const handleOpenPoolSettings = React.useCallback((target: Readonly<{ serverId: string; poolId: string }>) => {
        router.push(`/(app)/settings/machines/pools/${encodeURIComponent(target.poolId)}?serverId=${encodeURIComponent(target.serverId)}`);
    }, [router]);
    const handleRefreshPress = React.useCallback(() => {
        fireAndForget(handleRefresh(true), { tag: 'MachinePickerScreen.refreshMachinesAndCapabilities' });
    }, [handleRefresh]);
    const handleRefreshMachinesPress = React.useCallback(() => {
        fireAndForget(handleRefresh(false), { tag: 'MachinePickerScreen.refreshMachines' });
    }, [handleRefresh]);

    React.useEffect(() => {
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'MachinePickerScreen.refreshDestinationsOnMount' });
    }, [destinationServerIds]);

    const commitExactMachine = React.useCallback((
        machineId: string,
        resolvedServerId: string | null,
        machinePoolId?: string,
    ) => {
        const dataId = typeof params.dataId === 'string' ? params.dataId : undefined;

        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                machineId,
                machinePoolId,
                spawnServerId: resolvedServerId,
                directory: undefined,
                path: undefined,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...(dataId ? { dataId } : {}),
                machineId,
                machinePoolId,
                ...(resolvedServerId ? { spawnServerId: resolvedServerId } : {}),
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [activeServerId, currentRouteParams, navigation, params.dataId, pickerFallbackHref, router, selectedServerId]);

    const poolSelection = useMachinePoolSelection({
        requestKey: typeof params.draftId === 'string' ? params.draftId : '',
        requestKeyAlreadyConsumed: (
            typeof params.machinePoolId === 'string'
            && params.machinePoolId.trim().length > 0
        ) || (
            restoredExecutionTarget?.kind === 'machine'
            && restoredExecutionTarget.selectionOrigin?.kind === 'machine_pool'
        ),
        scopeKey: `${selectedServerId ?? ''}\u0000${selectedMachineId ?? ''}`,
        onResolved: (target) => commitExactMachine(target.machineId, target.serverId, target.poolId),
    });

    const handleSelectTemporaryComputer = React.useCallback((
        artifactTarget: RunnerArtifactTarget,
        workspace: Extract<NonNullable<typeof restoredExecutionTarget>, { kind: 'temporary_computer' }>['workspace'],
        packageExpiresAt: number | undefined,
    ) => {
        if (!selectedServerId) return;
        poolSelection.cancelPendingSelection();
        const executionTarget = {
            kind: 'temporary_computer' as const,
            serverId: selectedServerId,
            artifactTarget,
            workspace,
            // Omitted is Never, the default. An explicit instant is written only
            // when the author chose one.
            ...(packageExpiresAt !== undefined ? { packageExpiresAt } : {}),
        };
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            authoringExecutionTarget: executionTarget,
            routeParams: {
                machineId: undefined,
                machinePoolId: undefined,
                spawnServerId: selectedServerId,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                machineId: undefined,
                machinePoolId: undefined,
                spawnServerId: selectedServerId,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [currentRouteParams, navigation, pickerFallbackHref, poolSelection.cancelPendingSelection, router, selectedServerId]);

    const handleSelectMachine = React.useCallback((machine: typeof machines[0] & { serverId?: string }) => {
        poolSelection.cancelPendingSelection();
        const machineServerId = typeof machine.serverId === 'string' ? machine.serverId.trim() : '';
        commitExactMachine(machine.id, machineServerId || selectedServerId || activeServerId);
    }, [activeServerId, commitExactMachine, poolSelection.cancelPendingSelection, selectedServerId]);

    const handleBack = React.useCallback(() => {
        poolSelection.cancelPendingSelection();
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [navigation, pickerFallbackHref, poolSelection.cancelPendingSelection, router]);

    const screenOptions = useMachinePickerScreenOptions({
        title: t('newSession.selectMachineTitle'),
        onBack: handleBack,
        onRefresh: handleRefreshPress,
        isRefreshing,
        theme,
    });

    React.useEffect(() => {
        poolSelection.cancelPendingSelection();
    }, [poolSelection.cancelPendingSelection, selectedServerId]);

    React.useEffect(() => {
        if (autoSelectedSingleMachineRef.current) return;
        if (rejectedRequestedServerId) return;
        if (selectedMachineId) return;
        if (!selectedServerId) return;
        // Completeness and exact row counting stay with the list's canonical destination owner.
        const onlyMachine = machineDestinationModel.soleSelectableDestination;
        if (!onlyMachine || onlyMachine.serverId !== selectedServerId) return;
        autoSelectedSingleMachineRef.current = true;
        void handleSelectMachine(onlyMachine.machine);
    }, [handleSelectMachine, machineDestinationModel, rejectedRequestedServerId, selectedMachineId, selectedServerId]);

    const recentMachines = React.useMemo(() => {
        return getRecentMachinesFromSessions({ machines: machinesForSelectedServer, sessions });
    }, [sessions, machinesForSelectedServer]);

    const favoriteMachineItems = React.useMemo(() => {
        return machinesForSelectedServer.filter((machine) => favoriteMachines.includes(machine.id));
    }, [favoriteMachines, machinesForSelectedServer]);

    const onToggleFavorite = React.useCallback((machine: Machine) => {
        const isInFavorites = favoriteMachines.includes(machine.id);
        setFavoriteMachines(isInFavorites
            ? favoriteMachines.filter((id: string) => id !== machine.id)
            : [...favoriteMachines, machine.id],
        );
    }, [favoriteMachines, setFavoriteMachines]);

    const temporaryComputerSelections = React.useMemo(() => buildTemporaryComputerSelectionRows({
        serverId: selectedServerId,
        availability: temporaryComputerAvailability,
        selectedTarget: !selectedMachineId && restoredExecutionTarget?.kind === 'temporary_computer'
            ? restoredExecutionTarget
            : null,
        launchBlockText: temporaryComputerLaunchBlock
            ? describeTemporaryComputerLaunchBlock(temporaryComputerLaunchBlock)
            : null,
        unavailableText: describeTemporaryComputerUnavailability(temporaryComputerAvailability)
            ?? t('newSession.temporaryComputer.unavailable.platformRetired'),
        onSelect: handleSelectTemporaryComputer,
    }), [
        handleSelectTemporaryComputer,
        restoredExecutionTarget,
        selectedMachineId,
        selectedServerId,
        temporaryComputerAvailability,
        temporaryComputerLaunchBlock,
    ]);

    const content = React.useMemo(() => (
        <NewSessionMachineSelectionContent
            groups={serverScopedMachineGroups}
            poolGroups={machinePoolGroups}
            selectedMachine={selectedMachine}
            selectedServerId={selectedServerId}
            recentMachines={recentMachines}
            favoriteMachines={favoriteMachineItems}
            onSelectMachine={handleSelectMachine}
            onSelectScopedMachine={handleSelectMachine}
            onSelectPool={poolSelection.selectPool}
            temporaryComputers={temporaryComputerSelections}
            poolSelectionStatus={poolSelection.status}
            onRefreshMachines={handleRefreshMachinesPress}
            onRefreshPools={handleRefreshPools}
            onOpenPoolSettings={handleOpenPoolSettings}
            onDismissPoolSelection={poolSelection.cancelPendingSelection}
            serverId={selectedServerId}
            onToggleFavorite={onToggleFavorite}
            showSearch={useMachinePickerSearch}
            testIdPrefix="new-session-machine"
        />
    ), [
        favoriteMachineItems,
        handleSelectMachine,
        handleSelectTemporaryComputer,
        machinePoolGroups,
        onToggleFavorite,
        recentMachines,
        restoredExecutionTarget,
        selectedMachine,
        selectedMachineId,
        selectedServerId,
        serverScopedMachineGroups,
        handleOpenPoolSettings,
        handleRefreshMachinesPress,
        handleRefreshPools,
        poolSelection.cancelPendingSelection,
        poolSelection.selectPool,
        poolSelection.status,
        useMachinePickerSearch,
        temporaryComputerAvailability,
        temporaryComputerSelections,
    ]);

    return {
        screenOptions,
        content,
    } as const;
}
