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
import { openExternalSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

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

type ExternalSessionBrowseLockContext = Parameters<typeof resolveExternalSessionBrowseLockedSource>[0];

function buildNewSessionPopoverSignature(value: unknown): string {
    try {
        return JSON.stringify(value) ?? 'null';
    } catch {
        return 'unserializable';
    }
}

function useLatestRef<Value>(value: Value): React.MutableRefObject<Value> {
    const ref = React.useRef(value);
    ref.current = value;
    return ref;
}

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
    activeServerProfilesSignature: string;
    activeMachines: ReadonlyArray<Machine>;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    setSelectedMachineId: React.Dispatch<React.SetStateAction<string | null>>;
    getBestPathForMachine: (machineId: string) => string;
    useMachinePickerSearch: boolean;
    targetServerId: string | null;
    externalSessionsFeatureEnabled: boolean;
    resumeSessionId: string;
    setResumeSessionId: React.Dispatch<React.SetStateAction<string>>;
    agentType: AgentId;
    agentLabel: string;
    agentOptionState: ExternalSessionBrowseLockContext['agentOptionState'];
    settings: ExternalSessionBrowseLockContext['settings'];
    pluginProjectionV2: PluginProjectionV2 | null | undefined;
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
        refreshToken: params.activeServerProfilesSignature,
    });
    const machinePopoverRenderParamsRef = useLatestRef({
        favoriteMachineItems: params.favoriteMachineItems,
        getBestPathForMachine: params.getBestPathForMachine,
        machinePopoverGroups,
        recentMachines: params.recentMachines,
        selectedMachine: params.selectedMachine,
        selectedServerId: params.selectedServerId,
        setSelectedMachineId: params.setSelectedMachineId,
        setSelectedPath: params.setSelectedPath,
        useMachinePickerSearch: params.useMachinePickerSearch,
    });

    const pathPopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ maxHeight, requestClose }) => (
            <NewSessionPathSelectionContent
                machineHomeDir={params.selectedMachine?.metadata?.homeDir || '/home'}
                selectedPath={params.selectedPath}
                initialSuggestionMode="history"
                onChangeSelectedPath={params.setSelectedPath}
                onChangeDraftSelectedPath={params.setDraftSelectedPath}
                // Keep the path popover mounted under the tree-browser modal so
                // dismissing the browser returns to the same picker state.
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
                }}
                maxHeight={maxHeight}
            />
        ),
        ...LARGE_PICKER_LAYOUT,
        scrollEnabled: false,
        edgeFades: undefined,
        edgeIndicators: undefined,
        initialVisibility: undefined,
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

    const machinePopoverSignature = React.useMemo(() => buildNewSessionPopoverSignature({
        favoriteMachineItems: params.favoriteMachineItems,
        machinePopoverGroups,
        recentMachines: params.recentMachines,
        selectedMachineId: params.selectedMachine?.id ?? null,
        selectedServerId: params.selectedServerId,
        useMachinePickerSearch: params.useMachinePickerSearch,
    }), [
        machinePopoverGroups,
        params.favoriteMachineItems,
        params.recentMachines,
        params.selectedMachine?.id,
        params.selectedServerId,
        params.useMachinePickerSearch,
    ]);

    const machinePopover = React.useMemo<AgentInputContentPopoverConfig>(() => ({
        renderContent: ({ maxHeight, requestClose }) => {
            const renderParams = machinePopoverRenderParamsRef.current;
            return (
                <NewSessionMachineSelectionContent
                    groups={renderParams.machinePopoverGroups}
                    selectedMachine={renderParams.selectedMachine}
                    selectedServerId={renderParams.selectedServerId}
                    recentMachines={renderParams.recentMachines}
                    favoriteMachines={renderParams.favoriteMachineItems}
                    serverId={renderParams.selectedServerId}
                    onSelectMachine={(machine) => {
                        renderParams.setSelectedMachineId(machine.id);
                        renderParams.setSelectedPath(renderParams.getBestPathForMachine(machine.id));
                        requestClose();
                    }}
                    onSelectScopedMachine={(machine) => {
                        renderParams.setSelectedMachineId(machine.id);
                        renderParams.setSelectedPath(renderParams.getBestPathForMachine(machine.id));
                        requestClose();
                    }}
                    showSearch={renderParams.useMachinePickerSearch}
                    searchPlacement="header"
                    testIdPrefix="new-session-machine"
                    maxHeight={maxHeight}
                />
            );
        },
        ...LARGE_PICKER_LAYOUT,
    }), [
        machinePopoverRenderParamsRef,
        machinePopoverSignature,
    ]);

    const resumePopover = React.useMemo<AgentInputContentPopoverConfig>(() => {
        const browseEnabled = params.externalSessionsFeatureEnabled
            && Boolean(params.selectedMachineId)
            && canBrowseExternalSessions({
                agentId: params.agentType,
                projection: params.pluginProjectionV2,
            });
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
                            const source = resolveExternalSessionBrowseLockedSource({
                                providerId: params.agentType as any,
                                agentOptionState: params.agentOptionState,
                                profile: accountProfile,
                                settings: params.settings,
                                projection: params.pluginProjectionV2,
                            });
                            if (!source) return null;
                            requestClose();
                            const nextResumeSessionId = await openExternalSessionsResumeIdPickerModal({
                                title: t('directSessions.browseTitle'),
                                webPortalTarget: modalPortalTarget,
                                lockScope: {
                                    machineId: params.selectedMachineId,
                                    serverId: params.targetServerId ?? null,
                                    providerId: params.agentType,
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
        params.externalSessionsFeatureEnabled,
        params.pluginProjectionV2,
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
