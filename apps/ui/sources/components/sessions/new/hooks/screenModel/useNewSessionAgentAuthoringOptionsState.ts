import * as React from 'react';

import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    buildAcpConfigOptionOverridesV1,
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV2,
} from '@happier-dev/protocol';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

type PersistedAuthoringDraftLike = Readonly<{
    agentId?: string | null;
    backendTarget?: BackendTargetRefV2 | null;
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    agentId?: string | null;
    backendTarget?: BackendTargetRefV2 | null;
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

type TargetScopedState<Value> = Readonly<{
    backendTargetKey: string | null;
    value: Value;
}>;

type TargetScopedEngineSelection = Readonly<{
    modelMode: ModelMode;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

function resolveBackendTargetKeySafe(backendTarget: BackendTargetRefV2 | null | undefined): string | null {
    if (!backendTarget) return null;
    try {
        return resolveBackendTargetKeyV2(backendTarget);
    } catch {
        return null;
    }
}

function resolveTargetScopedAuthoringDraft<Draft extends TempAuthoringDraftLike | PersistedAuthoringDraftLike>(params: Readonly<{
    draft: Draft;
    backendTargetKey?: string | null;
    allowTargetlessDraftEngineSelection?: boolean;
}>): Draft | null {
    if (!params.draft) return null;
    const draftBackendTargetKey = resolveBackendTargetKeySafe(params.draft.backendTarget);
    if (!draftBackendTargetKey) {
        if (params.allowTargetlessDraftEngineSelection === false) return null;

        const draftAgentId = typeof params.draft.agentId === 'string' ? params.draft.agentId.trim() : '';
        if (!draftAgentId) return params.backendTargetKey ? null : params.draft;
        if (!isAgentId(draftAgentId)) return null;

        const legacyBuiltInTargetKey = resolveBackendTargetKeySafe({
            kind: 'backend',
            backendId: draftAgentId,
        });
        return legacyBuiltInTargetKey && legacyBuiltInTargetKey === params.backendTargetKey ? params.draft : null;
    }
    return draftBackendTargetKey === params.backendTargetKey ? params.draft : null;
}

function resolveAuthoringModelMode(params: Readonly<{
    agentType: AgentId;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
}>): ModelMode {
    const core = getAgentCore(params.agentType);
    const tempMode = typeof params.hydratedTempAuthoringDraft?.modelId === 'string' ? params.hydratedTempAuthoringDraft.modelId : null;
    const draftMode = typeof params.hydratedPersistedAuthoringDraft?.modelId === 'string' ? params.hydratedPersistedAuthoringDraft.modelId : null;
    const rememberedMode = typeof params.rememberedEngineSelection?.modelId === 'string' ? params.rememberedEngineSelection.modelId : null;
    return resolveInitialNewSessionModelMode({
        draftModelMode: tempMode ?? draftMode ?? rememberedMode,
        modelConfig: {
            defaultMode: core.model.defaultMode,
            allowedModes: core.model.allowedModes,
            supportsFreeform: core.model.supportsFreeform,
            freeformModelIdPrefixes: core.model.freeformModelIdPrefixes,
            dynamicProbe: core.model.dynamicProbe ?? 'auto',
        },
    });
}

function resolveAuthoringAcpSessionModeId(params: Readonly<{
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
}>): string | null {
    if (typeof params.hydratedTempAuthoringDraft?.acpSessionModeId === 'string') {
        const trimmed = params.hydratedTempAuthoringDraft.acpSessionModeId.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    const raw = params.hydratedPersistedAuthoringDraft?.acpSessionModeId;
    if (raw === null) return null;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    const rememberedRaw = params.rememberedEngineSelection?.acpSessionModeId;
    if (typeof rememberedRaw === 'string') {
        const trimmed = rememberedRaw.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

export function useNewSessionAgentAuthoringOptionsState(params: Readonly<{
    agentType: AgentId;
    backendTargetKey?: string | null;
    allowTargetlessDraftEngineSelection?: boolean;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
}>): Readonly<{
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>;
    setEngineSelectionForBackendTarget: (backendTargetKey: string, selection: TargetScopedEngineSelection) => void;
    setAcpConfigOptionOverride: (configId: string, value: string) => void;
    mcpSelection: SessionMcpSelectionV1;
    setMcpSelection: React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>;
}> {
    const currentBackendTargetKey = params.backendTargetKey ?? null;
    const targetScopedTempAuthoringDraft = React.useMemo(() => resolveTargetScopedAuthoringDraft({
        draft: params.hydratedTempAuthoringDraft,
        backendTargetKey: currentBackendTargetKey,
        allowTargetlessDraftEngineSelection: params.allowTargetlessDraftEngineSelection,
    }), [
        params.allowTargetlessDraftEngineSelection,
        currentBackendTargetKey,
        params.hydratedTempAuthoringDraft,
    ]);
    const targetScopedPersistedAuthoringDraft = React.useMemo(() => resolveTargetScopedAuthoringDraft({
        draft: params.hydratedPersistedAuthoringDraft,
        backendTargetKey: currentBackendTargetKey,
        allowTargetlessDraftEngineSelection: params.allowTargetlessDraftEngineSelection,
    }), [
        params.allowTargetlessDraftEngineSelection,
        currentBackendTargetKey,
        params.hydratedPersistedAuthoringDraft,
    ]);

    const resolvedModelMode = React.useMemo(() => resolveAuthoringModelMode({
        ...params,
        hydratedTempAuthoringDraft: targetScopedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: targetScopedPersistedAuthoringDraft,
    }), [
        params.agentType,
        params.rememberedEngineSelection?.modelId,
        targetScopedPersistedAuthoringDraft?.modelId,
        targetScopedTempAuthoringDraft?.modelId,
    ]);
    const [modelModeState, setModelModeState] = React.useState<TargetScopedState<ModelMode>>(() => ({
        backendTargetKey: currentBackendTargetKey,
        value: resolvedModelMode,
    }));
    const modelMode = modelModeState.backendTargetKey === currentBackendTargetKey
        ? modelModeState.value
        : resolvedModelMode;

    React.useEffect(() => {
        setModelModeState((current) => {
            if (current.backendTargetKey === currentBackendTargetKey) {
                return current;
            }
            return {
                backendTargetKey: currentBackendTargetKey,
                value: resolvedModelMode,
            };
        });
    }, [currentBackendTargetKey, resolvedModelMode]);

    const setModelMode = React.useCallback<React.Dispatch<React.SetStateAction<ModelMode>>>((next) => {
        setModelModeState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : resolvedModelMode;
            const value = typeof next === 'function'
                ? (next as (value: ModelMode) => ModelMode)(currentValue)
                : next;
            return {
                backendTargetKey: currentBackendTargetKey,
                value,
            };
        });
    }, [currentBackendTargetKey, resolvedModelMode]);

    const resolvedAcpSessionModeId = React.useMemo(() => resolveAuthoringAcpSessionModeId({
        ...params,
        hydratedTempAuthoringDraft: targetScopedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: targetScopedPersistedAuthoringDraft,
    }), [
        params.rememberedEngineSelection?.acpSessionModeId,
        targetScopedPersistedAuthoringDraft?.acpSessionModeId,
        targetScopedTempAuthoringDraft?.acpSessionModeId,
    ]);
    const [acpSessionModeIdState, setAcpSessionModeIdState] = React.useState<TargetScopedState<string | null>>(() => ({
        backendTargetKey: currentBackendTargetKey,
        value: resolvedAcpSessionModeId,
    }));
    const acpSessionModeId = acpSessionModeIdState.backendTargetKey === currentBackendTargetKey
        ? acpSessionModeIdState.value
        : resolvedAcpSessionModeId;

    React.useEffect(() => {
        setAcpSessionModeIdState((current) => {
            if (current.backendTargetKey === currentBackendTargetKey) {
                return current;
            }
            return {
                backendTargetKey: currentBackendTargetKey,
                value: resolvedAcpSessionModeId,
            };
        });
    }, [currentBackendTargetKey, resolvedAcpSessionModeId]);

    const setAcpSessionModeId = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        setAcpSessionModeIdState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : resolvedAcpSessionModeId;
            const value = typeof next === 'function'
                ? (next as (value: string | null) => string | null)(currentValue)
                : next;
            return {
                backendTargetKey: currentBackendTargetKey,
                value,
            };
        });
    }, [currentBackendTargetKey, resolvedAcpSessionModeId]);

    const initialSessionConfigOptionOverrides = React.useMemo(() => {
        if (targetScopedTempAuthoringDraft && 'sessionConfigOptionOverrides' in targetScopedTempAuthoringDraft) {
            return targetScopedTempAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        if (targetScopedPersistedAuthoringDraft && 'sessionConfigOptionOverrides' in targetScopedPersistedAuthoringDraft) {
            return targetScopedPersistedAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        return params.rememberedEngineSelection?.sessionConfigOptionOverrides ?? null;
    }, [
        params.rememberedEngineSelection?.sessionConfigOptionOverrides,
        targetScopedPersistedAuthoringDraft?.sessionConfigOptionOverrides,
        targetScopedTempAuthoringDraft?.sessionConfigOptionOverrides,
    ]);

    const [
        sessionConfigOptionOverridesState,
        setSessionConfigOptionOverridesState,
    ] = React.useState<TargetScopedState<AcpConfigOptionOverridesV1 | null>>(() => ({
        backendTargetKey: currentBackendTargetKey,
        value: initialSessionConfigOptionOverrides,
    }));
    const sessionConfigOptionOverrides = sessionConfigOptionOverridesState.backendTargetKey === currentBackendTargetKey
        ? sessionConfigOptionOverridesState.value
        : initialSessionConfigOptionOverrides;

    React.useEffect(() => {
        setSessionConfigOptionOverridesState((current) => {
            if (current.backendTargetKey === currentBackendTargetKey) {
                return current;
            }
            return {
                backendTargetKey: currentBackendTargetKey,
                value: initialSessionConfigOptionOverrides,
            };
        });
    }, [currentBackendTargetKey, initialSessionConfigOptionOverrides]);

    const setSessionConfigOptionOverrides = React.useCallback<React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>>((next) => {
        setSessionConfigOptionOverridesState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : initialSessionConfigOptionOverrides;
            const value = typeof next === 'function'
                ? (next as (value: AcpConfigOptionOverridesV1 | null) => AcpConfigOptionOverridesV1 | null)(currentValue)
                : next;
            return {
                backendTargetKey: currentBackendTargetKey,
                value,
            };
        });
    }, [currentBackendTargetKey, initialSessionConfigOptionOverrides]);

    const setEngineSelectionForBackendTarget = React.useCallback((
        backendTargetKey: string,
        selection: TargetScopedEngineSelection,
    ) => {
        const targetKey = backendTargetKey.trim();
        if (!targetKey) return;
        setModelModeState({
            backendTargetKey: targetKey,
            value: selection.modelMode,
        });
        setAcpSessionModeIdState({
            backendTargetKey: targetKey,
            value: selection.acpSessionModeId,
        });
        setSessionConfigOptionOverridesState({
            backendTargetKey: targetKey,
            value: selection.sessionConfigOptionOverrides,
        });
    }, []);

    const resolvedMcpSelection = React.useMemo(() => {
        return SessionMcpSelectionV1Schema.parse(
            targetScopedTempAuthoringDraft?.mcpSelection ?? targetScopedPersistedAuthoringDraft?.mcpSelection ?? {},
        );
    }, [
        targetScopedPersistedAuthoringDraft?.mcpSelection,
        targetScopedTempAuthoringDraft?.mcpSelection,
    ]);
    const [mcpSelectionState, setMcpSelectionState] = React.useState<TargetScopedState<SessionMcpSelectionV1>>(() => ({
        backendTargetKey: currentBackendTargetKey,
        value: resolvedMcpSelection,
    }));
    const mcpSelection = mcpSelectionState.backendTargetKey === currentBackendTargetKey
        ? mcpSelectionState.value
        : resolvedMcpSelection;

    React.useEffect(() => {
        setMcpSelectionState((current) => {
            if (current.backendTargetKey === currentBackendTargetKey) {
                return current;
            }
            return {
                backendTargetKey: currentBackendTargetKey,
                value: resolvedMcpSelection,
            };
        });
    }, [currentBackendTargetKey, resolvedMcpSelection]);

    const setMcpSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>>((next) => {
        setMcpSelectionState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : resolvedMcpSelection;
            const value = typeof next === 'function'
                ? (next as (value: SessionMcpSelectionV1) => SessionMcpSelectionV1)(currentValue)
                : next;
            return {
                backendTargetKey: currentBackendTargetKey,
                value: SessionMcpSelectionV1Schema.parse(value),
            };
        });
    }, [currentBackendTargetKey, resolvedMcpSelection]);

    const setAcpConfigOptionOverride = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (!normalizedConfigId || !normalizedValue) return;
        const updatedAt = Date.now();
        setSessionConfigOptionOverrides((current) => buildAcpConfigOptionOverridesV1({
            updatedAt,
            overrides: {
                ...(current?.overrides ?? {}),
                [normalizedConfigId]: {
                    updatedAt,
                    value: normalizedValue,
                },
            },
        }));
    }, [setSessionConfigOptionOverrides]);

    return {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    };
}
