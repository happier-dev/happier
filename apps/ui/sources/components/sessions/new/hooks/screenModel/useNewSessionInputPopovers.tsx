import * as React from 'react';

import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import type { AgentInputContentPopoverConfig } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { NewSessionPathSelectionContent } from '@/components/sessions/new/components/NewSessionPathSelectionContent';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { useServerScopedMachineOptions } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { AgentId } from '@/agents/catalog/catalog';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { t } from '@/text';
import { openDirectSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openDirectSessionsResumeIdPickerModal';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/external/browse/resolveDirectBrowseLockedSourceOption';

const LARGE_PICKER_LAYOUT: Pick<
    AgentInputContentPopoverConfig,
    'maxHeightCap' | 'maxWidthCap' | 'keyboardShouldPersistTaps' | 'edgeFades' | 'edgeIndicators' | 'initialVisibility'
> = {
    maxHeightCap: 560,
    maxWidthCap: 560,
    keyboardShouldPersistTaps: 'handled',
    edgeFades: { top: true, bottom: true, size: 28 },
    edgeIndicators: true,
    initialVisibility: { top: true, bottom: true },
};

type DirectBrowseLockContext = Parameters<typeof resolveDirectBrowseLockedSource>[0];

export function useNewSessionInputPopovers(params: Readonly<{
    selectedMachine: Machine | null;
    selectedMachineId: string | null;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setDraftSelectedPath: (path: string) => void;
    recentPaths: ReadonlyArray<string>;
    usePathPickerSearch: boolean;
    pathPickerSearchQuery: string;
    setPathPickerSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    favoriteDirectories: ReadonlyArray<string>;
    setFavoriteDirectories: (value: string[]) => void;
    allowedTargetServerIds: ReadonlyArray<string>;
    resolvedSettingsAllowedServerIds: ReadonlyArray<string>;
    activeServerId: string;
    activeServerGeneration: number;
    activeMachines: ReadonlyArray<Machine>;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    setSelectedMachineId: React.Dispatch<React.SetStateAction<string | null>>;
    getBestPathForMachine: (machineId: string) => string;
    useMachinePickerSearch: boolean;
    targetServerId: string | null;
    directSessionsFeatureEnabled: boolean;
    resumeSessionId: string;
    setResumeSessionId: React.Dispatch<React.SetStateAction<string>>;
    agentType: AgentId;
    agentLabel: string;
    agentOptionState: DirectBrowseLockContext['agentOptionState'];
    settings: DirectBrowseLockContext['settings'];
}>): Readonly<{
    pathPopover: AgentInputContentPopoverConfig;
    machinePopover: AgentInputContentPopoverConfig;
    resumePopover: AgentInputContentPopoverConfig;
}> {
    const modalPortalTarget = useModalPortalTarget();
    const accountProfile = useAccountProfile();
    const machinePopoverServerIds = params.allowedTargetServerIds.length > 0
        ? params.allowedTargetServerIds
        : params.resolvedSettingsAllowedServerIds;
    const machinePopoverGroups = useServerScopedMachineOptions({
        allowedServerIds: machinePopoverServerIds,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        refreshToken: params.activeServerGeneration,
    });

    const pathPopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose }) => (
            <NewSessionPathSelectionContent
                machineHomeDir={params.selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={params.selectedPath}
                onChangeSelectedPath={params.setSelectedPath}
                onChangeDraftSelectedPath={params.setDraftSelectedPath}
                onBeforeBrowseMachinePath={requestClose}
                submitBehavior="confirm"
                commitDraftOnBlur={true}
                onSubmitSelectedPath={(nextPath) => {
                    params.setSelectedPath(nextPath);
                    requestClose();
                }}
                recentPaths={params.recentPaths}
                usePickerSearch={params.usePathPickerSearch}
                searchQuery={params.pathPickerSearchQuery}
                onChangeSearchQuery={params.setPathPickerSearchQuery}
                favoriteDirectories={params.favoriteDirectories}
                onChangeFavoriteDirectories={params.setFavoriteDirectories}
                focusInputOnSelect={false}
                machineBrowse={{
                    enabled: true,
                    machineId: params.selectedMachine?.id ?? null,
                    serverId: params.targetServerId ?? null,
                    webPortalTarget: modalPortalTarget,
                }}
            />
        ),
        ...LARGE_PICKER_LAYOUT,
    }), [
        modalPortalTarget,
        params.favoriteDirectories,
        params.pathPickerSearchQuery,
        params.recentPaths,
        params.selectedMachine?.id,
        params.selectedMachine?.metadata?.homeDir,
        params.selectedPath,
        params.setDraftSelectedPath,
        params.setFavoriteDirectories,
        params.setPathPickerSearchQuery,
        params.setSelectedPath,
        params.targetServerId,
        params.usePathPickerSearch,
    ]);

    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ requestClose }) => (
            <NewSessionMachineSelectionContent
                groups={machinePopoverGroups}
                selectedMachine={params.selectedMachine}
                selectedServerId={params.selectedServerId}
                recentMachines={params.recentMachines}
                favoriteMachines={params.favoriteMachineItems}
                serverId={params.selectedServerId}
                onSelectMachine={(machine) => {
                    params.setSelectedMachineId(machine.id);
                    params.setSelectedPath(params.getBestPathForMachine(machine.id));
                    requestClose();
                }}
                onSelectScopedMachine={(machine) => {
                    params.setSelectedMachineId(machine.id);
                    params.setSelectedPath(params.getBestPathForMachine(machine.id));
                    requestClose();
                }}
                showSearch={params.useMachinePickerSearch}
                searchPlacement="header"
                testIdPrefix="new-session-machine"
            />
        ),
        ...LARGE_PICKER_LAYOUT,
    }), [
        machinePopoverGroups,
        params.favoriteMachineItems,
        params.getBestPathForMachine,
        params.recentMachines,
        params.selectedMachine,
        params.selectedServerId,
        params.setSelectedMachineId,
        params.setSelectedPath,
        params.useMachinePickerSearch,
    ]);

    const resumePopover = React.useMemo<AgentInputContentPopoverConfig>(() => {
        const browseEnabled = params.directSessionsFeatureEnabled
            && Boolean(params.selectedMachineId)
            && canBrowseDirectSessions(params.agentType);
        return {
            renderContent: ({ requestClose }) => (
                <NewSessionResumeSelectionContent
                    value={params.resumeSessionId}
                    onChangeValue={params.setResumeSessionId}
                    onSave={(nextValue) => {
                        params.setResumeSessionId(nextValue);
                        requestClose();
                    }}
                    onClear={() => {
                        params.setResumeSessionId('');
                        requestClose();
                    }}
                    onClose={requestClose}
                    agentType={params.agentType}
                    agentLabel={params.agentLabel}
                    maxHeight={460}
                    showInlineHeader={false}
                    resumeBrowse={browseEnabled ? {
                        enabled: true,
                        onBrowse: async () => {
                            if (!params.selectedMachineId) return null;
                            const source = resolveDirectBrowseLockedSource({
                                providerId: params.agentType as any,
                                agentOptionState: params.agentOptionState,
                                profile: accountProfile,
                                settings: params.settings,
                            });
                            if (!source) return null;
                            requestClose();
                            const nextResumeSessionId = await openDirectSessionsResumeIdPickerModal({
                                title: t('directSessions.browseTitle'),
                                webPortalTarget: modalPortalTarget,
                                lockScope: {
                                    machineId: params.selectedMachineId,
                                    serverId: params.targetServerId ?? null,
                                    providerId: params.agentType as any,
                                    source,
                                },
                            });
                            if (typeof nextResumeSessionId === 'string') {
                                const trimmedResumeSessionId = nextResumeSessionId.trim();
                                if (trimmedResumeSessionId.length > 0) {
                                    params.setResumeSessionId(trimmedResumeSessionId);
                                }
                            }
                            return null;
                        },
                    } : null}
                />
            ),
            maxHeightCap: 460,
            maxWidthCap: 460,
        };
    }, [
        accountProfile,
        modalPortalTarget,
        params.agentLabel,
        params.agentOptionState,
        params.agentType,
        params.directSessionsFeatureEnabled,
        params.resumeSessionId,
        params.selectedMachineId,
        params.settings,
        params.setResumeSessionId,
        params.targetServerId,
    ]);

    return {
        pathPopover,
        machinePopover,
        resumePopover,
    };
}
