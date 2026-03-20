import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import { NewSessionEngineOptionDetail } from '@/components/sessions/new/components/NewSessionEngineOptionDetail';
import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

type EngineSelection = Readonly<{
    modelId: string;
    sessionModeId: string;
    configOverrides: Readonly<Record<string, string>>;
}>;

export function useNewSessionAgentPickerControls(params: Readonly<{
    useProfiles: boolean;
    selectedProfileId: string | null;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    resolvedBackendEntries: readonly ResolvedBackendCatalogEntry[];
    getCompatibleProfileBackendEntries: (profile: AIBackendProfile) => readonly ResolvedBackendCatalogEntry[];
    isBackendEntrySelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    selectedMachineId: string | null;
    capabilityServerId: string;
    selectedPath: string | null;
    handleProfileClick: () => void;
}>): Readonly<{
    agentPickerOptions?: ReadonlyArray<AgentInputChipPickerOption>;
    handleAgentPickerSelect: (selectedId: string) => void;
    handleAgentClick: () => void;
}> {
    const profileForAgentSelection = React.useMemo(() => {
        if (!params.useProfiles || params.selectedProfileId === null) return null;
        return params.profileMap.get(params.selectedProfileId) || getBuiltInProfile(params.selectedProfileId);
    }, [params.profileMap, params.selectedProfileId, params.useProfiles]);

    const candidateBackendEntries = React.useMemo(() => {
        return profileForAgentSelection
            ? params.getCompatibleProfileBackendEntries(profileForAgentSelection)
            : params.resolvedBackendEntries;
    }, [params.getCompatibleProfileBackendEntries, profileForAgentSelection, params.resolvedBackendEntries]);

    const selectableBackendEntries = React.useMemo(() => {
        return candidateBackendEntries.filter((entry) => params.isBackendEntrySelectable(entry));
    }, [candidateBackendEntries, params]);

    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, EngineSelection>());

    const buildInitialEngineSelection = React.useCallback((targetKey: string): EngineSelection => ({
        modelId: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey) ? String(params.modelMode) : 'default',
        sessionModeId: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)
            ? (params.acpSessionModeId ?? 'default')
            : 'default',
        configOverrides: targetKey === (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)
            ? Object.fromEntries(
                Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                    .filter(([, value]) => value.length > 0),
            )
            : {},
    }), [
        params.acpSessionModeId,
        params.modelMode,
        params.selectedBackendEntry,
        params.selectedBackendTargetKey,
        params.sessionConfigOptionOverrides?.overrides,
    ]);

    React.useEffect(() => {
        const currentTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;
        engineSelectionByTargetKeyRef.current.set(currentTargetKey, buildInitialEngineSelection(currentTargetKey));
    }, [buildInitialEngineSelection, params.selectedBackendEntry?.targetKey, params.selectedBackendTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: EngineSelection) => {
        const nextConfigOverrides: Readonly<Record<string, string>> = selection.configOverrides ?? {};
        params.setBackendTarget(entry.target);
        params.setModelMode(selection.modelId as ModelMode);
        params.setAcpSessionModeId(selection.sessionModeId);
        if (Object.keys(nextConfigOverrides).length === 0) {
            params.setSessionConfigOptionOverrides(null);
            return;
        }
        const updatedAt = Date.now();
        params.setSessionConfigOptionOverrides(buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: Object.fromEntries(
                Object.entries(nextConfigOverrides).map(([configId, value]) => [
                    configId,
                    { updatedAt, value },
                ]),
            ),
        }));
    }, [params]);

    const agentPickerOptions = React.useMemo<ReadonlyArray<AgentInputChipPickerOption> | undefined>(() => {
        if (profileForAgentSelection && candidateBackendEntries.length <= 1) {
            return undefined;
        }
        if (selectableBackendEntries.length <= 1) {
            return undefined;
        }
        return selectableBackendEntries.map((entry) => ({
            id: entry.targetKey,
            label: entry.title,
            subtitle: entry.subtitle ?? undefined,
            onApply: () => {
                const nextSelection = getEngineSelectionForTargetKey(entry.targetKey);
                applyEngineSelection(entry, nextSelection);
            },
            renderDetailContent: () => {
                const selection = getEngineSelectionForTargetKey(entry.targetKey);
                return (
                    <NewSessionEngineOptionDetail
                        backendTarget={entry.target}
                        selectedMachineId={params.selectedMachineId}
                        capabilityServerId={params.capabilityServerId}
                        cwd={params.selectedPath}
                        selectedModelId={selection.modelId}
                        selectedSessionModeId={selection.sessionModeId}
                        selectedConfigOverrides={selection.configOverrides}
                        onSelectionChange={(nextSelection) => {
                            engineSelectionByTargetKeyRef.current.set(entry.targetKey, nextSelection);
                        }}
                    />
                );
            },
        }));
    }, [
        profileForAgentSelection,
        candidateBackendEntries.length,
        selectableBackendEntries,
        getEngineSelectionForTargetKey,
        applyEngineSelection,
        params.selectedMachineId,
        params.capabilityServerId,
        params.selectedPath,
    ]);

    const handleAgentPickerSelect = React.useCallback((selectedId: string) => {
        const nextEntry = selectableBackendEntries.find((entry) => entry.targetKey === selectedId) ?? null;
        if (nextEntry) {
            params.setBackendTarget(nextEntry.target);
        }
    }, [params.setBackendTarget, selectableBackendEntries]);

    const handleAgentClick = React.useCallback(() => {
        if (profileForAgentSelection && candidateBackendEntries.length <= 1) {
            Modal.alert(
                t('profiles.aiBackend.title'),
                t('newSession.aiBackendSelectedByProfile'),
                [
                    { text: t('common.ok'), style: 'cancel' },
                    { text: t('newSession.changeProfile'), onPress: params.handleProfileClick },
                ],
            );
            return;
        }

        if (selectableBackendEntries.length === 0) {
            return;
        }

        if (selectableBackendEntries.length === 1) {
            const nextEntry = selectableBackendEntries[0] ?? null;
            if (nextEntry && nextEntry.targetKey !== (params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey)) {
                params.setBackendTarget(nextEntry.target);
            }
        }
    }, [
        candidateBackendEntries.length,
        params.handleProfileClick,
        params.selectedBackendEntry,
        params.selectedBackendTargetKey,
        params.setBackendTarget,
        profileForAgentSelection,
        selectableBackendEntries,
    ]);

    return {
        agentPickerOptions,
        handleAgentPickerSelect,
        handleAgentClick,
    };
}
