import type { BundledAgentId } from '@happier-dev/agents';
import { getAgentCliRuntimeSpec, getProviderCliInstallGuideUrl } from '@happier-dev/agents';

/**
 * Install banner for a bundled Agent's generated catalog UI config.
 *
 * An externally installed Agent has no entry in the generated bundled CLI
 * table; its banner comes from its own plugin contribution instead.
 */
export function buildAgentCliInstallBanner(
    providerId: BundledAgentId,
    options: Readonly<{ guideUrl?: string | null }> = {},
) {
    const runtimeSpec = getAgentCliRuntimeSpec(providerId);
    return {
        installKind: 'ifAvailable' as const,
        guideUrl: options.guideUrl ?? getProviderCliInstallGuideUrl(providerId) ?? runtimeSpec.docsUrl ?? undefined,
    };
}
