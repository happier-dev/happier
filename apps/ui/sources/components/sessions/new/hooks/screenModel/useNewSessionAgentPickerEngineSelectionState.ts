import * as React from 'react';

import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV2 } from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';

import type { NewSessionAgentPickerSelection } from './buildNewSessionAgentPickerDetailContent';

type UseNewSessionAgentPickerEngineSelectionStateParams = Readonly<{
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    modelMode: ModelMode;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV2>>;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
}>;

function areConfigOverridesEqual(
    a: Readonly<Record<string, string>> | undefined,
    b: Readonly<Record<string, string>> | undefined,
): boolean {
    const left = a ?? {};
    const right = b ?? {};
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => left[key] === right[key]);
}

function areEngineSelectionsEqual(
    a: NewSessionAgentPickerSelection,
    b: NewSessionAgentPickerSelection,
): boolean {
    return a.modelId === b.modelId
        && a.sessionModeId === b.sessionModeId
        && areConfigOverridesEqual(a.configOverrides, b.configOverrides);
}

export function useNewSessionAgentPickerEngineSelectionState(
    params: UseNewSessionAgentPickerEngineSelectionStateParams,
): Readonly<{
    getEngineSelectionForTargetKey: (targetKey: string) => NewSessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: NewSessionAgentPickerSelection) => void;
}> {
    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, NewSessionAgentPickerSelection>());
    const pendingAppliedSelectionRef = React.useRef<{
        targetKey: string;
        selection: NewSessionAgentPickerSelection;
    } | null>(null);
    const selectedTargetKey = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;

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
        const nextSelection = buildInitialEngineSelection(selectedTargetKey);
        const pendingAppliedSelection = pendingAppliedSelectionRef.current;
        if (pendingAppliedSelection?.targetKey === selectedTargetKey) {
            if (!areEngineSelectionsEqual(nextSelection, pendingAppliedSelection.selection)) {
                engineSelectionByTargetKeyRef.current.set(selectedTargetKey, pendingAppliedSelection.selection);
                return;
            }
            pendingAppliedSelectionRef.current = null;
        }

        engineSelectionByTargetKeyRef.current.set(selectedTargetKey, nextSelection);
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
        pendingAppliedSelectionRef.current = {
            targetKey: entry.backendTargetKey,
            selection,
        };
        params.setBackendTarget(entry.backendTarget);
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
        engineSelectionByTargetKeyRef.current.set(entry.backendTargetKey, selection);
        applyEngineSelection(entry, selection);
    }, [applyEngineSelection]);

    return {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    };
}
