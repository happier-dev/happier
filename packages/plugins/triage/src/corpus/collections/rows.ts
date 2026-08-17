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

    /**
     * Target-minted random publication id, private to the row. It is stable
     * across Account-mode reprojection and contains no Session, provider or
     * entry identity.
     */
    cardPublicationId: string;
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

export type CorpusUserMarkRowV1 = Readonly<{
    /** [row id] Collection-bound tag over the canonical entry-ref tuple. */
    markTag: string;
    /** [projected] leading index field. A live mark is always true: Unpin tombstones the row instead of writing a second false state. */
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
}>;
