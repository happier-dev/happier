import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

export type SessionConversationAttentionReason = 'mentioned' | 'unread_discussion';

/**
 * The conversation half of the canonical personal attention projection, as one classification for
 * every Collaboration entry point (the header facepile and the rail dot).
 *
 * A mention outranks ordinary unread discussion for the same reason the Protocol reason ladder
 * declares it first: it is the one targeted signal. No unread *count* reaches this client — the
 * server collapses the discussion facts into booleans before they become `viewer.attention` — so
 * the result is a reason, never a number.
 */
export function classifySessionConversationAttention(
    viewer: SessionListRenderableSession['viewer'] | null | undefined,
): SessionConversationAttentionReason | null {
    if (viewer?.readState.state !== 'tracking' || !viewer.attention.needsAttention) return null;
    if (viewer.attention.reasons.includes('mentioned')) return 'mentioned';
    return viewer.attention.reasons.includes('unread_discussion') ? 'unread_discussion' : null;
}

/**
 * The exact Home's conversation attention for one Session, selected as a primitive so a
 * subscriber re-renders only when the reason itself changes, never on unrelated row updates.
 */
export function useSessionConversationAttentionReason(target: SessionAddress | null): SessionConversationAttentionReason | null {
    const serverId = target?.serverId ?? null;
    const sessionId = target?.sessionId ?? null;
    return getStorage()((state) => classifySessionConversationAttention(
        readSessionListRowForServerId(state.sessionListRowsByServerId, serverId, sessionId)?.viewer,
    ));
}

/** The one summary bit always-mounted chrome (the action rail) reads: an unread mention. */
export function useSessionConversationMentioned(target: SessionAddress | null): boolean {
    return useSessionConversationAttentionReason(target) === 'mentioned';
}

/**
 * The Collaboration rail tab's dot: unread mentions only, with no count — plain unread
 * conversations stay quiet. Mounted by the rail as a leaf so only this dot subscribes.
 */
export const SessionCollaborationRailBadge = React.memo(function SessionCollaborationRailBadge(props: Readonly<{
    target: SessionAddress;
    /** `inline`: at the end of a row (the phone More sheet) instead of on a rail glyph's corner. */
    placement?: 'glyph' | 'inline';
    testID?: string;
    renderSignal?: RailBadgeSignalRenderer;
}>) {
    const { theme } = useUnistyles();
    const mentioned = useSessionConversationMentioned(props.target);
    if (props.renderSignal) return <>{props.renderSignal(mentioned ? { kind: 'dot', tone: 'accent' } : null)}</>;
    if (!mentioned) return null;
    return (
        <TabBadge
            variant="dot"
            testID={props.testID ?? 'session-action-rail:collaboration:badge'}
            style={props.placement === 'inline'
                ? { position: 'relative', top: 0, right: 0, backgroundColor: theme.colors.text.link }
                : { backgroundColor: theme.colors.text.link }}
        />
    );
});
