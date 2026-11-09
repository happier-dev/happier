import * as React from 'react';
import type { ExecutionRunLaunchOrigin } from '@happier-dev/protocol/execution/runs/startRequest';

import { useDiscussionTitles } from '@/components/discussions/useDiscussionTitles';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { t } from '@/text';

const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** The Discussion a Run was launched from in the captured Home. */
export function readRunDiscussionOrigin(
    origin: ExecutionRunLaunchOrigin | null | undefined,
    serverId: string | null | undefined,
): Readonly<{ serverId: string; discussionId: string; messageCount: number }> | null {
    if (!origin || origin.kind !== 'discussion' || !serverId
        || !areServerProfileIdentifiersEquivalent(origin.serverId, serverId)) return null;
    return { serverId: origin.serverId, discussionId: origin.discussionId, messageCount: origin.messageIds.length };
}

/** "from Relay retry plan", or "from a conversation" while the title is unknown. */
export function formatRunDiscussionOriginLabel(title: string | null | undefined): string {
    const trimmed = title?.trim();
    return trimmed
        ? t('sessionConversation.origin.fromConversation', { title: trimmed })
        : t('sessionConversation.origin.fromUntitled');
}

/**
 * Where each roster row came from, keyed by subagent id — today only Agent conversations started
 * from a Discussion in this Home (Ask Agent). Rows with any other origin get no label.
 */
export function useSessionAgentRowOriginLabels(input: Readonly<{
    sessionId: string;
    serverId: string | null;
    subagents: readonly SessionSubagent[];
}>): ReadonlyMap<string, string> {
    const origins = React.useMemo(() => {
        const bySubagentId = new Map<string, string>();
        for (const subagent of input.subagents) {
            const origin = readRunDiscussionOrigin(subagent.runRef?.launchOrigin, input.serverId);
            if (origin) bySubagentId.set(subagent.id, origin.discussionId);
        }
        return bySubagentId;
    }, [input.serverId, input.subagents]);
    const discussionIds = React.useMemo(() => [...new Set(origins.values())].sort(), [origins]);
    const address = React.useMemo(
        () => discussionIds.length > 0 && input.serverId ? { serverId: input.serverId } : null,
        [discussionIds.length, input.serverId],
    );
    const titles = useDiscussionTitles({ address, discussionIds });
    return React.useMemo(() => {
        if (origins.size === 0) return NO_LABELS;
        const labels = new Map<string, string>();
        for (const [subagentId, discussionId] of origins) {
            labels.set(subagentId, formatRunDiscussionOriginLabel(titles.get(discussionId)));
        }
        return labels;
    }, [origins, titles]);
}
