import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import type { TranslationKeyNoParams } from '@/text';

export function resolveAgentChannelLabelKey(
    channel: ResolvedAgentCatalogEntry['channel'],
): TranslationKeyNoParams {
    switch (channel) {
        case 'experimental':
            return 'settingsAgents.channelExperimental';
        case 'plugin':
            return 'settingsAgents.channelPlugin';
        case 'stable':
            return 'settingsAgents.channelStable';
        default:
            return 'settingsAgents.notAvailable';
    }
}
