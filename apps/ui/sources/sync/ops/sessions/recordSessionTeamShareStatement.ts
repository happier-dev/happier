import { addSessionTeamsToShareStatementV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * A key holder's statement that this Session is shared with a Team, sealed into its metadata
 * through the one tuple owner. The daemon delivers keys to later Team members only on it.
 */
export async function recordSessionTeamShareStatement(input: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    teamId: string;
    isCurrent: () => boolean;
}>): Promise<void> {
    const { sync } = await import('@/sync/sync');
    await sync.patchSessionMetadataWithRetry(
        input.sessionId,
        metadata => addSessionTeamsToShareStatementV1(metadata, [input.teamId]),
        { accountLifetime: { scope: input.scope, isCurrent: input.isCurrent } },
    );
}
