import * as React from 'react';

import { buildAcpConfigOptionOverridesV1, type BackendTargetRefV2, type SessionModelSelectionV1 } from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    readRememberedEngineSelectionForTargetKey,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';

import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';

type UseNewSessionAgentPickerEngineSelectionStateParams = Readonly<{
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    modelMode: ModelMode;
    modelSelection?: SessionModelSelectionV1 | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV2>>;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<ReturnType<typeof buildAcpConfigOptionOverridesV1> | null>>;
    setEngineSelectionForBackendTarget?: (backendTargetKey: string, selection: {
        modelMode: ModelMode;
        modelSelection?: SessionModelSelectionV1 | null;
        acpSessionModeId: string | null;
        sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    }) => void;
    rememberEngineSelectionsEnabled?: boolean;
    rememberedEngineSelectionsByScope?: RememberedEngineSelectionsByScopeV1 | null;
    rememberedEngineSelectionServerId?: string | null;
    onRememberEngineSelection?: (backendTarget: BackendTargetRefV2, selection: {
        modelSelection: SessionModelSelectionV1 | null;
        acpSessionModeId: string | null;
        sessionConfigOptionOverrides: ReturnType<typeof buildAcpConfigOptionOverridesV1> | null;
    }) => void;
    onExplicitBackendTargetSelection?: (backendTarget: BackendTargetRefV2) => void;
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
    a: SessionAgentPickerSelection,
    b: SessionAgentPickerSelection,
): boolean {
    const leftRef = a.modelSelection?.ref ?? null;
    const rightRef = b.modelSelection?.ref ?? null;
    return a.modelId === b.modelId
        && leftRef?.agentTargetKey === rightRef?.agentTargetKey
        && leftRef?.providerConnectionId === rightRef?.providerConnectionId
        && leftRef?.modelId === rightRef?.modelId
        && a.sessionModeId === b.sessionModeId
        && areConfigOverridesEqual(a.configOverrides, b.configOverrides);
}

function backendEntrySupportsSessionModeSelection(entry: ResolvedBackendCatalogEntry | null): boolean {
    if (!entry) return true;
    if (!isBundledAgentId(entry.catalogAgentId)) return true;
    return getAgentCore(entry.catalogAgentId)?.sessionModes?.kind !== 'none';
}

function normalizeSessionModeIdForEntry(
    entry: ResolvedBackendCatalogEntry | null,
    sessionModeId: string | null | undefined,
): string | null {
    if (!backendEntrySupportsSessionModeSelection(entry)) return null;
    const trimmed = typeof sessionModeId === 'string' ? sessionModeId.trim() : '';
    return trimmed.length > 0 ? trimmed : 'default';
}

