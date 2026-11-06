import type { QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectGroupIdentityKey } from '@/sync/domains/workspaces/projectGroupDisplay';
import { buildSessionWorkspaceFallbackOrderKey, readSessionWorkspaceFallbackIdentity } from '@/sync/domains/session/listing/sessionWorkspaceOrderKeys';

/** Consume the admitted list identity and its existing serialization owner. */
export function readSessionAppearanceWorkspaceKey(input: Readonly<{
    projectKey?: QualifiedProjectKeyV1;
    fallbackGroupDisplay?: Readonly<{ groupKey: string }>;
}>): string | null {
    if (input.projectKey) return projectGroupIdentityKey(input.projectKey);
    const key = input.fallbackGroupDisplay?.groupKey;
    const identity = key ? readSessionWorkspaceFallbackIdentity(key) : null;
    return identity ? buildSessionWorkspaceFallbackOrderKey(identity) : null;
}
