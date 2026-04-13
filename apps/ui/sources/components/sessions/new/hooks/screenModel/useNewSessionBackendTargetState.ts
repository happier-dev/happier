import * as React from 'react';

import { BackendTargetRefSchema, buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTargetFromSettings';
import { resolveBuiltInAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useApplySettings } from '@/sync/store/settingsWriters';

function findEntryByTarget(
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
    target: BackendTargetRefV1,
): ResolvedBackendCatalogEntry | null {
    const targetKey = buildBackendTargetKey(target);
    return entries.find((entry) => entry.targetKey === targetKey) ?? null;
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
    const initialBackendTarget = React.useMemo(() => {
        return resolvePreferredBackendTarget({
            candidateBackendTargets: [params.tempBackendTarget, params.persistedBackendTarget],
            preferredBuiltInAgentIds: [params.tempAgentType],
            availableBackendTargets: params.entries.map((entry) => entry.target),
            lastUsedAgent: params.lastUsedAgent,
            lastUsedBackendTarget: params.lastUsedBackendTarget,
        });
    }, [params.entries, params.lastUsedAgent, params.lastUsedBackendTarget, params.persistedBackendTarget, params.tempBackendTarget, params.tempAgentType]);
    const [backendTarget, setBackendTarget] = React.useState<BackendTargetRefV1>(() => initialBackendTarget);

    React.useEffect(() => {
        const matched = findEntryByTarget(params.entries, backendTarget);
        if (matched) return;
        setBackendTarget(initialBackendTarget);
    }, [backendTarget, initialBackendTarget, params.entries]);

    const builtInAgentId = React.useMemo(() => resolveBuiltInAgentIdForBackendTarget(backendTarget), [backendTarget]);
    const nextLastUsedAgent = React.useMemo(() => resolvePersistedAgentIdForBackendTarget({
        backendTarget,
        persistedAgentId: params.lastUsedAgent,
        selectedBuiltInAgentId: builtInAgentId,
    }), [backendTarget, builtInAgentId, params.lastUsedAgent]);

    React.useEffect(() => {
        const currentLastUsedBackendTarget = BackendTargetRefSchema.safeParse(params.lastUsedBackendTarget);
        const currentLastUsedBackendTargetKey = currentLastUsedBackendTarget.success
            ? buildBackendTargetKey(currentLastUsedBackendTarget.data)
            : null;
        const nextBackendTargetKey = buildBackendTargetKey(backendTarget);

        if (params.lastUsedAgent === nextLastUsedAgent && currentLastUsedBackendTargetKey === nextBackendTargetKey) {
            return;
        }

        applySettings({
            lastUsedAgent: nextLastUsedAgent,
            lastUsedBackendTarget: backendTarget,
        });
    }, [applySettings, backendTarget, nextLastUsedAgent, params.lastUsedAgent, params.lastUsedBackendTarget]);

    return { backendTarget, setBackendTarget, builtInAgentId };
}
