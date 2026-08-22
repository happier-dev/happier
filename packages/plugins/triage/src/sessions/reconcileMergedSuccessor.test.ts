import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { CORPUS_SESSION_LINKS_INDEX_ID } from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import {
    deriveSessionLinkEntryTag,
    deriveSessionLinkTag,
    deriveUserMarkTag,
} from '../corpus/identity/tags.js';
import { setPinned } from '../corpus/marks/setPinned.js';
import {
    createTestkitCorpusCollections,
    type TestkitCorpusCollections,
} from '../corpus/testkit/corpusCollections.test-support.js';
import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { linkEntryToSession } from './entrySessionLinks.js';
import { reconcileMergedSuccessor } from './reconcileMergedSuccessor.js';
import { TESTKIT_LINK_DISPLAY } from './testkit/entrySessionTestkit.test-support.js';

const NOW_MS = 1_760_000_900_000;

/** The entry a source reported as merged away, and the direct successor it named. */
const PREDECESSOR = testkitEntryRef({ entryId: '17' });
const SUCCESSOR = testkitEntryRef({ entryId: '42' });

const PIN_DISPLAY = { title: 'Replace the duplicated normalizer', scopeLabel: 'example/repository' } as const;

async function link(
    fixture: TestkitCorpusCollections,
    input: Readonly<{ entryRef: TriageEntryRefV1; sessionId: string; nowMs: number; publicationId: string }>,
): Promise<string> {
    const result = await linkEntryToSession({
        collections: fixture.collections,
        entryRef: input.entryRef,
        display: TESTKIT_LINK_DISPLAY,
        sessionId: input.sessionId,
        nowMs: input.nowMs,
        mintCardPublicationId: () => input.publicationId,
    });
    if (result.status !== 'linked') throw new Error('the link fixture did not commit');
    return result.linkTag;
}

async function rowsOn(
    fixture: TestkitCorpusCollections,
    entryRef: TriageEntryRefV1,
): Promise<readonly CorpusSessionLinkRowV1[]> {
    const entryTag = await deriveSessionLinkEntryTag(fixture.collections.sessionLinks, entryRef);
    const page = await fixture.collections.sessionLinks.query({
        index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
        prefix: [entryTag],
        order: 'asc',
    });
    return page.rows.map((stored) => fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored).value);
}

/**
 * A second writer that commits between this call's index read and its
 * conditional put.
 *
 * The Collection is a network-backed store and therefore a genuine system
 * boundary; this wraps that boundary to land a concurrent commit inside the
 * exact window the CAS exists to detect. Nothing internal is stubbed — the real
 * in-memory store answers both writes.
 */
function racingSessionLinks(
    base: CorpusCollectionsV1['sessionLinks'],
    commitFirst: () => Promise<void>,
): CorpusCollectionsV1['sessionLinks'] {
    let raced = false;
    return {
        ...base,
        async batch(operations, options) {
            if (!raced) {
                raced = true;
                await commitFirst();
            }
            return await base.batch(operations, options);
        },
    };
}

