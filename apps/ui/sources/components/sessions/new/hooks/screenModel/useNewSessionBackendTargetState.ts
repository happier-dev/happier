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

function resolveExplicitBackendTarget(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
}>): BackendTargetRefV1 | null {
    for (const raw of [params.routeBackendTarget, params.tempBackendTarget, params.persistedBackendTarget]) {
        const parsed = BackendTargetRefSchema.safeParse(raw);
        if (!parsed.success) continue;
        const matched = findEntryByTarget(params.entries, parsed.data);
        if (matched) {
            return matched.target;
        }
    }
    if (isAgentId(params.tempAgentType)) {
        return findEntryByTarget(params.entries, { kind: 'builtInAgent', agentId: params.tempAgentType })?.target ?? null;
    }
    return null;
}

function resolveInitialBackendTarget(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
}>): BackendTargetRefV1 {
    // Authored targets survive restoration; the spawn owner rejects incompatible profiles.
    const explicit = resolveExplicitBackendTarget(params);
    if (explicit) return explicit;

    let implicitTarget: BackendTargetRefV1 | null = null;
    const lastUsedBackendTarget = BackendTargetRefSchema.safeParse(params.lastUsedBackendTarget);
    if (lastUsedBackendTarget.success) {
        const matched = findEntryByTarget(params.entries, lastUsedBackendTarget.data);
        if (matched) {
            implicitTarget = matched.target;
        }
    }

    if (!implicitTarget) {
        const preferredBuiltInAgentId =
            isAgentId(params.tempAgentType) ? params.tempAgentType
            : isAgentId(params.lastUsedAgent) ? params.lastUsedAgent
            : DEFAULT_AGENT_ID;
        const builtInTarget: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: preferredBuiltInAgentId };
        const matchedBuiltIn = findEntryByTarget(params.entries, builtInTarget);
        if (matchedBuiltIn) {
            implicitTarget = matchedBuiltIn.target;
        }
    }

    return implicitTarget ?? params.entries[0]?.target ?? { kind: 'builtInAgent', agentId: DEFAULT_AGENT_ID };
}

export function useNewSessionBackendTargetState(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
}>): Readonly<{
    backendTarget: BackendTargetRefV1;
    setBackendTarget: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    setBackendTargetAutomatically: React.Dispatch<React.SetStateAction<BackendTargetRefV1>>;
    hasExplicitBackendTarget: boolean;
    builtInAgentId: AgentId;
}> {
    const applySettings = useApplySettings();
    const initialBackendTarget = React.useMemo(() => resolveInitialBackendTarget(params), [
        params.entries,
        params.lastUsedAgent,
        params.lastUsedBackendTarget,
        params.persistedBackendTarget,
        params.routeBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
    ]);
    // Capture authored seeds once: the live draft later contains automatic corrections too.
    const [hasExplicitSeed] = React.useState(() => resolveExplicitBackendTarget(params) !== null);
    const [backendTarget, setBackendTargetState] = React.useState<BackendTargetRefV1>(() => initialBackendTarget);
    // TOO EARLY: only a real user selection persists the "last used" target. Resolving an
    // initial target on mount (route param, temp handoff, persisted draft) used to write
    // settings from a mount effect, which costs a settings round-trip on every such open.
    // The launch path already persists `lastUsedAgent`/`lastUsedBackendTarget` when a session
    // is actually created (`useCreateNewSession`), so nothing is lost by waiting.
    const hasUserSelectedBackendTargetRef = React.useRef(false);
    const shouldPersistBackendTargetRef = React.useRef(false);
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<BackendTargetRefV1>>>((next) => {
        hasUserSelectedBackendTargetRef.current = true;
        shouldPersistBackendTargetRef.current = true;
        setBackendTargetState(next);
    }, []);
    const setBackendTargetAutomatically = React.useCallback<React.Dispatch<React.SetStateAction<BackendTargetRefV1>>>((next) => {
        shouldPersistBackendTargetRef.current = false;
        setBackendTargetState(next);
    }, []);

    React.useEffect(() => {
        const matched = findEntryByTarget(params.entries, backendTarget);
        if (matched) return;
        setBackendTargetAutomatically(initialBackendTarget);
    }, [backendTarget, initialBackendTarget, params.entries, setBackendTargetAutomatically]);

    const builtInAgentId = React.useMemo(() => resolveBuiltInAgentIdForBackendTarget(backendTarget), [backendTarget]);

    React.useEffect(() => {
        if (!shouldPersistBackendTargetRef.current) return;
        shouldPersistBackendTargetRef.current = false;
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

    return {
        backendTarget,
        setBackendTarget,
        setBackendTargetAutomatically,
        hasExplicitBackendTarget: hasExplicitSeed || hasUserSelectedBackendTargetRef.current,
        builtInAgentId,
    };
}
