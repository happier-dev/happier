import type { UsageCoachRemedySession } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export { buildUsageCoachRemedies } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';

/** Retain only remedy targets and exact intent witnesses from this admitted Session. */
export function projectUsageCoachRemedySession(session: Pick<Session,
    'id' | 'serverId' | 'active' | 'access' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'>): UsageCoachRemedySession {
    const metadata = readSessionOwnerMetadataView(session);
    return {
        id: session.id, serverId: session.serverId, active: session.active,
        access: session.access ?? undefined,
        ownerMetadata: metadata ? { machineId: metadata.machineId, path: metadata.path,
            modelSelectionIntentV1: metadata.modelSelectionIntentV1,
            modelSelectionIntentV2: metadata.modelSelectionIntentV2, mcpSelectionV1: metadata.mcpSelectionV1 } : null,
        agentTarget: resolveSessionActionDefaultBackend({ session })?.agentTarget ?? null,
    };
}
