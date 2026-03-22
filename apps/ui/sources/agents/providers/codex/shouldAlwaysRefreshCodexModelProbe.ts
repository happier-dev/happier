import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

export function shouldAlwaysRefreshCodexModelProbe(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    codexBackendModeOverride?: 'mcp' | 'acp' | 'appServer' | null;
}>): boolean {
    if (resolveProviderAgentIdForBackendTarget(params.backendTarget) !== 'codex') {
        return false;
    }
    return params.codexBackendModeOverride === 'appServer';
}
