import type { DiscussionAttentionResultV1 } from '@happier-dev/protocol/discussions/actions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { inboxItemViewV1, type InboxItemTypeV1, type InboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { PluginSessionInboxRowV1 } from '@happier-dev/protocol/plugins/contributions/ui/sessionInbox';
import type { PluginContextualResourceBinding } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import type { PluginDeclarativeButtonV1 } from '@happier-dev/protocol/plugins/contributions/declarativeButtonsV1';
import type { PluginDeclarativeProjectedActionBindingV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';

/** Host presentation over row intent and the current target Action catalog. */
export type InboxPluginSessionControl = Readonly<{
    id: string;
    label: string;
    effect: PluginDeclarativeButtonV1['effect'];
    action?: PluginDeclarativeProjectedActionBindingV1;
}>;

export type InboxPluginSessionRow = Readonly<{
    key: string;
    pluginId: string;
    indexResourceId: string;
    row: PluginSessionInboxRowV1;
    controls?: readonly InboxPluginSessionControl[];
    /** Supplied only by the admitted Resource owner, never serialized from a plugin row. */
    detailBinding?: PluginContextualResourceBinding;
}>;

export type InboxDiscussionSource = Readonly<{
    scope: ServerAccountScope;
    entries: DiscussionAttentionResultV1['discussions'];
    /** Exact-Home names from the existing batched Session title projection. */
    sessionDisplayNames?: ReadonlyMap<string, string | null>;
}>;

export type InboxItemView = InboxItemViewV1;
export type InboxItemType = InboxItemTypeV1;

export const inboxItemView = inboxItemViewV1;

/** Shared source admission; the badge needs neither thread reads nor row display joins. */
export function* admittedInboxDiscussionOccurrences(source: InboxDiscussionSource) {
    for (const { discussion, occurrences } of source.entries) {
        if (discussion.archivedAt !== null || !discussion.keyReadiness) continue;
        for (const occurrence of occurrences) {
            const { message } = occurrence;
            if (message.content === null || message.discussionId !== discussion.id
                || message.messageRef.discussion.serverId !== source.scope.serverId
                || message.messageRef.discussion.discussionId !== discussion.id) continue;
            yield { discussion, ...occurrence };
        }
    }
}
