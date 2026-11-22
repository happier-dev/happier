import { isDeepStrictEqual } from 'node:util';
import { DiscussionSettingsV1Schema, DiscussionSettingsV1StoredSchema, type DiscussionSettingsV1,
    type DiscussionSettingsResponseV1 } from '@happier-dev/protocol/discussions/settings';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { inTx, type Tx } from '@/storage/inTx';
import { prepareDiscussionMutationAccounts, resolveDiscussionContextInTx } from './access';
import { markDiscussionReadersChangedInTx } from './changes';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

type SettingsActor = Readonly<{ actorAccountId: string; discussionId: string; authentication: SessionAccessAuthentication }>;

/** Read operational settings for an already-admitted Discussion. */
export async function readDiscussionSettingsInTx(tx: Tx, discussionId: string): Promise<DiscussionResult<DiscussionSettingsResponseV1>> {
    const row = await tx.discussion.findUnique({ where: { id: discussionId }, select: { settingsV1: true } });
    if (!row) return discussionFailure('discussion_not_found');
    const settings = DiscussionSettingsV1StoredSchema.safeParse(row.settingsV1 ?? {});
    return settings.success ? discussionSuccess({ discussionId, settings: settings.data })
        : discussionFailure('discussion_content_unavailable');
}

/** Settings are operational facts, readable with live resource access without a content key. */
export async function getDiscussionSettings(input: SettingsActor): Promise<DiscussionResult<DiscussionSettingsResponseV1>> {
    return inTx(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
            accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        return readDiscussionSettingsInTx(tx, input.discussionId);
    });
}

/** Replace the closed override under the same parent/audience fence as management; no check-in state is stored here. */
export async function setDiscussionSettings(input: SettingsActor & Readonly<{ settings: DiscussionSettingsV1 }>): Promise<DiscussionResult<DiscussionSettingsResponseV1>> {
    const parsed = DiscussionSettingsV1Schema.safeParse(input.settings);
    if (!parsed.success) return discussionFailure('discussion_invalid_content');
    return inTx(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
            accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        if (context.access.level !== 'owner' && context.access.level !== 'admin') return discussionFailure('discussion_manage_denied');
        const row = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { settingsV1: true } });
        if (!row) return discussionFailure('discussion_not_found');
        if (!isDeepStrictEqual(row.settingsV1 ?? {}, parsed.data)) {
            await tx.discussion.update({ where: { id: input.discussionId }, data: { settingsV1: parsed.data } });
            await markDiscussionReadersChangedInTx({ tx, discussionId: input.discussionId });
        }
        return discussionSuccess({ discussionId: input.discussionId, settings: parsed.data });
    }, { prepare: () => prepareDiscussionMutationAccounts(input) });
}
