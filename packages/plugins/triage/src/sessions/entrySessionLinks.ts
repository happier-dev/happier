import { isPluginError, type PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { TriageEntryLocatorV1, TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { putCorpusRowOnce } from '../corpus/collections/putRowOnce.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';

/**
 * The one writer that creates a `session-links` row, and the one writer that
 * removes one at the user's explicit request.
 *
 * The only other writer of this collection is `reconcileMergedSuccessor.ts`,
 * and it never creates or removes a relationship: it moves a row this module
 * committed onto an authoritative successor, or collapses it into one. So a
 * link still comes into existence — and still ends — in exactly one place.
 *
 * The link is the sole authority for "this entry is being worked on in that
 * Session". It is Account Collection data, so it survives client and daemon
 * restarts and keeps working while every daemon is offline as long as the
 * Account server is reachable. Nothing infers the relationship from a Message,
 * a Composer value, a title or a directory.
 *
 * Writing it is idempotent by construction: the row id is derived from the
 * canonical entry reference and the exact `SessionId`, so the same relationship
 * addresses the same row from any device, through any connection, no matter how
 * many times a start is retried or how the entry rendered in the pass that
 * offered it. A repeat link therefore never reorders, re-mints or re-times
 * anything.
 *
 * The row is never evicted, and it copies nothing provider-derived beyond the
 * one display path a linked row is rendered from until live materialization
 * supplies fresher facts. `INV-13` is structural: no Triage mechanism deletes a
 * live link, and the only thing that does is the explicit user operation below
 * (`core/CORPUS.md` §5.3).
 */

export type TriageLinkEntryToSessionResultV1 =
    | Readonly<{ status: 'linked'; linkTag: string }>
    /** The storage boundary refused or lost the write; the caller retries only the link. */
    | Readonly<{ status: 'failed' }>;

type LinkCollections = Pick<CorpusCollectionsV1, 'sessionLinks'>;

/**
 * The projected facts a link freezes.
 *
 * They come from the caller's device-local projection of the entry it is
 * linking: no durable entry row exists to read one from.
 */
export type TriageEntrySessionLinkDisplayV1 = Readonly<{
    locator: TriageEntryLocatorV1;
    scopeLabel: string;
}>;

/**
 * The display path frozen into the link.
 *
 * It is the entry's own already observed presentation path, not a provider URL,
 * routing token, account identity or title. When a source emitted no display
 * path the entry's scope label is the truthful remainder — never invented copy.
 */
export function entrySessionLinkDisplayPath(display: TriageEntrySessionLinkDisplayV1): string {
    return display.locator.displayPath ?? display.scopeLabel;
}

/**
 * Mints the row-private publication id.
 *
 * It is opaque and random: it encodes and hashes no Session, provider, account,
 * source, entry, title or path identity, so the plaintext Message local id it
 * later becomes cannot be dictionary-tested against public provider candidates
 * on an E2EE Account. Randomness is a genuine system boundary, so the generator
 * is injectable while the real one stays the default.
 */
export type TriageCardPublicationIdMintV1 = () => string;

const mintRandomCardPublicationId: TriageCardPublicationIdMintV1 = () =>
    globalThis.crypto.randomUUID();

export type TriageLinkEntryToSessionInputV1 = Readonly<{
    collections: LinkCollections;
    entryRef: TriageEntryRefV1;
    display: TriageEntrySessionLinkDisplayV1;
    sessionId: SessionId;
    /** Our clock, supplied by the caller so the writer owns no ambient time. */
    nowMs: number;
    mintCardPublicationId?: TriageCardPublicationIdMintV1;
    signal?: AbortSignal;
}>;

async function readLiveLink(
    collections: LinkCollections,
    linkTag: string,
    options?: PluginCancellationOptions,
): Promise<Readonly<{ revision: number; value: CorpusSessionLinkRowV1 }> | null> {
    const row = await collections.sessionLinks.get(linkTag, options);
    // A deleted link reads as `null`: a plugin cannot see its own tombstone.
    return row ? fromCorpusStoredRow<CorpusSessionLinkRowV1>(row) : null;
}

export async function linkEntryToSession(
    input: TriageLinkEntryToSessionInputV1,
): Promise<TriageLinkEntryToSessionResultV1> {
    try {
        return await writeEntrySessionLink(input);
    } catch {
        // The Collection store is a network-backed boundary. A refused or lost
        // write leaves the relationship uncommitted, and the caller retries
        // only this phase — it never respawns or rematerializes.
        return { status: 'failed' };
    }
}

async function writeEntrySessionLink(
    input: TriageLinkEntryToSessionInputV1,
): Promise<TriageLinkEntryToSessionResultV1> {
    const { collections, entryRef, sessionId, nowMs } = input;
    const options = input.signal ? { signal: input.signal } : undefined;
    const linkTag = await deriveSessionLinkTag(collections.sessionLinks, entryRef, sessionId, options);

    // An existing link is the same committed relationship. It keeps its
    // original `linkedAtMs`, its minted publication id and any retargeted
    // current `entryRef` a merge reconciliation already wrote.
    if (await readLiveLink(collections, linkTag, options)) return { status: 'linked', linkTag };

    const row: CorpusSessionLinkRowV1 = {
        linkTag,
        entryTag: await deriveSessionLinkEntryTag(collections.sessionLinks, entryRef, options),
        sessionId,
        linkedAtMs: nowMs,
        cardPublicationId: (input.mintCardPublicationId ?? mintRandomCardPublicationId)(),
        entryRef,
        identityEntryRef: entryRef,
        displayPathAtLink: entrySessionLinkDisplayPath(input.display),
    };
    const written = await putCorpusRowOnce<CorpusSessionLinkRowV1>({
        collection: collections.sessionLinks,
        rowId: linkTag,
        row,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    // Another writer won the same row. The relationship it committed is the one
    // this call wanted, so a live row is success rather than a forced overwrite.
    return written.status === 'conflict' ? { status: 'failed' } : { status: 'linked', linkTag };
}

/**
 * The one store code that means a competing writer, not a broken write.
 *
 * It is the same distinction `corpus/marks/setPinned.ts` makes for Unpin, and
 * for the same reason: folding every refusal into `conflict` would tell the
 * reader their link changed somewhere else and to retry, when the write is in
 * fact refused for a reason retrying cannot resolve.
 */
const COLLECTION_CONFLICT_CODE = 'plugin_collection_conflict';

export type TriageUnlinkEntryFromSessionResultV1 =
    /** The relationship is gone, including when it already was. */
    | Readonly<{ status: 'unlinked'; linkTag: string }>
    /** Another writer moved the row's revision; the surface re-reads. */
    | Readonly<{ status: 'conflict'; linkTag: string }>
    /** The storage boundary refused or lost the delete; the caller retries. */
    | Readonly<{ status: 'failed' }>;

export type TriageUnlinkEntryFromSessionInputV1 = Readonly<{
    collections: LinkCollections;
    entryRef: TriageEntryRefV1;
    sessionId: SessionId;
    signal?: AbortSignal;
}>;

/**
 * The explicit user operation that ends one entry-to-Session relationship.
 *
 * It names an entry **and** a Session, because the link's address is derived
 * from exactly that pair: an unlink addressed by the entry alone would drop the
 * same entry's link to a Session the user never touched, and one addressed by
 * the Session alone would drop every other entry's.
 *
 * It carries no display facts and needs none — the same asymmetry Unpin has.
 * A user who linked the wrong entry must be able to undo it from a row no
 * current pass materialized, so requiring a projection here would make the
 * mistake permanent exactly when the source stops reporting the entry.
 *
 * Removing a link is a tombstone, not an erasure (`core/CORPUS.md` §2.5): the
 * content, projections and index entries go, and the row id survives with its
 * revision. That is what lets the user link the same entry to the same Session
 * again — `putCorpusRowOnce` writes the resurrection put against that exact
 * revision — so nothing here caches, remembers or works around the tombstone.
 */
export async function unlinkEntryFromSession(
    input: TriageUnlinkEntryFromSessionInputV1,
): Promise<TriageUnlinkEntryFromSessionResultV1> {
    const { collections, entryRef, sessionId } = input;
    const options = input.signal ? { signal: input.signal } : undefined;
    try {
        const linkTag = await deriveSessionLinkTag(
            collections.sessionLinks,
            entryRef,
            sessionId,
            options,
        );
        const existing = await readLiveLink(collections, linkTag, options);
        // An already absent link is an idempotent success: a second press, or a
        // link another device removed first, leaves nothing different to say.
        if (!existing) return { status: 'unlinked', linkTag };
        try {
            await collections.sessionLinks.delete(linkTag, {
                expectedRevision: existing.revision,
                ...(input.signal ? { signal: input.signal } : {}),
            });
        } catch (error) {
            if (isPluginError(error) && error.code === COLLECTION_CONFLICT_CODE) {
                return { status: 'conflict', linkTag };
            }
            throw error;
        }
        return { status: 'unlinked', linkTag };
    } catch {
        // The Collection store is a network-backed boundary. A refused or lost
        // delete leaves the relationship exactly as it was.
        return { status: 'failed' };
    }
}
