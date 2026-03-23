import { buildBackendTargetKey, isBuiltInAgentTarget, type AcpCatalogSettingsV1, type BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { getAgentCore, isAgentId } from '@/agents/catalog/catalog';
import { normalizeAcpCatalogSettingsV1 } from '@/sync/domains/acpCatalog/normalizeAcpCatalogSettingsV1';
import { t } from '@/text';

export type ResolvedBackendCatalogEntry = Readonly<{
    target: BackendTargetRefV1;
    targetKey: string;
    family: 'builtInAgent' | 'configuredAcpBackend';
    providerAgentId: AgentId;
    builtInAgentId: AgentId | null;
    iconAgentId: AgentId;
    title: string;
    subtitle: string | null;
}>;

export function getResolvedBackendCatalogEntries(params: Readonly<{
    enabledAgentIds: readonly AgentId[];
    acpCatalogSettingsV1: AcpCatalogSettingsV1;
    backendEnabledByTargetKey?: Readonly<Record<string, boolean>> | null;
    collapseConfiguredBackendProviderSentinels?: boolean;
}>): ResolvedBackendCatalogEntry[] {
    const builtIns: ResolvedBackendCatalogEntry[] = params.enabledAgentIds
        .filter((agentId) => agentId !== 'customAcp')
        .map((agentId) => {
            const core = getAgentCore(agentId);
            const target: BackendTargetRefV1 = { kind: 'builtInAgent', agentId };
            return {
                target,
                targetKey: buildBackendTargetKey(target),
                family: 'builtInAgent',
                providerAgentId: agentId,
                builtInAgentId: agentId,
                iconAgentId: agentId,
                title: t(core.displayNameKey),
                subtitle: agentId,
            };
        });

    const catalog = normalizeAcpCatalogSettingsV1(
        params.acpCatalogSettingsV1 ?? { v: 2, backends: [] },
    );
    const configuredBackends: ResolvedBackendCatalogEntry[] = catalog.backends.flatMap((backend) => {
        const target: BackendTargetRefV1 = { kind: 'configuredAcpBackend', backendId: backend.id };
        const targetKey = buildBackendTargetKey(target);
        if (params.backendEnabledByTargetKey?.[targetKey] === false) {
            return [];
        }
        return [{
            target,
            targetKey,
            family: 'configuredAcpBackend',
            providerAgentId: 'customAcp',
            builtInAgentId: null,
            iconAgentId: 'customAcp',
            title: backend.title || backend.name,
            subtitle: backend.name,
        }];
    });

    if (params.collapseConfiguredBackendProviderSentinels !== true || configuredBackends.length === 0) {
        return [...builtIns, ...configuredBackends];
    }

    const configuredProviderAgentIds = new Set(configuredBackends.map((entry) => entry.providerAgentId));
    return [
        ...builtIns.filter((entry) => !configuredProviderAgentIds.has(entry.providerAgentId)),
        ...configuredBackends,
    ];
}

export function resolveProviderAgentIdForBackendTarget(target: BackendTargetRefV1): AgentId {
    return isBuiltInAgentTarget(target) && isAgentId(target.agentId) ? target.agentId : 'customAcp';
}

export function resolveBuiltInAgentIdForBackendTarget(target: BackendTargetRefV1): AgentId {
    return resolveProviderAgentIdForBackendTarget(target);
}
