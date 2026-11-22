import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { DiscussionDetailsTarget, DiscussionHomeAddress } from './discussionDetailsTarget';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { DiscussionAnchorV1Schema, type DiscussionAnchorV1 } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions/references';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { SessionDraftAddressV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

export type DiscussionSourceSurface = SessionMobileSurface | 'discussions';
export type AnchoredDiscussionSourceLink = Readonly<{ discussion: DiscussionAddressV1; source: SessionMessageRefV1; href: string }>;

export function buildDiscussionsRouteHref(address: DiscussionHomeAddress): string {
    return `/discussions?${new URLSearchParams({ serverId: address.serverId })}`;
}

/** One Discussion's Storage page (storage-view lab scene 5 A, phone): pushed from its "…" or its Details surface. */
export function buildDiscussionStorageRouteHref(input: Readonly<{ serverId: string; discussionId: string }>): string {
    return `/discussions/storage?${new URLSearchParams({ serverId: input.serverId, discussionId: input.discussionId })}`;
}

/** A supplied invalid key is unavailable, never the ordinary singleton draft. */
export function readDiscussionRouteDraftId(value: string | string[] | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    const parsed = SessionDraftAddressV2Schema.safeParse({ kind: 'newDiscussion', draftId: value });
    return parsed.success && parsed.data.kind === 'newDiscussion' && parsed.data.draftId !== undefined ? parsed.data.draftId : null;
}

/** Null is an invalid supplied anchor; absence is distinct so a route cannot silently drop its source. */
export function readDiscussionRouteAnchor(input: Readonly<{
    serverId: string | null; anchor?: string | null; anchorSessionId?: string | null; anchorMessageId?: string | null;
}>): DiscussionAnchorV1 | null | undefined {
    if (!input.anchor) return input.anchorSessionId
        ? { kind: 'session', sessionId: input.anchorSessionId, ...(input.anchorMessageId ? { messageId: input.anchorMessageId } : {}) }
        : undefined;
    if (input.anchorSessionId || input.anchorMessageId) return null;
    let value: unknown;
    try { value = JSON.parse(input.anchor); } catch { return null; }
    const parsed = DiscussionAnchorV1Schema.safeParse(value);
    if (!parsed.success) return null;
    if (parsed.data.kind === 'task') return input.serverId ? parsed.data : null;
    return parsed.data.kind === 'doc'
        && areServerProfileIdentifiersEquivalent(parsed.data.doc.ref.serverId, input.serverId) ? parsed.data : null;
}

/** Consume the authorized anchored list once per Session; message rows never query or invent markers. */
export function readAnchoredDiscussionSourceLinks(input: Readonly<{
    address: DiscussionHomeAddress;
    source: SessionMessageRefV1;
    discussions: readonly Readonly<{ id: string; anchor: DiscussionAnchorV1 | null }>[];
}>): readonly AnchoredDiscussionSourceLink[] {
    if (input.address.serverId !== input.source.session.serverId) return [];
    return input.discussions.flatMap(discussion => discussion.anchor?.kind === 'session'
        && discussion.anchor.sessionId === input.source.session.sessionId
        && discussion.anchor.messageId === input.source.messageId ? [{
            discussion: { serverId: input.address.serverId, discussionId: discussion.id }, source: input.source,
            href: buildDiscussionRouteHref({ target: { kind: 'discussion', address: input.address, discussionId: discussion.id },
                sourceSurface: 'collaboration' }),
        }] : []);
}

/** The resource's Home is captured before navigation; an anchor is only an optional source link. */
export function buildDiscussionRouteHref(input: Readonly<{
    target: DiscussionDetailsTarget;
    sourceSurface?: DiscussionSourceSurface;
    /** Opened from a passage in this Doc: Back names it and returns to it. */
    returnArtifactId?: string;
}>): string {
    const query = new URLSearchParams({ serverId: input.target.address.serverId });
    if (input.sourceSurface) query.set('sourceSurface', input.sourceSurface);
    if (input.returnArtifactId) query.set('returnArtifactId', input.returnArtifactId);
    if (input.target.kind === 'discussion' && input.target.messageId) query.set('messageId', input.target.messageId);
    if (input.target.kind === 'new' && input.target.draftId !== undefined) {
        const address = SessionDraftAddressV2Schema.parse({ kind: 'newDiscussion', draftId: input.target.draftId });
        if (address.kind === 'newDiscussion' && address.draftId !== undefined) query.set('draftId', address.draftId);
    }
    if (input.target.kind === 'new' && input.target.anchor) {
        const anchor = DiscussionAnchorV1Schema.parse(input.target.anchor);
        if (anchor.kind === 'session') {
            query.set('anchorSessionId', anchor.sessionId);
            if (anchor.messageId) query.set('anchorMessageId', anchor.messageId);
        } else {
            if (anchor.kind === 'doc' && !areServerProfileIdentifiersEquivalent(anchor.doc.ref.serverId, input.target.address.serverId)) throw new Error('server_target_mismatch');
            query.set('anchor', JSON.stringify(anchor));
        }
    }
    const leaf = input.target.kind === 'new' ? 'new' : encodeURIComponent(input.target.discussionId);
    return `/discussions/${leaf}?${query}`;
}
