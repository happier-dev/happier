import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { resolveAgentConfiguredRuntimeKind } from '@happier-dev/agents';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { Settings } from '@/sync/domains/settings/settings';

export type NewSessionCapabilityProbeContext = Readonly<{
    cacheKeySuffixParts?: readonly string[] | null;
    capabilityParams?: Readonly<Record<string, unknown>> | null;
}>;

export function resolveNewSessionCapabilityProbeContext(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    settings: Settings;
}>): NewSessionCapabilityProbeContext | null {
    const agentId = resolveProviderAgentIdForBackendTarget(params.backendTarget);
    const runtimeKind = resolveAgentConfiguredRuntimeKind({
        agentId,
        accountSettings: params.settings as unknown as Record<string, unknown>,
    });
    if (!runtimeKind) return null;

    return {
        cacheKeySuffixParts: [runtimeKind],
        capabilityParams: {
            runtimeKindOverride: runtimeKind,
        },
    };
}

