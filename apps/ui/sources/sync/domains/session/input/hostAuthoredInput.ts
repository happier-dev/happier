import {
    readSessionInputAuthority,
    readSessionMessageProvenance,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { SessionFollowInputV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/references';

function readHostInputAuthority(meta: unknown) {
    if (readSessionMessageProvenance(meta, 'stored')?.kind !== 'host') return null;
    const authority = readSessionInputAuthority(meta, 'stored');
    return authority?.v === 1 && authority.caller?.kind === 'host' ? authority : null;
}

/**
 * A Discussion message the host relayed into this Session: the words are the Discussion author's (its
 * `displayText`), so it is drawn as a message from that Discussion, never as host prose.
 */
export function readHostDiscussionInputMeta(meta: unknown): DiscussionAddressingV1 | null {
    const authority = readHostInputAuthority(meta);
    return authority && !authority.followDeliveryV1 ? authority.discussionAddressing ?? null : null;
}

/** The Discussion a delivered input came from, and the Session that delivered it (null when the viewer did). */
export type DiscussionInputOrigin = Readonly<{ discussionId: string; senderSessionId: string | null }>;

/**
 * Every Discussion-delivered input names its Discussion. A host relay is the viewer's own delivery; a
 * Session-sent one (causal Session provenance plus the admitted Discussion addressing) also carries the sender.
 */
export function readDiscussionInputOrigin(meta: unknown): DiscussionInputOrigin | null {
    const hostDiscussion = readHostDiscussionInputMeta(meta);
    if (hostDiscussion) return { discussionId: hostDiscussion.discussionId, senderSessionId: null };
    const provenance = readSessionMessageProvenance(meta, 'stored');
    if (provenance?.kind !== 'happierSession') return null;
    const authority = readSessionInputAuthority(meta, 'stored');
    return authority?.v === 1 && authority.discussionAddressing && !authority.followDeliveryV1
        ? { discussionId: authority.discussionAddressing.discussionId, senderSessionId: provenance.sourceSessionId }
        : null;
}

/**
 * A new Bot's first-run seed (`buildSessionHostOnboardingInputV1`): a host kickoff the Bot answers, never the
 * person's words. Committed and pending rows both read it here. A pending seed has no Home authority yet, so its
 * row keeps the server-attested author byline: only the Session owner can admit one through the onboarding route.
 */
export function isHostOnboardingInputMeta(meta: unknown): boolean {
    const provenance = readSessionMessageProvenance(meta, 'stored');
    return provenance?.kind === 'host' && provenance.producer === 'hostOnboarding';
}

/** Pending identity comes only from Home's separate admission projection, never authored metadata. */
export function isHostAuthoredInputMeta(meta: unknown, admittedPendingFollowInput?: SessionFollowInputV1 | null): boolean {
    return admittedPendingFollowInput != null
        || (readHostInputAuthority(meta) !== null && readHostDiscussionInputMeta(meta) === null);
}

/** The existing admitted Follow facts distinguish a model prompt from a person's text. */
export function readHostFollowInputMeta(meta: unknown, admittedPendingFollowInput?: SessionFollowInputV1 | null): SessionFollowInputV1 | null {
    return admittedPendingFollowInput ?? readHostInputAuthority(meta)?.followDeliveryV1 ?? null;
}

/** An admitted Follow that asks the person for something: a session request, or a run/workflow needs-you event. */
export function followInputNeedsYou(input: SessionFollowInputV1): boolean {
    return 'requestEvents' in input || input.event.kind === 'needs_you';
}
