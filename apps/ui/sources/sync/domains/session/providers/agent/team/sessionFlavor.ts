import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

export function resolveAgentTeamSessionFlavor(metadata: unknown): string | null {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        const rawFlavor = (metadata as Record<string, unknown>).flavor;
        if (typeof rawFlavor === 'string' && rawFlavor.trim().length > 0) {
            return rawFlavor;
        }
    }
    return resolveAgentIdFromSessionMetadata(metadata);
}
