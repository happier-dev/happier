import { useCallback } from 'react';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type { SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { isUntitledSessionName } from '@/utils/sessions/sessionUtils';

/**
 * A Session as a Discussion names it (an answer's byline, a mention, a hold, who is waiting): its title, or for
 * an untitled one its Agent, never the generic untitled word that every untitled answer would share.
 */
function resolveDiscussionSessionLabel(source: SessionDisplayNameSource | null): string | null {
    const title = sessionDisplayTitle(source);
    if (!source || title === null || !(isUntitledSessionName(title) || title === t('session.folderless.untitledChat'))) return title;
    const agentId = readSessionPresentationAgentId(source);
    return agentId ? resolveAgentCatalogTitle(agentId) : title;
}

/**
 * Who a waiting line names: the Session's own title or its Agent, never the generic untitled word, which would
 * name no one ("Untitled session needs approval"). Null keeps the generic line.
 */
function resolveDiscussionWaitingSessionName(source: SessionDisplayNameSource | null): string | null {
    const label = resolveDiscussionSessionLabel(source);
    return label === null || isUntitledSessionName(label) || label === t('session.folderless.untitledChat') ? null : label;
}

/** Incidental references retain their target while capture privacy withholds identity. */
export function discussionSessionLabel(source: SessionDisplayNameSource | null): string | null {
    return source && !readSessionRecordingVisibility()({ sessionId: source.id, serverId: source.serverId })
        ? null : resolveDiscussionSessionLabel(source);
}

export function discussionWaitingSessionName(source: SessionDisplayNameSource | null): string | null {
    return source && !readSessionRecordingVisibility()({ sessionId: source.id, serverId: source.serverId })
        ? null : resolveDiscussionWaitingSessionName(source);
}

/** Stable store projection renewed only when the shared privacy owner changes. */
export function useDiscussionSessionLabelProjection(waiting = false) {
    const isSessionVisible = useSessionRecordingVisibility();
    return useCallback((source: SessionDisplayNameSource | null) => {
        if (source && !isSessionVisible({ sessionId: source.id, serverId: source.serverId })) return null;
        return waiting ? resolveDiscussionWaitingSessionName(source) : resolveDiscussionSessionLabel(source);
    }, [isSessionVisible, waiting]);
}

/** The Agent an Agent answer wears as its face (lab T2-A), read from the same Session projection and privacy owner as its name. */
export function useDiscussionSessionAgentIdProjection() {
    const isSessionVisible = useSessionRecordingVisibility();
    return useCallback((source: SessionDisplayNameSource | null) => source && isSessionVisible({ sessionId: source.id, serverId: source.serverId })
        ? readSessionPresentationAgentId(source) : null, [isSessionVisible]);
}
