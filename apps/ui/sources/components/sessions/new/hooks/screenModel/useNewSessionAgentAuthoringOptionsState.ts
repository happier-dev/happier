import * as React from 'react';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { getAgentModelConfig } from '@happier-dev/agents';
import { coerceNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import { buildAcpConfigOptionOverridesV1, type AcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { SessionCapabilitySelectionV1Schema, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionModelSelectionSchema, type SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { type SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';
import { resolveManagedSessionDefaults, type ManagedSessionDefaultsContext, type TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { RuntimeDescriptorV1 } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';
import { backendTargetKeysMatch, resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';
import { resolveSessionModelSelectionForAgentTarget } from '@/components/sessions/authoring/sessionModelSelectionValue';

type PersistedAuthoringDraftLike = Readonly<{
    agentTarget?: AgentExecutionTargetV1 | null;
    modelId?: string | null;
    modelSelection?: SessionModelSelection | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    capabilitySelection?: unknown;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    agentTarget?: AgentExecutionTargetV1 | null;
    modelId?: string | null;
    modelSelection?: SessionModelSelection | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    capabilitySelection?: unknown;
    runtimeDescriptorV1?: RuntimeDescriptorV1 | null;
}> | null | undefined;

type TargetScopedState<Value> = Readonly<{
    backendTargetKey: string | null;
    value: Value;
}>;

function useTargetScopedAuthoringState<Value>(backendTargetKey: string | null, resolvedValue: Value) {
    const signature = JSON.stringify(resolvedValue);
    const [source, setSource] = React.useState(() => ({ backendTargetKey, signature }));
    const [state, setState] = React.useState<TargetScopedState<Value> & Readonly<{ authored: boolean }>>(() => ({
        backendTargetKey,
        value: resolvedValue,
        authored: false,
    }));
    const setAuthoredState = React.useCallback<React.Dispatch<React.SetStateAction<TargetScopedState<Value>>>>((next) => {
        setState((current) => ({
            ...(typeof next === 'function' ? next(current) : next),
            authored: true,
        }));
    }, []);
    let value = state.backendTargetKey === backendTargetKey ? state.value : resolvedValue;
    let authored = state.backendTargetKey === backendTargetKey && state.authored;
    if (source.backendTargetKey !== backendTargetKey || source.signature !== signature) {
        setSource({ backendTargetKey, signature });
        // A picker may author this field before its draft arrives, or stage it
        // for the next target. Remembered/draft echoes must not replace that
        // choice. Untouched fields hydrate before autosave can commit.
        const shouldHydrate = source.backendTargetKey !== backendTargetKey
            ? state.backendTargetKey !== backendTargetKey
            : state.backendTargetKey === backendTargetKey && !state.authored;
        if (shouldHydrate
            && (state.backendTargetKey !== backendTargetKey || JSON.stringify(state.value) !== signature)) {
            value = resolvedValue;
            authored = false;
            setState({ backendTargetKey, value, authored: false });
        }
    }
    return [value, setAuthoredState, authored] as const;
}

type TargetScopedEngineSelection = Readonly<{
    applyModel?: boolean;
    modelMode: ModelMode;
    modelSelection?: SessionModelSelection | null;
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
    if (!params.backendTargetKey) return null;
    return backendTargetKeysMatch(draftBackendTargetKey, params.backendTargetKey) ? params.draft : null;
}

type ResolvedAuthoringModelState = Readonly<{
    modelMode: ModelMode;
    modelSelection: SessionModelSelection | null;
}>;

function readDraftModelSelection(params: Readonly<{
    draft: TempAuthoringDraftLike | PersistedAuthoringDraftLike;
    agentTargetKey: string;
}>): Readonly<{ present: boolean; selection: SessionModelSelection | null }> {
    if (!params.draft) return { present: false, selection: null };
    if (params.draft.modelSelection !== undefined) {
        if (params.draft.modelSelection === null) return { present: true, selection: null };
        const selection = resolveSessionModelSelectionForAgentTarget(SessionModelSelectionSchema.parse(params.draft.modelSelection), params.agentTargetKey);
        return { present: selection !== null, selection };
    }
    if (typeof params.draft.modelId !== 'string') return { present: false, selection: null };
    const modelId = params.draft.modelId.trim();
    if (!modelId || modelId === 'default') return { present: true, selection: null };
    return {
        present: true,
        selection: SessionModelSelectionSchema.parse({
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
    implicitProfileModelSelection?: SessionModelSelection | null;
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
    const rememberedSelection = resolveSessionModelSelectionForAgentTarget(params.rememberedEngineSelection?.modelSelection, params.agentTargetKey);
    const candidate = temp.present
        ? temp.selection
        : persisted.present
            ? persisted.selection
            : profileSelection ?? rememberedSelection;
    const modelMode = coerceNewSessionModelMode({
        modelMode: candidate?.ref.modelId ?? null,
        modelSelection: candidate,
        preflight: null,
        modelConfig: {
            defaultMode: core?.model?.defaultMode ?? 'default',
            allowedModes: core?.model?.allowedModes ?? [],
            supportsFreeform: core?.model?.supportsFreeform ?? false,
            freeformModelIdPrefixes: core?.model?.freeformModelIdPrefixes ?? [],
            dynamicProbe: core?.model?.dynamicProbe ?? 'auto',
        },
    });
    return {
        modelMode,
        modelSelection: candidate
            && candidate.ref.modelId === modelMode
            && (modelMode !== 'default' || (candidate.v === 2 ? candidate.ref.source !== 'native' : candidate.ref.providerConnectionId !== null))
            ? candidate
            : null,
    };
}

function resolveAuthoringAcpSessionModeId(params: Readonly<{
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
    rememberedEngineSelection?: RememberedEngineSelectionV1 | null;
    implicitProfileModelSelection?: SessionModelSelection | null;
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
    implicitProfileModelSelection?: SessionModelSelection | null;
    managedDefaults?: ManagedSessionDefaultsContext;
    explicitTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
}>): Readonly<{
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    modelSelection: SessionModelSelection | null;
    modelSelectionV2: SessionModelSelectionV2 | null;
    modelSelectionForPersistence: SessionModelSelection | null | undefined;
    modelIsManagedDefault: boolean;
    teamCredentialModel: TeamCredentialProviderModelSelectionV1 | null;
    setModelSelection: (selection: SessionModelSelection | null) => void;
    setModelSelectionForBackendTarget: (backendTargetKey: string, selection: SessionModelSelection | null) => void;
    /** The layer the model came from, for the picker row's provenance. */
    modelSource: ReturnType<typeof resolveManagedSessionDefaults>['model']['source'];
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>;
    setEngineSelectionForBackendTarget: (backendTargetKey: string, selection: TargetScopedEngineSelection) => void;
    setAcpConfigOptionOverride: (configId: string, value: string) => void;
    capabilitySelection: SessionCapabilitySelectionV1;
    setCapabilitySelection: React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>;
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

    const effectiveModelTargetKey = React.useMemo(() => {
        if (currentBackendTargetKey !== null) return currentBackendTargetKey;
        const bundledAgentTarget = isBundledAgentId(params.agentType)
            ? resolveAgentExecutionTargetForBackendTarget({
                backendTarget: { kind: 'backend', backendId: params.agentType },
            })
            : null;
        return resolveBackendTargetKeyV2(bundledAgentTarget ?? { kind: 'backend', backendId: params.agentType });
    }, [currentBackendTargetKey, params.agentType]);
    // A launch profile's model intent names its own Agent target, like a draft does. Once the
    // person picks another Agent it no longer applies, so it is scoped here with the drafts.
    const targetScopedImplicitProfileModelSelection = resolveSessionModelSelectionForAgentTarget(
        params.implicitProfileModelSelection, effectiveModelTargetKey,
    );
    const resolvedModelState = React.useMemo(() => resolveAuthoringModelState({
        ...params,
        agentTargetKey: effectiveModelTargetKey,
        hydratedTempAuthoringDraft: targetScopedTempAuthoringDraft,
        hydratedPersistedAuthoringDraft: targetScopedPersistedAuthoringDraft,
        implicitProfileModelSelection: targetScopedImplicitProfileModelSelection,
    }), [
        effectiveModelTargetKey,
        params.agentType,
        params.rememberedEngineSelection?.modelSelection?.ref.modelId,
        params.rememberedEngineSelection?.modelSelection,
        params.rememberedEngineSelection?.modelSelection?.updatedAt,
        targetScopedImplicitProfileModelSelection,
        targetScopedPersistedAuthoringDraft?.modelId,
        targetScopedPersistedAuthoringDraft?.modelSelection,
        targetScopedTempAuthoringDraft?.modelId,
        targetScopedTempAuthoringDraft?.modelSelection,
    ]);
    const [currentModelState, setModelState, modelAuthored] = useTargetScopedAuthoringState(currentBackendTargetKey, resolvedModelState);
    const explicitTeam = params.explicitTeamCredentialModel;
    const explicitTeamSelection: SessionModelSelectionV2 | undefined = explicitTeam
        && explicitTeam.agentTargetKey === effectiveModelTargetKey
        && (!modelAuthored || (currentModelState.modelSelection && (currentModelState.modelSelection.v === 2 ? currentModelState.modelSelection.ref.source === 'native' : currentModelState.modelSelection.ref.providerConnectionId === null)
            && currentModelState.modelMode === explicitTeam.modelId))
        ? { v: 2, updatedAt: currentModelState.modelSelection?.updatedAt ?? 0, ref: {
            source: 'team_resource', teamId: explicitTeam.teamId, resourceId: explicitTeam.resourceId,
            expectedResourceRevision: explicitTeam.expectedResourceRevision, deliveryMode: explicitTeam.deliveryMode,
            agentTargetKey: effectiveModelTargetKey, modelId: explicitTeam.modelId,
            ...(explicitTeam.nativeDelivery ? { nativeDelivery: explicitTeam.nativeDelivery } : {}),
        } } : undefined;
    const hasExplicitModel = modelAuthored || explicitTeamSelection !== undefined
        || targetScopedTempAuthoringDraft?.modelSelection !== undefined
        || typeof targetScopedTempAuthoringDraft?.modelId === 'string'
        || targetScopedPersistedAuthoringDraft?.modelSelection !== undefined
        || typeof targetScopedPersistedAuthoringDraft?.modelId === 'string'
        || targetScopedImplicitProfileModelSelection !== null;
    const modelSelectionForPersistence = hasExplicitModel
        ? explicitTeamSelection ?? currentModelState.modelSelection
        : undefined;
    // Remembered engine state is a fallback, whereas a draft, profile or picker
    // is deliberate intent. The shared owner decides that intent against locks.
    const explicitModel = hasExplicitModel ? explicitTeamSelection ?? currentModelState.modelSelection
        ?? { v: 1 as const, updatedAt: 0, ref: { agentTargetKey: effectiveModelTargetKey,
            providerConnectionId: null, modelId: currentModelState.modelMode } } : undefined;
    const modelDecision = resolveManagedSessionDefaults({ ...params.managedDefaults,
        agentTargetKey: effectiveModelTargetKey,
        explicitChoices: explicitModel ? { modelByAgentTargetKey: { [effectiveModelTargetKey]: explicitModel } } : undefined,
    }).model;
    const managedModel = modelDecision.value;
    const modelIsManagedDefault = modelDecision.source !== 'none' && modelDecision.source !== 'explicit';
    const modelSelectionV2 = managedModel?.v === 2 ? managedModel : null;
    // The explicit marker lets Automatic compete with defaults while its
    // authored representation remains null for existing draft/launch readers.
    const modelSelection = modelDecision.source === 'explicit' && !explicitTeamSelection
        ? currentModelState.modelSelection
        : managedModel
            ? managedModel
            : currentModelState.modelSelection;
    const modelMode = managedModel?.ref.modelId ?? currentModelState.modelMode;
    const teamRef = modelSelectionV2?.ref.source === 'team_resource' ? modelSelectionV2.ref : null;
    const teamCredentialModel: TeamCredentialProviderModelSelectionV1 | null = teamRef ? {
        kind: 'team_credential_provider_model', teamId: teamRef.teamId, resourceId: teamRef.resourceId,
        expectedResourceRevision: teamRef.expectedResourceRevision, deliveryMode: teamRef.deliveryMode,
        agentTargetKey: teamRef.agentTargetKey, modelId: teamRef.modelId,
        ...(teamRef.nativeDelivery ? { nativeDelivery: teamRef.nativeDelivery } : {}),
    } : null;

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
                            : SessionModelSelectionSchema.parse({
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

    const setModelSelection = React.useCallback((selection: SessionModelSelection | null) => {
        const parsed = resolveSessionModelSelectionForAgentTarget(selection === null ? null : SessionModelSelectionSchema.parse(selection), effectiveModelTargetKey);
        setModelState({
            backendTargetKey: currentBackendTargetKey,
            value: {
                modelMode: parsed?.ref.modelId ?? getAgentModelConfig(params.agentType)?.defaultMode ?? 'default',
                modelSelection: parsed,
            },
        });
    }, [currentBackendTargetKey, effectiveModelTargetKey, params.agentType]);

    const setModelSelectionForBackendTarget = React.useCallback((
        backendTargetKey: string,
        selection: SessionModelSelection | null,
    ) => {
        const targetKey = backendTargetKey.trim();
        if (!targetKey) {
            throw new Error('Session authoring model selection requires backend target');
        }
        const parsed = resolveSessionModelSelectionForAgentTarget(selection === null ? null : SessionModelSelectionSchema.parse(selection), targetKey);
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
    const [acpSessionModeId, setAcpSessionModeIdState] = useTargetScopedAuthoringState(currentBackendTargetKey, resolvedAcpSessionModeId);

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
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverridesState,
    ] = useTargetScopedAuthoringState(currentBackendTargetKey, initialSessionConfigOptionOverrides);

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
        if (selection.applyModel !== false) {
            const candidate = selection.modelSelection === undefined
                ? selection.modelMode === 'default'
                    ? null
                    : SessionModelSelectionSchema.parse({
                        v: 1,
                        updatedAt: Date.now(),
                        ref: {
                            agentTargetKey: targetKey,
                            providerConnectionId: null,
                            modelId: selection.modelMode,
                        },
                    })
                : selection.modelSelection;
            const nextModelSelection = resolveSessionModelSelectionForAgentTarget(candidate, targetKey);
            setModelState({
                backendTargetKey: targetKey,
                value: {
                    modelMode: nextModelSelection?.ref.modelId ?? (candidate ? 'default' : selection.modelMode),
                    modelSelection: nextModelSelection,
                },
            });
        }
        setAcpSessionModeIdState({
            backendTargetKey: targetKey,
            value: selection.acpSessionModeId,
        });
        setSessionConfigOptionOverridesState({
            backendTargetKey: targetKey,
            value: selection.sessionConfigOptionOverrides,
        });
    }, []);

    const resolvedCapabilitySelection = React.useMemo(() => {
        return SessionCapabilitySelectionV1Schema.parse(
            targetScopedTempAuthoringDraft?.capabilitySelection ?? targetScopedPersistedAuthoringDraft?.capabilitySelection ?? {},
        );
    }, [
        targetScopedPersistedAuthoringDraft?.capabilitySelection,
        targetScopedTempAuthoringDraft?.capabilitySelection,
    ]);
    const [capabilitySelection, setCapabilitySelectionState] = useTargetScopedAuthoringState(currentBackendTargetKey, resolvedCapabilitySelection);

    const setCapabilitySelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>>((next) => {
        setCapabilitySelectionState((current) => {
            const currentValue = current.backendTargetKey === currentBackendTargetKey
                ? current.value
                : resolvedCapabilitySelection;
            const value = typeof next === 'function'
                ? (next as (value: SessionCapabilitySelectionV1) => SessionCapabilitySelectionV1)(currentValue)
                : next;
            return {
                backendTargetKey: currentBackendTargetKey,
                value: SessionCapabilitySelectionV1Schema.parse(value),
            };
        });
    }, [currentBackendTargetKey, resolvedCapabilitySelection]);

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
        modelSelectionV2,
        modelSelectionForPersistence,
        modelIsManagedDefault,
        modelSource: modelDecision.source,
        teamCredentialModel,
        setModelSelection,
        setModelSelectionForBackendTarget,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setEngineSelectionForBackendTarget,
        setAcpConfigOptionOverride,
        capabilitySelection,
        setCapabilitySelection,
    };
}
