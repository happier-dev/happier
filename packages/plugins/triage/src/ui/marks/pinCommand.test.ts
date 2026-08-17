import { describe, expect, it } from 'vitest';

import {
    listTriagePinnedEntries,
    setTriageEntryPinned,
} from '../../actions/userMarks.js';
import {
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    TriageListPinnedEntriesInputV1Schema,
    TriageSetEntryPinnedInputV1Schema,
} from '../../actions/userMarksProtocol.js';
import {
    createTestkitCorpusCollections,
    testkitAccountMaterial,
    type TestkitCorpusCollections,
} from '../../corpus/testkit/corpusCollections.test-support.js';
import { deriveUserMarkTag } from '../../corpus/identity/tags.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import {
    readTriagePinnedEntries,
    submitTriagePin,
    type TriageMarkHostV1,
} from './pinCommand.js';

/**
 * The surface's Pin/Unpin path, driven end to end through the real host
 * boundary.
 *
 * Nothing between the caller and the Collection is stood in for: the command
 * crosses the published Action schemas, reaches the real Action owner, which
 * delegates to the real `setPinned` writer over the real Account Collection
 * with real identity derivation. Only the host's Action dispatcher and the
 * Collection store are replaced, which are the two genuine system boundaries.
 *
 * The failure these exclude is the one no amount of local correctness catches:
 * a reference that is not stable across passes, processes or devices makes the
 * second Pin land on a second row, and the user ends up with two pins for one
 * entry where unpinning removes only one of them.
 */

const DISPLAY = Object.freeze({
    title: 'Replace the duplicated normalizer',
    scopeLabel: 'example/repository',
});

/**
 * The host's Action dispatcher, admitting each request through the published
 * input schema exactly as the wire would before any handler sees it.
 */
function createMarkHost(fixture: TestkitCorpusCollections, nowMs: () => number): TriageMarkHostV1 & Readonly<{
    calls: readonly string[];
}> {
    const calls: string[] = [];
    return {
        calls,
        async executeAction(action, input) {
            calls.push(action);
            if (action === TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1) {
                return await setTriageEntryPinned(
                    TriageSetEntryPinnedInputV1Schema.parse(input),
                    { collections: fixture.collections, nowMs },
                );
            }
            if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) {
                return await listTriagePinnedEntries(
                    TriageListPinnedEntriesInputV1Schema.parse(input),
                    { collections: fixture.collections, nowMs },
                );
            }
            throw new Error(`No Triage Action is registered for ${action}.`);
        },
    };
}

describe('the surface Pin/Unpin command', () => {
    it('pins from the projected display alone and reads the mark back through the marks query', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        const host = createMarkHost(fixture, () => 1_760_000_900_000);
        const entryRef = testkitEntryRef();

        expect(await submitTriagePin(host, { pinned: true, entryRef, displayAtMark: DISPLAY }))
            .toEqual({ v: 1, status: 'pinned' });

        const page = await readTriagePinnedEntries(host);
        expect(page).toEqual({
            v: 1,
            more: false,
            pins: [{ entryRef, markedAtMs: 1_760_000_900_000, displayAtMark: DISPLAY }],
        });
        // The mark's storage tag is server-plaintext metadata; nothing a surface
        // renders needs it, so it never crosses the transport.
        expect(JSON.stringify(page)).not.toContain('markTag');
    });

    it('keeps one pin for one entry when a later pass renders it differently', async () => {
        const fixture = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee' });
        let clock = 1_000;
        const host = createMarkHost(fixture, () => clock);
        await submitTriagePin(host, { pinned: true, entryRef: testkitEntryRef(), displayAtMark: DISPLAY });

        // A refresh landed: same entry, freshly rendered title, independently
        // constructed reference object. A second row here is the duplicate pin.
        clock = 9_000;
        expect(await submitTriagePin(host, {
            pinned: true,
            entryRef: { ...testkitEntryRef() },
            displayAtMark: { title: 'Replace the duplicated normalizer (updated)', scopeLabel: 'example/repository' },
        })).toEqual({ v: 1, status: 'pinned' });

        const page = await readTriagePinnedEntries(host);
        expect(page.pins).toHaveLength(1);
        expect(page.pins[0]).toMatchObject({ markedAtMs: 1_000, displayAtMark: DISPLAY });
    });

    it('lands a second device on the exact row the first device wrote', async () => {
        // Two independently bound collection sets over one Account's material
        // stand in for two devices that materialized the entry separately. Only
        // the derived address decides whether they share a pin, so that is what
        // is asserted rather than any client-side equality.
        const material = testkitAccountMaterial(7);
        const first = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });
        const second = createTestkitCorpusCollections({ accountEncryptionMode: 'e2ee', material });
        const entryRef = testkitEntryRef();

        await submitTriagePin(
            createMarkHost(first, () => 1_000),
            { pinned: true, entryRef, displayAtMark: DISPLAY },
        );

        const writtenTag = await deriveUserMarkTag(first.collections.userMarks, entryRef);
        const secondDeviceTag = await deriveUserMarkTag(second.collections.userMarks, {
            // The second device rebuilt the reference from its own pass, and a
            // different pass ordering must not change where the write lands.
            entryId: entryRef.entryId,
            collisionScope: entryRef.collisionScope,
            kindId: entryRef.kindId,
            source: { localId: entryRef.source.localId, pluginId: entryRef.source.pluginId },
        });
        expect(secondDeviceTag).toBe(writtenTag);
        expect((await first.collections.userMarks.get(writtenTag))?.value).toMatchObject({
            markedAtMs: 1_000,
        });
    });

    it('unpins a pinned entry the projection never materialized, with no display payload', async () => {
        const fixture = createTestkitCorpusCollections();
        const host = createMarkHost(fixture, () => 1_000);
        const entryRef = testkitEntryRef();
        await submitTriagePin(host, { pinned: true, entryRef, displayAtMark: DISPLAY });

        // Unpin names only the entry. There is deliberately no rendering to
        // supply, because the row it removes may not be in any current window.
        expect(await submitTriagePin(host, { pinned: false, entryRef }))
            .toEqual({ v: 1, status: 'unpinned' });
        expect((await readTriagePinnedEntries(host)).pins).toEqual([]);
    });

    it('reads the pinned page with no per-row Collection read at all', async () => {
        const fixture = createTestkitCorpusCollections();
        const host = createMarkHost(fixture, () => 1_000);
        for (const entryId of ['17', '18', '19']) {
            await submitTriagePin(host, {
                pinned: true,
                entryRef: testkitEntryRef({ entryId }),
                displayAtMark: DISPLAY,
            });
        }
        const before = fixture.control.userMarks.getCallCount();

        const page = await readTriagePinnedEntries(host);

        expect(page.pins).toHaveLength(3);
        // A mark carries its own reference and display, so listing pins issues
        // no hydration read. A per-row read here would be a provider-shaped cost
        // on durable state that has no provider.
        expect(fixture.control.userMarks.getCallCount()).toBe(before);
    });

    it('rejects an Unpin that tries to carry a rendering before any writer sees it', async () => {
        const fixture = createTestkitCorpusCollections();
        const host = createMarkHost(fixture, () => 1_000);

        await expect(host.executeAction(TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1, {
            v: 1,
            pinned: false,
            entryRef: testkitEntryRef(),
            displayAtMark: DISPLAY,
        } as never)).rejects.toThrow();
    });
});
