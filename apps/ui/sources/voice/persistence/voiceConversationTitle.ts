import { hasSessionTitleInMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { publishDisplayTitleMetadataMutation } from '@/sync/state/displayTitlePublish';
import { formatSessionFirstMessageTitle } from '@/sync/state/selectors';

/** Publish first human content through the ordinary Session naming authority. */
export async function publishVoiceConversationFirstHumanTitle(sessionId: string, text: string): Promise<void> {
    const session = storage.getState().sessions[sessionId];
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    if (!session || !metadata || hasSessionTitleInMetadata(metadata)) return;
    const title = formatSessionFirstMessageTitle(text, true);
    if (!title) return;
    const { sync } = await import('@/sync/sync');
    await publishDisplayTitleMetadataMutation({
        sessionId, title, preserveExistingValue: true,
        updateSessionMetadataWithRetry: (id, updater) => sync.patchSessionMetadataWithRetry(id, updater, {
            serverId: session.serverId,
        }),
    });
}
