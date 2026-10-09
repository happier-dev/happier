import type { Metadata } from '@happier-dev/session-core/state';
import { PluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import { SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

/** The ordinary creation checkpoint writes only the registered owner-private work field. */
export async function persistCreatedSessionAuthoringOrigin(params: Readonly<{
    sessionId: string;
    serverId: string;
    origin: PluginUiNewSessionSeedOriginV1;
    shouldContinue: () => boolean;
    updateSessionMetadataWithRetry: (
        sessionId: string,
        updater: (metadata: Metadata) => Metadata,
        options: Readonly<{ serverId: string; shouldContinue: () => boolean }>,
    ) => Promise<void>;
}>): Promise<void> {
    const origin = PluginUiNewSessionSeedOriginV1Schema.parse(params.origin);
    await params.updateSessionMetadataWithRetry(params.sessionId, (metadata) => {
        const work = SessionOwnerMetadataV1Schema.shape.work.parse(metadata.work);
        return { ...metadata, work: { ...work, authoringOriginV1: origin } };
    }, { serverId: params.serverId, shouldContinue: params.shouldContinue });
}
