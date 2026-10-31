import * as React from 'react';

import { BackendTargetRefSchema, buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { DEFAULT_AGENT_ID, isAgentId } from '@/agents/catalog/catalog';
import { resolveBuiltInAgentIdForBackendTarget, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getProfileDefaultBackendTarget, isProfileCompatibleWithBackendTarget } from '@/sync/domains/profiles/profileCompatibility';
import { useApplySettings } from '@/sync/store/settingsWriters';

function findEntryByTarget(
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
    target: BackendTargetRefV1,
): ResolvedBackendCatalogEntry | null {
    const targetKey = buildBackendTargetKey(target);
    return entries.find((entry) => entry.targetKey === targetKey) ?? null;
}

/**
 * The profile's default backend target when it resolves to an available entry, or null.
 * Callers must additionally verify the target is compatible with the profile and available
 * on the target machine.
 */
function resolveProfileDefaultTarget(
    profile: AIBackendProfile,
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>,
): BackendTargetRefV1 | null {
    const defaultTarget = getProfileDefaultBackendTarget(profile);
    if (!defaultTarget || !isProfileCompatibleWithBackendTarget(profile, defaultTarget)) return null;
    return findEntryByTarget(entries, defaultTarget)?.target ?? null;
}

function resolveInitialBackendTarget(params: Readonly<{
    entries: ReadonlyArray<ResolvedBackendCatalogEntry>;
    routeBackendTarget?: unknown;
    persistedBackendTarget?: unknown;
    tempBackendTarget?: unknown;
    tempAgentType?: unknown;
    lastUsedAgent: unknown;
    lastUsedBackendTarget?: unknown;
    profile?: AIBackendProfile | null;
}>): BackendTargetRefV1 {
    // Explicit caller-authored targets (route params, temp handoffs, persisted drafts) keep
    // their choice even when a profile is selected; the wizard blocks incompatible spawns.
    const routeTarget = BackendTargetRefSchema.safeParse(params.routeBackendTarget);
    if (routeTarget.success) {
        const matched = findEntryByTarget(params.entries, routeTarget.data);
        if (matched) {
            return matched.target;
        }
    }

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

    // A selected profile's default backend target outranks remembered habits: sessions
    // started under the profile use the profile's agent unless the caller chose one.
    if (params.profile) {
        const profileDefault = resolveProfileDefaultTarget(params.profile, params.entries);
        if (profileDefault) {
            return profileDefault;
        }
    }

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

    // The initial selection must respect the profile's allowed backends.
    if (params.profile && implicitTarget && !isProfileCompatibleWithBackendTarget(params.profile, implicitTarget)) {
        const firstCompatible = params.entries.find(
            (entry) => isProfileCompatibleWithBackendTarget(params.profile!, entry.target),
        );
        if (firstCompatible) {
            return firstCompatible.target;
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
    profile?: AIBackendProfile | null;
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
        params.profile,
        params.routeBackendTarget,
        params.tempBackendTarget,
        params.tempAgentType,
    ]);
    const [backendTarget, setBackendTargetState] = React.useState<BackendTargetRefV1>(() => initialBackendTarget);
    // TOO EARLY: only a real user selection persists the "last used" target. Resolving an
    // initial target on mount (route param, temp handoff, persisted draft) used to write
    // settings from a mount effect, which costs a settings round-trip on every such open.
    // The launch path already persists `lastUsedAgent`/`lastUsedBackendTarget` when a session
    // is actually created (`useCreateNewSession`), so nothing is lost by waiting.
    const hasUserSelectedBackendTargetRef = React.useRef(false);
    const setBackendTarget = React.useCallback<React.Dispatch<React.SetStateAction<BackendTargetRefV1>>>((next) => {
        hasUserSelectedBackendTargetRef.current = true;
        setBackendTargetState(next);
    }, []);

    React.useEffect(() => {
        const matched = findEntryByTarget(params.entries, backendTarget);
        if (matched) return;
        setBackendTargetState(initialBackendTarget);
    }, [backendTarget, initialBackendTarget, params.entries]);

    // Selecting a profile applies its default backend target when it has one. This is a
    // programmatic correction on the profile transition only, not a user selection: it must
    // not persist `lastUsedAgent`/`lastUsedBackendTarget` (same rule as initial resolution
    // above), and it must not fight a later manual backend choice (transition-ref guarded).
    // A profile without an explicit default never yanks the current backend; its allowed
    // backends are still enforced by disabled options and the spawn guard.
    const profile = params.profile;
    const prevProfileRef = React.useRef(profile);
    React.useEffect(() => {
        if (prevProfileRef.current === profile) return;
        prevProfileRef.current = profile;
        if (!profile) return;
        const next = resolveProfileDefaultTarget(profile, params.entries);
        if (next) {
            setBackendTargetState(next);
        }
    }, [params.entries, profile]);

    const builtInAgentId = React.useMemo(() => resolveBuiltInAgentIdForBackendTarget(backendTarget), [backendTarget]);

    React.useEffect(() => {
        if (!hasUserSelectedBackendTargetRef.current) return;
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