describe('reconcileMergedSuccessor', () => {
    it('retargets merged Session links once and leaves the predecessor pin untouched', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const { sessionLinks, userMarks } = fixture.collections;

        // One Session holds only the predecessor link; another already holds a
        // separate successor link beside its predecessor one.
        const predecessorLinkA = await link(fixture, {
            entryRef: PREDECESSOR, sessionId: 'session-a', nowMs: NOW_MS, publicationId: 'publication-a',
        });
        const predecessorLinkB = await link(fixture, {
            entryRef: PREDECESSOR, sessionId: 'session-b', nowMs: NOW_MS + 1_000, publicationId: 'publication-b-predecessor',
        });
        const successorLinkB = await link(fixture, {
            entryRef: SUCCESSOR, sessionId: 'session-b', nowMs: NOW_MS + 2_000, publicationId: 'publication-b-successor',
        });
        await setPinned({
            collections: fixture.collections,
            entryRef: PREDECESSOR,
            pinned: true,
            displayAtMark: PIN_DISPLAY,
            nowMs: NOW_MS,
        });
        const markTag = await deriveUserMarkTag(userMarks, PREDECESSOR);
        const markBefore = fixture.control.userMarks.inspect(markTag);

        const first = await reconcileMergedSuccessor({
            collections: fixture.collections,
            entryRef: PREDECESSOR,
            successorEntryRef: SUCCESSOR,
        });
        const linkRevisionsAfterFirst = [predecessorLinkA, predecessorLinkB, successorLinkB]
            .map((rowId) => fixture.control.sessionLinks.inspect(rowId));
        // The same authoritative merge, applied a second time.
        const second = await reconcileMergedSuccessor({
            collections: fixture.collections,
            entryRef: PREDECESSOR,
            successorEntryRef: SUCCESSOR,
        });

        expect(first).toEqual({ status: 'reconciled' });
        expect(second).toEqual({ status: 'reconciled' });
        // Retargeted once: the retry rereads an empty predecessor index and writes nothing.
        expect([predecessorLinkA, predecessorLinkB, successorLinkB]
            .map((rowId) => fixture.control.sessionLinks.inspect(rowId)))
            .toEqual(linkRevisionsAfterFirst);

        // Nothing is left on the predecessor, and each Session has exactly one
        // current relationship — on the successor.
        expect(await rowsOn(fixture, PREDECESSOR)).toEqual([]);
        const current = await rowsOn(fixture, SUCCESSOR);
        expect(current.map((row) => row.sessionId).sort()).toEqual(['session-a', 'session-b']);

        // The retargeted row is the SAME row: its address, publication identity,
        // link time, immutable identity ref and frozen display path all survive,
        // and only the projected entry tag and the current ref moved.
        expect(current.find((row) => row.sessionId === 'session-a')).toEqual({
            linkTag: predecessorLinkA,
            entryTag: await deriveSessionLinkEntryTag(sessionLinks, SUCCESSOR),
            sessionId: 'session-a',
            linkedAtMs: NOW_MS,
            cardPublicationId: 'publication-a',
            entryRef: SUCCESSOR,
            identityEntryRef: PREDECESSOR,
            displayPathAtLink: 'example/repository #17',
        });

        // The Session that already had a successor link keeps that row and loses
        // the predecessor one, rather than showing two relationships.
        expect(current.find((row) => row.sessionId === 'session-b')?.cardPublicationId)
            .toBe('publication-b-successor');
        expect(await sessionLinks.get(predecessorLinkB)).toBeNull();
        expect(fixture.control.sessionLinks.inspect(predecessorLinkB)?.deleted).toBe(true);

        // No new card is published: every live publication id was already minted
        // by a user's own link.
        expect(current.map((row) => row.cardPublicationId).sort())
            .toEqual(['publication-a', 'publication-b-successor']);

        // No `user-marks` write at all. A reconciler that helpfully moved the pin
        // would be the second mark writer the corpus refuses.
        expect(fixture.control.userMarks.inspect(markTag)).toEqual(markBefore);
        expect((await userMarks.get(markTag))?.value).toMatchObject({ entryRef: PREDECESSOR });
    });

    it('writes nothing when the reported successor is the observed entry itself', async () => {
        // A source that names the entry as its own successor would otherwise
        // leave every row inside the predecessor index the walk keeps rereading,
        // which never terminates.
        const fixture = createTestkitCorpusCollections();
        const linkTag = await link(fixture, {
            entryRef: PREDECESSOR, sessionId: 'session-a', nowMs: NOW_MS, publicationId: 'publication-a',
        });
        const before = fixture.control.sessionLinks.inspect(linkTag);

        const result = await reconcileMergedSuccessor({
            collections: fixture.collections,
            entryRef: PREDECESSOR,
            // Structurally equal, independently constructed.
            successorEntryRef: testkitEntryRef({ entryId: '17' }),
        });

        expect(result).toEqual({ status: 'reconciled' });
        expect(fixture.control.sessionLinks.inspect(linkTag)).toEqual(before);
    });

    it('reports incomplete and stops when a predecessor link moved under the walk', async () => {
        // The row stays addressable on the predecessor index, so the next
        // authoritative merge observation retries it. Looping on it instead
        // would spin the daemon's event loop on a row this pass cannot win.
        const fixture = createTestkitCorpusCollections();
        const linkTag = await link(fixture, {
            entryRef: PREDECESSOR, sessionId: 'session-a', nowMs: NOW_MS, publicationId: 'publication-a',
        });
        const contended = racingSessionLinks(fixture.collections.sessionLinks, async () => {
            // The same bytes, recommitted by somebody else: the row's content is
            // untouched and only its revision moves, which is exactly what the
            // conditional put is there to notice.
            const live = await fixture.collections.sessionLinks.get(linkTag);
            if (!live) throw new Error('the contended link fixture is missing');
            fixture.control.sessionLinks.seed(live.value);
        });

        const result = await reconcileMergedSuccessor({
            collections: { sessionLinks: contended },
            entryRef: PREDECESSOR,
            successorEntryRef: SUCCESSOR,
        });

        expect(result).toEqual({ status: 'incomplete' });
        // Still addressable on the predecessor index, so the next authoritative
        // merge observation retries exactly this row.
        expect((await rowsOn(fixture, PREDECESSOR)).map((row) => row.linkTag)).toEqual([linkTag]);
    });

    it('rethrows a cancelled walk instead of reporting it as a store answer', async () => {
        // A cancellation means this caller stopped asking and learned nothing.
        // Reporting it as `incomplete` invents an answer nobody received: the
        // caller would record a settled store outcome for a read that never
        // finished. The module doc above the catch already promised this — the
        // code caught every `PluginError`, cancellation included, so the promise
        // was false.
        const fixture = createTestkitCorpusCollections();
        await link(fixture, {
            entryRef: PREDECESSOR, sessionId: 'session-a', nowMs: NOW_MS, publicationId: 'publication-a',
        });
        const controller = new AbortController();
        controller.abort();
        // A REAL `PluginError` carrying a cancellation code — the shape the host
        // actually rejects with. A plain Error would be rethrown by the existing
        // `isPluginError` arm anyway and would prove nothing.
        const cancelling = racingSessionLinks(fixture.collections.sessionLinks, () => {
            throw new PluginError({ code: 'cancelled', message: 'the caller stopped asking' });
        });

        await expect(reconcileMergedSuccessor({
            collections: { sessionLinks: cancelling },
            entryRef: PREDECESSOR,
            successorEntryRef: SUCCESSOR,
            signal: controller.signal,
        })).rejects.toThrow('the caller stopped asking');
    });
});