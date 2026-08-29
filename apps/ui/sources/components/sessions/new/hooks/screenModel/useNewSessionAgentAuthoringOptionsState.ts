import * as React from 'react';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    buildAcpConfigOptionOverridesV1,
    SessionMcpSelectionV1Schema,
    SessionModelSelectionV1Schema,
    type SessionMcpSelectionV1,
    type SessionModelSelectionV1,
    type AcpConfigOptionOverridesV1,
    type AgentExecutionTargetV1,
    type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { backendTargetKeysMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';

type PersistedAuthoringDraftLike = Readonly<{
    agentTarget?: AgentExecutionTargetV1 | null;
    modelId?: string | null;
    modelSelection?: SessionModelSelectionV1 | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    agentTarget?: AgentExecutionTargetV1 | null;
    modelId?: string | null;
    modelSelection?: SessionModelSelectionV1 | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
}> | null | undefined;

type TargetScopedState<Value> = Readonly<{
    backendTargetKey: string | null;
    value: Value;
}>;

type TargetScopedEngineSelection = Readonly<{
    modelMode: ModelMode;
    modelSelection?: SessionModelSelectionV1 | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

function resolveAgentTargetKeySafe(agentTarget: AgentExecutionTargetV1 | null | undefined): string | null {
    if (!agentTarget) return null;
    try {
        return resolveBackendTargetKeyV2(agentTarget);
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
    const draftBackendTargetKey = resolveAgentTargetKeySafe(params.draft.agentTarget);
    if (!draftBackendTargetKey) {
        if (params.allowTargetlessDraftEngineSelection === false) return null;
        return params.backendTargetKey ? null : params.draft;
    }
    return backendTargetKeysMatch(draftBackendTargetKey, params.backendTargetKey) ? params.draft : null;
}

type ResolvedAuthoringModelState = Readonly<{
    modelMode: ModelMode;
    modelSelection: SessionModelSelectionV1 | null;
}>;

function readDraftModelSelection(params: Readonly<{
    draft: TempAuthoringDraftLike | PersistedAuthoringDraftLike;
    agentTargetKey: string;
}>): Readonly<{ present: boolean; selection: SessionModelSelectionV1 | null }> {
    if (!params.draft) return { present: false, selection: null };
    if (params.draft.modelSelection !== undefined) {
        if (params.draft.modelSelection === null) return { present: true, selection: null };
        const selection = SessionModelSelectionV1Schema.parse(params.draft.modelSelection);
        if (!backendTargetKeysMatch(selection.ref.agentTargetKey, params.agentTargetKey)) {
            throw new Error('Session authoring model selection target mismatch');
        }
        return {
            present: true,
            // Persisted retired target-key spellings rekey onto the canonical
            // target so exactly one key spelling flows through authoring state.
            selection: selection.ref.agentTargetKey === params.agentTargetKey
                ? selection
                : SessionModelSelectionV1Schema.parse({
                    ...selection,
                    ref: { ...selection.ref, agentTargetKey: params.agentTargetKey },
                }),
        };
    }
    if (typeof params.draft.modelId !== 'string') return { present: false, selection: null };
    const modelId = params.draft.modelId.trim();
    if (!modelId || modelId === 'default') return { present: true, selection: null };
    return {
        present: true,
        selection: SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 0,
            ref: {
                agentTargetKey: params.agentTargetKey,
                providerConnectionId: null,
                modelId,
            },
        }),
    };
}

function resolveAuthoringModelState(params: Readonly<{
    agentType: string;
    agentTargetKey: string;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
    implicitProfileModelSelection?: SessionModelSelectionV1 | null;
}>): ResolvedAuthoringModelState {
    const core = isBundledAgentId(params.agentType) ? getAgentCore(params.agentType) : null;
    const temp = readDraftModelSelection({
        draft: params.hydratedTempAuthoringDraft,
        agentTargetKey: params.agentTargetKey,
    });
    const persisted = readDraftModelSelection({
        draft: params.hydratedPersistedAuthoringDraft,
        agentTargetKey: params.agentTargetKey,
    });
    const profileSelection = params.implicitProfileModelSelection ?? null;
    const rememberedSelection = params.rememberedEngineSelection?.modelSelection ?? null;
    const candidate = temp.present
        ? temp.selection
        : persisted.present
            ? persisted.selection
            : profileSelection ?? rememberedSelection;
    if (candidate && !backendTargetKeysMatch(candidate.ref.agentTargetKey, params.agentTargetKey)) {
        throw new Error('Session authoring model selection target mismatch');
    }
    const modelMode = resolveInitialNewSessionModelMode({
        draftModelMode: candidate?.ref.modelId ?? null,
        modelConfig: {
            defaultMode: core?.model.defaultMode ?? 'default',
            allowedModes: core?.model.allowedModes ?? [],
            supportsFreeform: core?.model.supportsFreeform ?? false,
            freeformModelIdPrefixes: core?.model.freeformModelIdPrefixes ?? [],
            dynamicProbe: core?.model.dynamicProbe ?? 'auto',
        },
    });
    return {
        modelMode,
        modelSelection: candidate
            && candidate.ref.modelId === modelMode
            && (modelMode !== 'default' || candidate.ref.providerConnectionId !== null)
            ? candidate
            : null,
    };
}

function resolveAuthoringAcpSessionModeId(params: Readonly<{
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
    implicitProfileModelSelection?: SessionModelSelectionV1 | null;
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
    agentType: string;
    backendTargetKey?: string | null;
    allowTargetlessDraftEngineSelection?: boolean;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
    implicitProfileModelSelection?: SessionModelSelectionV1 | null;
}>): Readonly<{
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    modelSelection: SessionModelSelectionV1 | null;
    setModelSelection: (selection: SessionModelSelectionV1 | null) => void;
    setModelSelectionForBackendTarget: (backendTargetKey: string, selection: SessionModelSelectionV1 | null) => void;
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
    const previousBackendTargetKeyRef = React.useRef(currentBackendTargetKey);
    const backendTargetChanged = previousBackendTargetKeyRef.current !== currentBackendTargetKey;
    previousBackendTargetKeyRef.current = currentBackendTargetKey;
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

    const bundledAgentTarget = isBundledAgentId(params.agentType)
        ? resolveAgentExecutionTargetForBackendTarget({
            backendTarget: { kind: 'backend', backendId: params.agentType },
        })
        : null;
    const effectiveModelTargetKey = currentBackendTargetKey
        ?? resolveBackendTargetKeyV2(bundledAgentTarget ?? { kind: 'backend', backendId: params.agentType });
    const resolvedModelState = React.useMemo(() => resolveAuthoringModelState({
        ...params,
        agentTargetKey: effectiveModelTargetKey,
        hydratedTempAuthoringDraft: targetScopedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: targetScopedPersistedAuthoringDraft,
    }), [
        effectiveModelTargetKey,
        params.agentType,
        params.rememberedEngineSelection?.modelSelection?.ref.modelId,
        params.rememberedEngineSelection?.modelSelection?.ref.providerConnectionId,
        params.rememberedEngineSelection?.modelSelection?.updatedAt,
        params.implicitProfileModelSelection,
        targetScopedPersistedAuthoringDraft?.modelId,
        targetScopedPersistedAuthoringDraft?.modelSelection,
        targetScopedTempAuthoringDraft?.modelId,
        targetScopedTempAuthoringDraft?.modelSelection,
    ]);
    const [modelState, setModelState] = React.useState<TargetScopedState<ResolvedAuthoringModelState>>(() => ({
        backendTargetKey: currentBackendTargetKey,
        value: resolvedModelState,
    }));
    const currentModelState = modelState.backendTargetKey === currentBackendTargetKey
        ? modelState.value
        : resolvedModelState;
    const modelMode = currentModelState.modelMode;
    const modelSelection = currentModelState.modelSelection;

    if (backendTargetChanged && modelState.backendTargetKey !== currentBackendTargetKey) {
        setModelState({
            backendTargetKey: currentBackendTargetKey,
            value: resolvedModelState,
        });
    }

    const setModelMode = React.useCallback<React.Dispatch<React.SetStateAction<ModelMode>>>((next) => {
        setModelState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : resolvedModelState;
            const value = typeof next === 'function'
                ? (next as (value: ModelMode) => ModelMode)(currentValue.modelMode)
                : next;
            const preserveSelection = currentValue.modelSelection?.ref.modelId === value;
            return {
                backendTargetKey: currentBackendTargetKey,
                value: {
                    modelMode: value,
                    modelSelection: value === 'default'
                        ? null
                        : preserveSelection
                            ? currentValue.modelSelection
                            : SessionModelSelectionV1Schema.parse({
                                v: 1,
                                updatedAt: Date.now(),
                                ref: {
                                    agentTargetKey: effectiveModelTargetKey,
                                    providerConnectionId: null,
                                    modelId: value,
                                },
                            }),
                },
            };
        });
    }, [currentBackendTargetKey, effectiveModelTargetKey, resolvedModelState]);

    const setModelSelection = React.useCallback((selection: SessionModelSelectionV1 | null) => {
        const parsed = selection === null ? null : SessionModelSelectionV1Schema.parse(selection);
        if (parsed && !backendTargetKeysMatch(parsed.ref.agentTargetKey, effectiveModelTargetKey)) {
            throw new Error('Session authoring model selection target mismatch');
        }
        setModelState({
            backendTargetKey: currentBackendTargetKey,
            value: {
                modelMode: parsed?.ref.modelId ?? (isBundledAgentId(params.agentType)
                    ? getAgentCore(params.agentType).model.defaultMode ?? 'default'
                    : 'default'),
                modelSelection: parsed,
            },
        });
    }, [currentBackendTargetKey, effectiveModelTargetKey, params.agentType]);

    const setModelSelectionForBackendTarget = React.useCallback((
        backendTargetKey: string,
        selection: SessionModelSelectionV1 | null,
    ) => {
        const targetKey = backendTargetKey.trim();
        if (!targetKey) {
            throw new Error('Session authoring model selection requires backend target');
        }
        const parsed = selection === null ? null : SessionModelSelectionV1Schema.parse(selection);
        if (parsed && !backendTargetKeysMatch(parsed.ref.agentTargetKey, targetKey)) {
            throw new Error('Session authoring model selection target mismatch');
        }
        setModelState({
            backendTargetKey: targetKey,
            value: {
                modelMode: parsed?.ref.modelId ?? 'default',
                modelSelection: parsed,
            },
        });
    }, []);

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

    if (backendTargetChanged && acpSessionModeIdState.backendTargetKey !== currentBackendTargetKey) {
        setAcpSessionModeIdState({
            backendTargetKey: currentBackendTargetKey,
            value: resolvedAcpSessionModeId,
        });
    }

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
    let sessionConfigOptionOverrides = sessionConfigOptionOverridesState.backendTargetKey === currentBackendTargetKey
        ? sessionConfigOptionOverridesState.value
        : initialSessionConfigOptionOverrides;

    if (backendTargetChanged && sessionConfigOptionOverridesState.backendTargetKey !== currentBackendTargetKey) {
        sessionConfigOptionOverrides = initialSessionConfigOptionOverrides;
        setSessionConfigOptionOverridesState({
            backendTargetKey: currentBackendTargetKey,
            value: initialSessionConfigOptionOverrides,
        });
    }

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
        const nextModelSelection = selection.modelSelection === undefined
            ? selection.modelMode === 'default'
                ? null
                : SessionModelSelectionV1Schema.parse({
                    v: 1,
                    updatedAt: Date.now(),
                    ref: {
                        agentTargetKey: targetKey,
                        providerConnectionId: null,
                        modelId: selection.modelMode,
                    },
                })
            : selection.modelSelection;
        if (nextModelSelection && !backendTargetKeysMatch(nextModelSelection.ref.agentTargetKey, targetKey)) {
            throw new Error('Session authoring model selection target mismatch');
        }
        setModelState({
            backendTargetKey: targetKey,
            value: {
                modelMode: nextModelSelection?.ref.modelId ?? selection.modelMode,
                modelSelection: nextModelSelection,
            },
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

    if (backendTargetChanged && mcpSelectionState.backendTargetKey !== currentBackendTargetKey) {
        setMcpSelectionState({
            backendTargetKey: currentBackendTargetKey,
            value: resolvedMcpSelection,
        });
    }

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
        modelSelection,
        setModelSelection,
        setModelSelectionForBackendTarget,
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