export function useNewSessionAgentPickerEngineSelectionState(
    params: UseNewSessionAgentPickerEngineSelectionStateParams,
): Readonly<{
    getEngineSelectionForTargetKey: (targetKey: string) => SessionAgentPickerSelection;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => void;
}> {
    const engineSelectionByTargetKeyRef = React.useRef(new Map<string, SessionAgentPickerSelection>());
    const pendingAppliedSelectionRef = React.useRef<{
        targetKey: string;
        selection: SessionAgentPickerSelection;
    } | null>(null);
    const selectedTargetKey = params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey;

    const buildInitialEngineSelection = React.useCallback((targetKey: string): SessionAgentPickerSelection => {
        if (targetKey === selectedTargetKey) {
            return {
                modelId: String(params.modelMode),
                modelSelection: params.modelSelection ?? null,
                sessionModeId: normalizeSessionModeIdForEntry(params.selectedBackendEntry, params.acpSessionModeId),
                configOverrides: Object.fromEntries(
                    Object.entries(params.sessionConfigOptionOverrides?.overrides ?? {})
                        .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                        .filter(([, value]) => value.length > 0),
                ),
            };
        }

        const remembered = readRememberedEngineSelectionForTargetKey({
            enabled: params.rememberEngineSelectionsEnabled === true,
            selectionsByScope: params.rememberedEngineSelectionsByScope,
            serverId: params.rememberedEngineSelectionServerId,
            targetKey,
        });
        if (remembered) {
            return {
                modelId: remembered.modelSelection?.ref.modelId ?? 'default',
                modelSelection: remembered.modelSelection,
                sessionModeId: remembered.acpSessionModeId ?? 'default',
                configOverrides: Object.fromEntries(
                    Object.entries(remembered.sessionConfigOptionOverrides?.overrides ?? {})
                        .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                        .filter(([, value]) => value.length > 0),
                ),
            };
        }

        return {
            modelId: 'default',
            sessionModeId: 'default',
            configOverrides: {},
        };
    }, [
        params.acpSessionModeId,
        params.modelMode,
        params.modelSelection,
        params.rememberEngineSelectionsEnabled,
        params.rememberedEngineSelectionServerId,
        params.rememberedEngineSelectionsByScope,
        params.sessionConfigOptionOverrides?.overrides,
        params.selectedBackendEntry,
        selectedTargetKey,
    ]);

    React.useEffect(() => {
        const initialSelection = buildInitialEngineSelection(selectedTargetKey);
        const nextSelection = {
            ...initialSelection,
            sessionModeId: normalizeSessionModeIdForEntry(params.selectedBackendEntry, initialSelection.sessionModeId),
        };
        const pendingAppliedSelection = pendingAppliedSelectionRef.current;
        if (pendingAppliedSelection?.targetKey === selectedTargetKey) {
            if (!areEngineSelectionsEqual(nextSelection, pendingAppliedSelection.selection)) {
                engineSelectionByTargetKeyRef.current.set(selectedTargetKey, pendingAppliedSelection.selection);
                return;
            }
            pendingAppliedSelectionRef.current = null;
        }

        engineSelectionByTargetKeyRef.current.set(selectedTargetKey, nextSelection);
    }, [buildInitialEngineSelection, params.selectedBackendEntry, selectedTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => {
        const normalizedSessionModeId = normalizeSessionModeIdForEntry(entry, selection.sessionModeId);
        const nextConfigOverrides: Readonly<Record<string, string>> = Object.fromEntries(
            Object.entries(selection.configOverrides ?? {})
                .map(([configId, value]) => [configId, typeof value === 'string' ? value.trim() : ''])
                .filter(([, value]) => value.length > 0),
        );
        const updatedAt = Date.now();
        const sessionConfigOptionOverrides = Object.keys(nextConfigOverrides).length === 0
            ? null
            : buildAcpConfigOptionOverridesV1({
                updatedAt,
                overrides: Object.fromEntries(
                    Object.entries(nextConfigOverrides).map(([configId, value]) => [
                        configId,
                        { updatedAt, value },
                    ]),
                ),
            });
        const modelMode = selection.modelId as ModelMode;
        const matchingStructuredSelection = selection.modelSelection?.ref.agentTargetKey === entry.backendTargetKey
            && selection.modelSelection.ref.modelId === selection.modelId
            ? selection.modelSelection
            : null;
        const modelSelection = selection.modelId === 'default'
            && matchingStructuredSelection?.ref.providerConnectionId == null
            ? null
            : matchingStructuredSelection ?? {
                    v: 1 as const,
                    updatedAt,
                    ref: {
                        agentTargetKey: entry.backendTargetKey,
                        providerConnectionId: null,
                        modelId: selection.modelId,
                    },
                };
        pendingAppliedSelectionRef.current = {
            targetKey: entry.backendTargetKey,
            selection: {
                ...selection,
                sessionModeId: normalizedSessionModeId,
            },
        };
        params.onExplicitBackendTargetSelection?.(entry.backendTarget);
        params.setBackendTarget(entry.backendTarget);
        if (params.setEngineSelectionForBackendTarget) {
            params.setEngineSelectionForBackendTarget(entry.backendTargetKey, {
                modelMode,
                modelSelection,
                acpSessionModeId: normalizedSessionModeId,
                sessionConfigOptionOverrides,
            });
        } else {
            params.setModelMode(modelMode);
            params.setAcpSessionModeId(normalizedSessionModeId);
            params.setSessionConfigOptionOverrides(sessionConfigOptionOverrides);
        }
        params.onRememberEngineSelection?.(entry.backendTarget, {
            modelSelection,
            acpSessionModeId: normalizedSessionModeId,
            sessionConfigOptionOverrides,
        });
    }, [params]);

    const selectEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => {
        const normalizedSelection = {
            ...selection,
            sessionModeId: normalizeSessionModeIdForEntry(entry, selection.sessionModeId),
        };
        engineSelectionByTargetKeyRef.current.set(entry.backendTargetKey, normalizedSelection);
        applyEngineSelection(entry, normalizedSelection);
    }, [applyEngineSelection]);

    return {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    };
}
