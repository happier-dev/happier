import * as React from 'react';
import type { RoleEngineV1 } from '@happier-dev/protocol';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

export type RoleEnginePresentation = Readonly<{
    /** "Claude · opus-5.5 · high"; null when the engine follows the default agent. */
    label: string | null;
    icon: React.ReactNode;
    /**
     * The engine names an agent this Account has not enabled: "choose an engine". Said only once the
     * Agent catalog has answered (or cannot be read here); a catalog still loading claims nothing.
     */
    unavailable: boolean;
}>;

/**
 * Names a role's engine with the Agent catalog's own identity (title and mark). It reads only the
 * Account's enabled agents — no machine is asked anything — so a picker can name every role at once.
 */
export function useRoleEngineCatalog(serverId?: string | null) {
    const scope = useActiveServerAccountScope(serverId);
    const catalogAvailable = serverId === undefined || scope !== null;
    const { snapshot } = useAcpCatalog(serverId === undefined ? undefined : scope);
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const ready = catalogAvailable && snapshot?.catalog.status === 'ready' && !snapshot.stale;
    const entries = React.useMemo(() => {
        return ready && snapshot?.catalog.status === 'ready' ? getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
            acpCatalogSnapshot: snapshot.catalog,
            backendEnabledByTargetKey,
        }) : [];
    }, [snapshot, backendEnabledByTargetKey, ready]);
    return { entries, ready, scope, snapshot };
}

export function useRoleEnginePresentation(serverId?: string | null): (engine: RoleEngineV1 | undefined, iconSize?: number) => RoleEnginePresentation {
    const { entries, ready, scope, snapshot } = useRoleEngineCatalog(serverId);
    const settled = ready || (serverId !== undefined && scope === null)
        || snapshot?.catalog.status === 'unavailable' || snapshot?.catalog.status === 'partial';
    const entriesByTargetKey = React.useMemo(() => new Map<string, ResolvedBackendCatalogEntry>(
        entries.map((entry) => [entry.backendTargetKey, entry]),
    ), [entries]);

    return React.useCallback((engine, iconSize = 12) => {
        if (!engine) return { label: null, icon: null, unavailable: false };
        const entry = entriesByTargetKey.get(engine.agentTargetKey) ?? null;
        const parts = [entry?.title ?? null, engine.modelId ?? null, engine.effort ?? null]
            .filter((part): part is string => Boolean(part));
        return {
            label: parts.length > 0 ? joinHappierFacts(...parts) : null,
            icon: entry ? (
                <AgentCatalogIdentityIcon entry={entry.agentCatalogEntry} machineId={null} serverId={null} current={false} size={iconSize} />
            ) : null,
            unavailable: entry === null && settled,
        };
    }, [entriesByTargetKey, settled]);
}
