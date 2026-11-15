import * as React from 'react';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { NewSessionDraftAgentIntent } from '@happier-dev/protocol/actions/appShellActionFamily';
import { formatBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { resolveSessionAgentPickerSelectionFields } from '@/components/sessions/agentPicker/sessionAgentPickerSelectionFields';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    readRememberedEngineSelectionForTargetKey,
    type RememberedEngineSelectionsByScopeV1,
} from '@/sync/domains/session/authoring/rememberedEngineSelections';

import type { SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';

/** Resolve the same selectable Agent row for UI and exact-draft Action edits. */
export function applyNewSessionDraftAgentIntent(params: Readonly<{
    intent: NewSessionDraftAgentIntent;
    entries: readonly ResolvedBackendCatalogEntry[];
    isSelectable: (entry: ResolvedBackendCatalogEntry) => boolean;
    selectEngineSelection: (entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => void;
    setSessionMode: (sessionModeId: string | null) => void;
    setConfigOption: (configId: string, value: string) => void;
}>): boolean {
    if (params.intent.kind === 'mode') {
        params.setSessionMode(params.intent.sessionModeId);
        return true;
    }
    if (params.intent.kind === 'config') {
        params.setConfigOption(params.intent.configId, params.intent.value);
        return true;
    }
    const targetKey = formatBackendTargetKeyV2(params.intent.backendTarget);
    const entry = params.entries.find(candidate => candidate.backendTargetKey === targetKey);
    if (!entry || !params.isSelectable(entry)) return false;
    params.selectEngineSelection(entry, params.intent.selection);
    return true;
}

type UseNewSessionAgentPickerEngineSelectionStateParams = Readonly<{
    selectedBackendEntry: ResolvedBackendCatalogEntry | null;
    selectedBackendTargetKey: string;
    modelMode: ModelMode;
    modelSelection?: SessionModelSelectionV1 | null;
    /** Source identities absent from V1 must not be retained as native tuples. */
    canRetainModelSelection?: (selection: SessionModelSelectionV1 | null) => boolean;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    setBackendTarget: React.Dispatch<React.SetStateAction<PersistedBackendTargetRefV2>>;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>;
    setEngineSelectionForBackendTarget?: (backendTargetKey: string, selection: {
        modelMode: ModelMode;
        modelSelection?: SessionModelSelectionV1 | null;
        acpSessionModeId: string | null;
        sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    }) => void;
    rememberEngineSelectionsEnabled?: boolean;
    rememberedEngineSelectionsByScope?: RememberedEngineSelectionsByScopeV1 | null;
    rememberedEngineSelectionServerId?: string | null;
    onRememberEngineSelection?: (backendTarget: PersistedBackendTargetRefV2, selection: {
        modelSelection: SessionModelSelectionV1 | null;
        acpSessionModeId: string | null;
        sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    }) => void;
    onExplicitBackendTargetSelection?: (backendTarget: PersistedBackendTargetRefV2) => void;
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
    return readNonBlankOpaqueIdentifier(sessionModeId);
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
                sessionModeId: remembered.acpSessionModeId ?? null,
                configOverrides: Object.fromEntries(
                    Object.entries(remembered.sessionConfigOptionOverrides?.overrides ?? {})
                        .map(([configId, override]) => [configId, typeof override?.value === 'string' ? override.value.trim() : ''])
                        .filter(([, value]) => value.length > 0),
                ),
            };
        }

        return {
            modelId: 'default',
            sessionModeId: null,
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
        if (params.canRetainModelSelection?.(nextSelection.modelSelection ?? null) === false) {
            pendingAppliedSelectionRef.current = null;
            return;
        }
        const pendingAppliedSelection = pendingAppliedSelectionRef.current;
        if (pendingAppliedSelection?.targetKey === selectedTargetKey) {
            if (!areEngineSelectionsEqual(nextSelection, pendingAppliedSelection.selection)) {
                engineSelectionByTargetKeyRef.current.set(selectedTargetKey, pendingAppliedSelection.selection);
                return;
            }
            pendingAppliedSelectionRef.current = null;
        }

        engineSelectionByTargetKeyRef.current.set(selectedTargetKey, nextSelection);
    }, [buildInitialEngineSelection, params.canRetainModelSelection, params.selectedBackendEntry, selectedTargetKey]);

    const getEngineSelectionForTargetKey = React.useCallback((targetKey: string) => {
        if (targetKey === selectedTargetKey && params.canRetainModelSelection?.(params.modelSelection ?? null) === false) {
            return buildInitialEngineSelection(targetKey);
        }
        const existing = engineSelectionByTargetKeyRef.current.get(targetKey);
        if (existing) return existing;
        const initialSelection = buildInitialEngineSelection(targetKey);
        engineSelectionByTargetKeyRef.current.set(targetKey, initialSelection);
        return initialSelection;
    }, [buildInitialEngineSelection, params.canRetainModelSelection, params.modelSelection, selectedTargetKey]);

    const applyEngineSelection = React.useCallback((entry: ResolvedBackendCatalogEntry, selection: SessionAgentPickerSelection) => {
        const normalizedSessionModeId = normalizeSessionModeIdForEntry(entry, selection.sessionModeId);
        // The one writer every Agent picker uses; New Session keeps only string choices it shows.
        const { modelSelection, sessionConfigOptionOverrides } = resolveSessionAgentPickerSelectionFields({
            agentTarget: entry.backendTargetKey, selection, updatedAt: Date.now(),
        });
        const modelMode = selection.modelId as ModelMode;
        const retainSelection = params.canRetainModelSelection?.(modelSelection) !== false;
        const appliedSelection = {
            ...selection,
            sessionModeId: normalizedSessionModeId,
        };
        if (retainSelection) engineSelectionByTargetKeyRef.current.set(entry.backendTargetKey, appliedSelection);
        pendingAppliedSelectionRef.current = retainSelection ? {
            targetKey: entry.backendTargetKey,
            selection: appliedSelection,
        } : null;
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
        if (retainSelection) params.onRememberEngineSelection?.(entry.backendTarget, {
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
        applyEngineSelection(entry, normalizedSelection);
    }, [applyEngineSelection]);

    return {
        getEngineSelectionForTargetKey,
        selectEngineSelection,
    };
}
