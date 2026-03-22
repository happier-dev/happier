import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveInitialNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import {
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
    type AcpConfigOptionOverridesV1,
} from '@happier-dev/protocol';

type PersistedAuthoringDraftLike = Readonly<{
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

type TempAuthoringDraftLike = Readonly<{
    modelId?: string | null;
    acpSessionModeId?: string | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    mcpSelection?: unknown;
    codexBackendMode?: string | null;
}> | null | undefined;

export function useNewSessionAgentAuthoringOptionsState(params: Readonly<{
    agentType: AgentId;
    hydratedTempAuthoringDraft: TempAuthoringDraftLike;
    hydratedPersistedAuthoringDraft: PersistedAuthoringDraftLike;
}>): Readonly<{
    modelMode: ModelMode;
    setModelMode: React.Dispatch<React.SetStateAction<ModelMode>>;
    acpSessionModeId: string | null;
    setAcpSessionModeId: React.Dispatch<React.SetStateAction<string | null>>;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
    setSessionConfigOptionOverrides: React.Dispatch<React.SetStateAction<AcpConfigOptionOverridesV1 | null>>;
    setAcpConfigOptionOverride: (configId: string, value: string) => void;
    mcpSelection: SessionMcpSelectionV1;
    setMcpSelection: React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>;
    codexBackendModeOverride: 'mcp' | 'acp' | 'appServer' | null;
}> {
    const [modelMode, setModelMode] = React.useState<ModelMode>(() => {
        const core = getAgentCore(params.agentType);
        const tempMode = typeof params.hydratedTempAuthoringDraft?.modelId === 'string' ? params.hydratedTempAuthoringDraft.modelId : null;
        const draftMode = typeof params.hydratedPersistedAuthoringDraft?.modelId === 'string' ? params.hydratedPersistedAuthoringDraft.modelId : null;
        return resolveInitialNewSessionModelMode({
            draftModelMode: tempMode ?? draftMode,
            modelConfig: {
                defaultMode: core.model.defaultMode,
                allowedModes: core.model.allowedModes,
                supportsFreeform: core.model.supportsFreeform,
            },
        }) as ModelMode;
    });

    const [acpSessionModeId, setAcpSessionModeId] = React.useState<string | null>(() => {
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
        return null;
    });

    const initialSessionConfigOptionOverrides = React.useMemo(() => {
        return params.hydratedTempAuthoringDraft?.sessionConfigOptionOverrides
            ?? params.hydratedPersistedAuthoringDraft?.sessionConfigOptionOverrides
            ?? null;
    }, [
        params.hydratedPersistedAuthoringDraft?.sessionConfigOptionOverrides,
        params.hydratedTempAuthoringDraft?.sessionConfigOptionOverrides,
    ]);

    const [sessionConfigOptionOverrides, setSessionConfigOptionOverrides] = React.useState<AcpConfigOptionOverridesV1 | null>(
        () => initialSessionConfigOptionOverrides,
    );

    React.useEffect(() => {
        setSessionConfigOptionOverrides(initialSessionConfigOptionOverrides);
    }, [initialSessionConfigOptionOverrides]);

    const [mcpSelection, setMcpSelection] = React.useState<SessionMcpSelectionV1>(() => {
        return SessionMcpSelectionV1Schema.parse(
            params.hydratedTempAuthoringDraft?.mcpSelection ?? params.hydratedPersistedAuthoringDraft?.mcpSelection ?? {},
        );
    });

    const codexBackendModeOverride = React.useMemo(() => {
        if (params.agentType !== 'codex') return null;
        const mode = params.hydratedTempAuthoringDraft?.codexBackendMode ?? params.hydratedPersistedAuthoringDraft?.codexBackendMode;
        return mode === 'mcp' || mode === 'acp' || mode === 'appServer' ? mode : null;
    }, [
        params.agentType,
        params.hydratedPersistedAuthoringDraft?.codexBackendMode,
        params.hydratedTempAuthoringDraft?.codexBackendMode,
    ]);

    const setAcpConfigOptionOverride = React.useCallback((configId: string, value: string) => {
        const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
        const normalizedValue = typeof value === 'string' ? value.trim() : '';
        if (!normalizedConfigId || !normalizedValue) return;
        const updatedAt = Date.now();
        setSessionConfigOptionOverrides((current) => ({
            v: 1,
            updatedAt,
            overrides: {
                ...(current?.overrides ?? {}),
                [normalizedConfigId]: {
                    updatedAt,
                    value: normalizedValue,
                },
            },
        }));
    }, []);

    return {
        modelMode,
        setModelMode,
        acpSessionModeId,
        setAcpSessionModeId,
        sessionConfigOptionOverrides,
        setSessionConfigOptionOverrides,
        setAcpConfigOptionOverride,
        mcpSelection,
        setMcpSelection,
        codexBackendModeOverride,
    };
}
