import type { TriageTaskOriginReviewV1 } from '../../actions/taskReviewProtocol.js';
import type {
    TriageConfiguredSourceInstanceV1,
    TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';

import type {
    CorpusSourceInstanceLifecycleV1,
    CorpusSourceInstanceRetiredReasonV1,
} from './ids.js';

/**
 * The three durable row shapes.
 *
 * The plugin writes one flat value object per row and the daemon adapter splits
 * it: the declared server-readable fields become the plaintext projection, the
 * row-id field becomes the row id itself, and every other top-level field is
 * private payload — sealed on an E2EE Account and never indexable.
 *
 * All three hold genuine user state: a configured source, a pin, a Session
 * link. Provider-derived facts are materialized live into a device-local
 * projection and are never written here. The only provider text a row carries
 * is the small display remainder a user needs to recognize and unpin — or
 * unlink — the thing they committed to.
 *
 * No row shape here has a field that can hold a credential, a token, a local
 * filesystem path or a connected-account secret.
 */

export type CorpusSourceInstanceRowV1 = Readonly<{
    /** [row id] Mode-aware storage tag over the exact private configured match tuple. */
    instanceTag: string;
    /** [projected] the admitted source contribution identity rendered for the source catalogue. */
    sourceQualifiedId: string;
    /** [projected] lifecycle state; numerically prefixed so the index sorts active first. */
    lifecycle: CorpusSourceInstanceLifecycleV1;
    /** [projected] our clock, for a stable enumeration order. */
    configuredAtMs: number;

    /** The exact shared configured instance: stable target-minted ref, exact account, source-private configuration. */
    configured: TriageConfiguredSourceInstanceV1;
    /** Present only while the row is retired. */
    retiredReason?: CorpusSourceInstanceRetiredReasonV1;
}>;

export type CorpusSessionLinkRowV1 = Readonly<{
    /** [row id] Reserved. */
    linkTag: string;
    /** [projected] index prefix: the collection-bound tag over the CURRENT entry ref. */
    entryTag: string;
    /** [projected] host session relation field; plaintext because host ids already are. */
    sessionId: string;
    /** [projected] our clock. */
    linkedAtMs: number;

    /** The full entry ref: the only identity of the linked provider entity anywhere in the Account. */
    entryRef: TriageEntryRefV1;
    /** Immutable initial entry ref, used only to rederive this stable link id during an Account-mode transition. */
    identityEntryRef: TriageEntryRefV1;
    /**
     * The entry's display path as it read at link time. It is the ordinary
     * render path for a linked row until a live materialization supplies fresher
     * facts, because no durable entry row exists to hydrate from.
     */
    displayPathAtLink: string;
}>;

export type CorpusUserMarkDisplayV1 = Readonly<{ title: string; scopeLabel: string }>;

export type CorpusTaskOriginErrorV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    display: CorpusUserMarkDisplayV1;
}>;

/**
 * One pull request the user named as the fix for the marked entry.
 *
 * The display pair is the PR's own title and scope as the reader saw them when
 * linking, so the link stays nameable and unlinkable while no current pass
 * materializes the PR — the same rule as `displayAtMark`.
 */
export type CorpusFixPullRequestLinkV1 = Readonly<{
    entryRef: TriageEntryRefV1;
    displayAtLink: CorpusUserMarkDisplayV1;
    linkedAtMs: number;
}>;

/**
 * The user's fix-PR choice for the marked entry (`design/FIX-LINK.md`).
 *
 * `linked` is "this PR fixes it"; `dismissed` is "not this one", which is what
 * lets an unlink win over a candidate derived from a shared Session link.
 */
export type CorpusFixPullRequestsV1 = Readonly<{
    linked: readonly CorpusFixPullRequestLinkV1[];
    dismissed: readonly TriageEntryRefV1[];
}>;

export type CorpusUserMarkRowV1 = Readonly<{
    /** [row id] Collection-bound tag over the canonical entry-ref tuple. */
    markTag: string;
    /**
     * [projected] leading index field. A relationship-only mark is live with
     * `false`; removing its last intent tombstones the row.
     */
    pinned: boolean;
    /** [projected] index range field. */
    markedAtMs: number;
    entryRef: TriageEntryRefV1;
    /**
     * The entry's title and scope label as they read when the mark was written.
     * It is the ordinary render path for a pinned row until live materialization
     * supplies fresher facts: a pin must be nameable and unpinnable on its own
     * bytes, and neither this nor `displayPathAtLink` may grow into an entry
     * cache.
     */
    displayAtMark: CorpusUserMarkDisplayV1;
    /** Present once the user linked or dismissed a fix pull request for this entry. */
    fixPullRequests?: CorpusFixPullRequestsV1;
    /** The error the user chose when creating this task; private relationship intent. */
    originError?: CorpusTaskOriginErrorV1;
    /** Selected Review/finding identities only; never a finding snapshot. */
    originReview?: TriageTaskOriginReviewV1;
}>;
