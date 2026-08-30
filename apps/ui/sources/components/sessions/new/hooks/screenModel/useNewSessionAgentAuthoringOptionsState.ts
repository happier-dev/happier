import * as React from 'react';

import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    BackendTargetRefSchema,
    buildBackendTargetKey,
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
    type AcpConfigOptionOverridesV1,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';
import type { RememberedEngineSelectionV1 } from '@/sync/domains/sessionAuthoring/rememberedEngineSelections';
import {
    readNonBlankSessionControlIdentifier,
    readSessionControlValueId,
} from '@/sync/domains/sessionControl/opaqueIdentifiers';

type PersistedAuthoringDraftLike = Readonly<{
    agentId?: string | null;
    agentType?: string | null;
    backendTarget?: unknown;
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    agentId?: string | null;
    agentType?: string | null;
    backendTarget?: unknown;
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

function areSessionConfigOptionOverridesEqual(
    current: AcpConfigOptionOverridesV1 | null,
    next: AcpConfigOptionOverridesV1 | null,
): boolean {
    if (current === next) return true;
    if (!current || !next) return current === next;
    if (current.v !== next.v) return false;
    if (current.updatedAt !== next.updatedAt) return false;

    const currentOverrides = current.overrides ?? {};
    const nextOverrides = next.overrides ?? {};
    const currentKeys = Object.keys(currentOverrides);
    const nextKeys = Object.keys(nextOverrides);

    if (currentKeys.length !== nextKeys.length) return false;

    for (const key of currentKeys) {
        const currentValue = currentOverrides[key];
        const nextValue = nextOverrides[key];
        if (!nextValue) return false;
        if (currentValue.updatedAt !== nextValue.updatedAt) return false;
        if (currentValue.value !== nextValue.value) return false;
    }

    return true;
}

type SessionConfigOptionOverridesState = Readonly<{
    source: AcpConfigOptionOverridesV1 | null;
    value: AcpConfigOptionOverridesV1 | null;
}>;

type DraftBackendTargetOwnership = 'match' | 'mismatch' | 'unknown';

function resolveDraftBackendTargetOwnership(
    draft: TempAuthoringDraftLike | PersistedAuthoringDraftLike,
    backendTarget: BackendTargetRefV1,
): DraftBackendTargetOwnership {
    if (!draft) return 'mismatch';

    const parsedBackendTarget = BackendTargetRefSchema.safeParse(draft.backendTarget);
    if (parsedBackendTarget.success) {
        return buildBackendTargetKey(parsedBackendTarget.data) === buildBackendTargetKey(backendTarget)
            ? 'match'
            : 'mismatch';
    }

    const draftAgentId =
        typeof draft.agentId === 'string' && draft.agentId.trim().length > 0 ? draft.agentId.trim()
        : typeof draft.agentType === 'string' && draft.agentType.trim().length > 0 ? draft.agentType.trim()
        : null;
    if (draftAgentId) {
        return backendTarget.kind === 'builtInAgent' && draftAgentId === backendTarget.agentId
            ? 'match'
            : 'mismatch';
    }

    return 'unknown';
}

function isKnownStaticModelForDifferentAgent(modelId: string, agentType: AgentId): boolean {
    const normalizedModelId = readNonBlankSessionControlIdentifier(modelId) ?? '';
    if (!normalizedModelId || normalizedModelId === 'default') return false;
    for (const candidateAgentId of AGENT_IDS) {
        const candidateCore = getAgentCore(candidateAgentId);
        const staticModes = candidateCore.model.allowedModes ?? [];
        if (!staticModes.includes(normalizedModelId as any)) {
            continue;
        }
        if (candidateAgentId !== agentType) {
            return true;
        }
    }
    return false;
}

function readScopedDraftModelId(
    draft: TempAuthoringDraftLike | PersistedAuthoringDraftLike,
    agentType: AgentId,
    backendTarget: BackendTargetRefV1,
): string | null {
    const modelId = readNonBlankSessionControlIdentifier(draft?.modelId) ?? '';
    if (!modelId) return null;
    const ownership = resolveDraftBackendTargetOwnership(draft, backendTarget);
    if (ownership === 'mismatch') return null;
    return ownership === 'unknown' && isKnownStaticModelForDifferentAgent(modelId, agentType)
        ? null
        : modelId;
}

function readScopedAcpSessionModeId(
    draft: TempAuthoringDraftLike | PersistedAuthoringDraftLike,
): string | null | undefined {
    if (!draft || !('acpSessionModeId' in draft)) {
        return undefined;
    }
    const raw = draft.acpSessionModeId;
    if (raw === null) return null;
    if (typeof raw !== 'string') return undefined;
    return readNonBlankSessionControlIdentifier(raw);
}

export function useNewSessionAgentAuthoringOptionsState(params: Readonly<{
    agentType: AgentId;
    backendTarget: BackendTargetRefV1;
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
    setSessionConfigOptionOverride: (configId: string, value: string) => void;
    mcpSelection: SessionMcpSelectionV1;
    setMcpSelection: React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>;
}> {
    const backendTargetKey = React.useMemo(() => buildBackendTargetKey(params.backendTarget), [params.backendTarget]);
    const initialModelMode = React.useMemo<ModelMode>(() => {
        const core = getAgentCore(params.agentType);
        const tempMode = readScopedDraftModelId(params.hydratedTempAuthoringDraft, params.agentType, params.backendTarget);
        const draftMode = readScopedDraftModelId(params.hydratedPersistedAuthoringDraft, params.agentType, params.backendTarget);
        const rememberedMode = typeof params.rememberedEngineSelection?.modelId === 'string' ? params.rememberedEngineSelection.modelId : null;
        return resolveInitialNewSessionModelMode({
            draftModelMode: tempMode ?? draftMode ?? rememberedMode,
            modelConfig: {
                defaultMode: core.model.defaultMode,
                allowedModes: core.model.allowedModes,
                supportsFreeform: core.model.supportsFreeform,
                dynamicProbe: core.model.dynamicProbe ?? 'auto',
            },
        }) as ModelMode;
    }, [
        params.agentType,
        backendTargetKey,
        params.hydratedPersistedAuthoringDraft,
        params.hydratedTempAuthoringDraft,
        params.rememberedEngineSelection?.modelId,
    ]);

    const [modelMode, setModelMode] = React.useState<ModelMode>(() => initialModelMode);

    const initialAcpSessionModeId = React.useMemo<string | null>(() => {
        const temp = readScopedAcpSessionModeId(params.hydratedTempAuthoringDraft);
        if (temp !== undefined) return temp;
        const persisted = readScopedAcpSessionModeId(params.hydratedPersistedAuthoringDraft);
        if (persisted !== undefined) return persisted;
        const remembered = params.rememberedEngineSelection?.acpSessionModeId;
        if (typeof remembered === 'string') {
            return readNonBlankSessionControlIdentifier(remembered);
        }
        return null;
    }, [
        params.hydratedPersistedAuthoringDraft,
        params.hydratedTempAuthoringDraft,
        params.rememberedEngineSelection?.acpSessionModeId,
    ]);

    const [acpSessionModeId, setAcpSessionModeId] = React.useState<string | null>(() => initialAcpSessionModeId);

    const initialSessionConfigOptionOverrides = React.useMemo(() => {
        if (params.hydratedTempAuthoringDraft && 'sessionConfigOptionOverrides' in params.hydratedTempAuthoringDraft) {
            return params.hydratedTempAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        if (params.hydratedPersistedAuthoringDraft && 'sessionConfigOptionOverrides' in params.hydratedPersistedAuthoringDraft) {
            return params.hydratedPersistedAuthoringDraft.sessionConfigOptionOverrides ?? null;
        }
        return params.rememberedEngineSelection?.sessionConfigOptionOverrides ?? null;
    }, [
        params.hydratedPersistedAuthoringDraft,
        params.hydratedPersistedAuthoringDraft?.sessionConfigOptionOverrides,
        params.hydratedTempAuthoringDraft,
        params.hydratedTempAuthoringDraft?.sessionConfigOptionOverrides,
        params.rememberedEngineSelection?.sessionConfigOptionOverrides,
    ]);

    const [sessionConfigOptionOverridesState, setSessionConfigOptionOverridesState] = React.useState<SessionConfigOptionOverridesState>(
        () => ({
            source: initialSessionConfigOptionOverrides,
            value: initialSessionConfigOptionOverrides,
        }),
    );
    let sessionConfigOptionOverrides = sessionConfigOptionOverridesState.value;
    if (!areSessionConfigOptionOverridesEqual(
        sessionConfigOptionOverridesState.source,
        initialSessionConfigOptionOverrides,
    )) {
        sessionConfigOptionOverrides = initialSessionConfigOptionOverrides;
        setSessionConfigOptionOverridesState({
            source: initialSessionConfigOptionOverrides,
            value: initialSessionConfigOptionOverrides,
        });
    }

    const setSessionConfigOptionOverrides = React.useCallback<React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>>((next) => {
        setSessionConfigOptionOverridesState((current) => {
            const currentValue = areSessionConfigOptionOverridesEqual(current.source, initialSessionConfigOptionOverrides)
                ? current.value
                : initialSessionConfigOptionOverrides;
            const value = typeof next === 'function'
                ? (next as (value: AcpConfigOptionOverridesV1 | null) => AcpConfigOptionOverridesV1 | null)(currentValue)
                : next;
            if (
                currentValue === value
                && areSessionConfigOptionOverridesEqual(current.source, initialSessionConfigOptionOverrides)
            ) {
                return current;
            }
            return {
                source: initialSessionConfigOptionOverrides,
                value,
            };
        });
    }, [initialSessionConfigOptionOverrides]);

    const initialMcpSelection = React.useMemo<SessionMcpSelectionV1>(() => {
        return SessionMcpSelectionV1Schema.parse(
            params.hydratedTempAuthoringDraft?.mcpSelection ?? params.hydratedPersistedAuthoringDraft?.mcpSelection ?? {},
        );
    }, [params.hydratedPersistedAuthoringDraft, params.hydratedTempAuthoringDraft]);

    const [mcpSelection, setMcpSelection] = React.useState<SessionMcpSelectionV1>(() => initialMcpSelection);

    const setSessionConfigOptionOverride = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = readNonBlankSessionControlIdentifier(configId) ?? '';
        const normalizedValue = readSessionControlValueId(value) ?? '';
        if (!normalizedConfigId || !normalizedValue) return;
        setSessionConfigOptionOverrides((current) => {
            const currentRawValue = current?.overrides?.[normalizedConfigId]?.value;
            const currentValue = readSessionControlValueId(currentRawValue) ?? '';
            if (currentValue === normalizedValue) {
                return current;
            }

            const updatedAt = Date.now();
            return {
                v: 1,
                updatedAt,
                overrides: {
                    ...(current?.overrides ?? {}),
                    [normalizedConfigId]: {
                        updatedAt,
                        value: normalizedValue,
                    },
                },
            };
        });
    }, []);

    return {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setSessionConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
    };
}
