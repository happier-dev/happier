import { formatAgentLikeIdForDisplay, getNeutralAgentIdentityColor, readConcreteAgentPresentation } from '@happier-dev/agents/presentation';
import { isUnattributedUsageAgentId } from '@happier-dev/protocol/usage/usageFormatting';

/** The cold renderer's projection of the same catalog names and neutral fallbacks used by Usage. */
export function publicProfileAgentPresentation(id: string, scheme: 'light' | 'dark') {
    const metadata = readConcreteAgentPresentation(id);
    return {
        id,
        name: isUnattributedUsageAgentId(id) ? 'Unknown' : metadata?.name ?? formatAgentLikeIdForDisplay(id),
        color: metadata?.identityColor?.[scheme] ?? getNeutralAgentIdentityColor({ dark: scheme === 'dark' }),
    };
}
