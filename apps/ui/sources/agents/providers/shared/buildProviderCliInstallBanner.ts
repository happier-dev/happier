import type { AgentId } from '@happier-dev/agents';
import { getProviderCliInstallGuideUrl, getProviderCliRuntimeSpec } from '@happier-dev/agents';

export function buildProviderCliInstallBanner(
    providerId: AgentId,
    options: Readonly<{ guideUrl?: string | null }> = {},
) {
    const runtimeSpec = getProviderCliRuntimeSpec(providerId);
    return {
        installKind: 'ifAvailable' as const,
        guideUrl: options.guideUrl ?? getProviderCliInstallGuideUrl(providerId) ?? runtimeSpec.docsUrl ?? undefined,
    };
}
