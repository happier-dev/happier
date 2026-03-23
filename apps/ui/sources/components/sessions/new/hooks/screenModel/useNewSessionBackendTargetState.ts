import * as React from 'react';

import { BackendTargetRefSchema, buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { DEFAULT_AGENT_ID, isAgentId } from '@/agents/catalog/catalog';
import { resolveBuiltInAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useApplySettings } from '@/sync/store/settingsWriters';

function findEntryByTarget(
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
    target: BackendTargetRefV1,
): ResolvedBackendCatalogEntry | null {
    const targetKey = buildBackendTargetKey(target);
    return entries.find((entry) => entry.targetKey === targetKey) ?? null;
}

function resolveInitialBackendTarget(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
}>): BackendTargetRefV1 {
    const tempTarget = BackendTargetRefSchema.safeParse(params.tempBackendTarget);
    if (tempTarget.success) {
        const matched = findEntryByTarget(params.entries, tempTarget.data);
        if (matched) {
            return matched.target;
        }
    }

    const persisted = BackendTargetRefSchema.safeParse(params.persistedBackendTarget);
    if (persisted.success) {
        const matched = findEntryByTarget(params.entries, persisted.data);
        if (matched) {
            return matched.target;
        }
    }

    const lastUsedBackendTarget = BackendTargetRefSchema.safeParse(params.lastUsedBackendTarget);
    if (lastUsedBackendTarget.success) {
        const matched = findEntryByTarget(params.entries, lastUsedBackendTarget.data);
        if (matched) {
            return matched.target;
        }
    }

    const preferredBuiltInAgentId =
        isAgentId(params.tempAgentType) ? params.tempAgentType
        : isAgentId(params.lastUsedAgent) ? params.lastUsedAgent
        : DEFAULT_AGENT_ID;
    const builtInTarget: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: preferredBuiltInAgentId };
    const matchedBuiltIn = findEntryByTarget(params.entries, builtInTarget);
    if (matchedBuiltIn) {
        return matchedBuiltIn.target;
    }

    return params.entries[0]?.target ?? { kind: 'builtInAgent', agentId: DEFAULT_AGENT_ID };
}

export function useNewSessionBackendTargetState(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
}>): Readonly<{
    backendTarget: BackendTargetRefV1;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    builtInAgentId: AgentId;
}> {
    const applySettings = useApplySettings();
    const initialBackendTarget = React.useMemo(() => resolveInitialBackendTarget(params), [
        params.entries,
        params.lastUsedAgent,
        params.lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
    ]);
    const [backendTarget, setBackendTarget] = React.useState<BackendTargetRefV1>(() => initialBackendTarget);

    React.useEffect(() => {
        const matched = findEntryByTarget(params.entries, backendTarget);
        if (matched) return;
        setBackendTarget(initialBackendTarget);
    }, [backendTarget, initialBackendTarget, params.entries]);

    const builtInAgentId = React.useMemo(() => resolveBuiltInAgentIdForBackendTarget(backendTarget), [backendTarget]);

    React.useEffect(() => {
        const currentLastUsedBackendTarget = BackendTargetRefSchema.safeParse(params.lastUsedBackendTarget);
        const currentLastUsedBackendTargetKey = currentLastUsedBackendTarget.success
            ? buildBackendTargetKey(currentLastUsedBackendTarget.data)
            : null;
        const nextBackendTargetKey = buildBackendTargetKey(backendTarget);

        if (params.lastUsedAgent === builtInAgentId && currentLastUsedBackendTargetKey === nextBackendTargetKey) {
            return;
        }

        applySettings({
            lastUsedAgent: builtInAgentId,
            lastUsedBackendTarget: backendTarget,
        });
    }, [applySettings, backendTarget, builtInAgentId, params.lastUsedAgent, params.lastUsedBackendTarget]);

    return { backendTarget, setBackendTarget, builtInAgentId };
}
