import type { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';

export type SessionDraftTextAppend = Readonly<{
    sessionId: string;
    serverId: string;
    text: string;
    sourceSessionId?: string;
    discussionSource?: Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;
}>;

/** Send-to surfaces share the existing Action admission and the repository append owner. */
export async function appendSessionDraftText({ serverId, ...input }: SessionDraftTextAppend): Promise<void> {
    const result = await createFrontDoorActionExecute()('session.draft.append', input, { surface: 'ui', serverId });
    requireActionSuccess(result);
    // The Action executor has already validated this output against its declaration.
    const output = result.result as ReturnType<typeof AppShellActionOutputSchemas['session.draft.append']['parse']>;
    if (output.status !== 'appended') throw new HappyError('Session draft unavailable', false, { code: 'session_draft_unavailable' });
}
