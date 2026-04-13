import * as React from 'react';

import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';

type UseNewSessionAgentPickerEngineSelectionStateParams = Readonly<{
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    modelMode: ModelMode;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
}>;

export function useNewSessionAgentPickerEngineSelectionState(
    params: UseNewSessionAgentPickerEngineSelectionStateParams,
): Readonly<{
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
}> {
    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, NewSessionAgentPickerSelection>());
    const selectedTargetKey = params.selectedBackendEntry?.targetKey ?? params.selectedBackendTargetKey;

    const buildInitialEngineSelection = React.useCallback((targetKey: string): NewSessionAgentPickerSelection => ({
        modelId: targetKey === selectedTargetKey ? String(params.modelMode) : 'default',
        sessionModeId: targetKey === selectedTargetKey
            ? (params.acpSessionModeId ?? 'default')
            : 'default',
        configOverrides: targetKey === selectedTargetKey
            ? Object.fromEntries(
                Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                    .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                    .filter(([, value]) => value.length > 0),
            )
            : {},
    }), [
        params.acpSessionModeId,
        params.modelMode,
        params.sessionConfigOptionOverrides?.overrides,
        selectedTargetKey,
    ]);

    React.useEffect(() => {
        engineSelectionByTargetKeyRef.current.set(selectedTargetKey, buildInitialEngineSelection(selectedTargetKey));
    }, [buildInitialEngineSelection, selectedTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => {
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

    const selectEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => {
        engineSelectionByTargetKeyRef.current.set(entry.targetKey, selection);
        applyEngineSelection(entry, selection);
    }, [applyEngineSelection]);

    return {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    };
}
