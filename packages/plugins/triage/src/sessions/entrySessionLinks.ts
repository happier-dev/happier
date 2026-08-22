import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { SessionId } from '@happier-dev/plugin-sdk/sessions';
import type { TriageEntryLocatorV1, TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { putCorpusRowOnce } from '../corpus/collections/putRowOnce.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { deriveSessionLinkEntryTag, deriveSessionLinkTag } from '../corpus/identity/tags.js';

/**
 * The one writer that creates a `session-links` row.
 *
 * The only other writer of this collection is `reconcileMergedSuccessor.ts`,
 * and it never creates a relationship: it moves a row this module committed onto
 * an authoritative successor, or collapses it into one. So a link still comes
 * into existence in exactly one place.
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
 * supplies fresher facts.
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
