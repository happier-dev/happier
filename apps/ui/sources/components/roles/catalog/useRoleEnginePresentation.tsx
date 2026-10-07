import * as React from 'react';
import type { RoleEngineV1 } from '@happier-dev/protocol';

import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';

export type RoleEnginePresentation = Readonly<{
    /** "Claude · opus-5.5 · high"; null when the engine follows the default agent. */
    label: string | null;
    icon: React.ReactNode;
    /** The engine names an agent this Account has not enabled: "choose an engine". */
    unavailable: boolean;
}>;

/**
 * Names a role's engine with the Agent catalog's own identity (title and mark). It reads only the
 * Account's enabled agents — no machine is asked anything — so a picker can name every role at once.
 */
export function useRoleEnginePresentation(serverId?: string | null): (engine: RoleEngineV1 | undefined, iconSize?: number) => RoleEnginePresentation {
    const scope = useActiveServerAccountScope(serverId);
    const catalogAvailable = serverId === undefined || scope !== null;
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const entriesByTargetKey = React.useMemo(() => {
        const entries = catalogAvailable ? getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey }),
            acpCatalogSettingsV1,
            backendEnabledByTargetKey,
        }) : [];
        return new Map<string, ResolvedBackendCatalogEntry>(entries.map((entry) => [entry.backendTargetKey, entry]));
    }, [acpCatalogSettingsV1, backendEnabledByTargetKey, catalogAvailable]);

    return React.useCallback((engine, iconSize = 12) => {
        if (!engine) return { label: null, icon: null, unavailable: false };
        const entry = entriesByTargetKey.get(engine.agentTargetKey) ?? null;
        const parts = [entry?.title ?? null, engine.modelId ?? null, engine.effort ?? null]
            .filter((part): part is string => Boolean(part));
        return {
            label: parts.length > 0 ? parts.join(' · ') : null,
            icon: entry ? (
                <AgentCatalogIdentityIcon entry={entry.agentCatalogEntry} machineId={null} serverId={null} current={false} size={iconSize} />
            ) : null,
            unavailable: entry === null,
        };
    }, [entriesByTargetKey]);
}
