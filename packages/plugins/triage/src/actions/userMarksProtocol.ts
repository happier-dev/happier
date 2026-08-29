import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    ProtocolCollectionOpaqueCursorV1Schema,
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageEntryRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';

/**
 * The strict contract of the two user-mark Actions.
 *
 * A mounted surface reaches no Account Collection of its own — the Host API it
 * holds exposes actions, not storage — so this is the only transport between a
 * Pin the reader pressed and the one canonical `user-marks` writer. It is
 * declared here rather than in `@happier-dev/triage-protocol` for the same
 * reason the aggregate list Action is: the caller family is this plugin's own
 * mounted surfaces, and publishing a pin-writing shape cross-plugin would
 * invite a second pin authority the corpus contract forbids.
 *
 * The mark's storage tag is deliberately absent from both results. A row id is
 * plaintext server metadata even on an E2EE Account, and nothing a surface
 * renders needs one: a pin is addressed by the canonical entry reference the
 * caller already holds.
 */

const triageText = defineProtocolString({
    minLength: 1,
    maxLength: MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
    pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
});

/**
 * The two display values a user needs to recognize and unpin what they pinned.
 * `closed` is what keeps this from growing into a durable entry projection.
 */
const TriageUserMarkDisplayV1Schema = defineProtocolObject({
    title: triageText,
    scopeLabel: triageText,
}, { policy: 'closed' });

/**
 * Pin carries the projected facts; Unpin structurally cannot.
 *
 * The asymmetry is enforced on the wire and not only in the writer's types: the
 * `pinned: false` arm is closed and has no display member, so an Unpin that
 * tried to carry a rendering is rejected before the handler sees it. That is
 * what keeps Unpin usable for a pinned row the current pass never materialized.
 */
export const TriageSetEntryPinnedInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        pinned: defineProtocolLiteral(true),
        entryRef: TriageEntryRefV1Schema,
        displayAtMark: TriageUserMarkDisplayV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        pinned: defineProtocolLiteral(false),
        entryRef: TriageEntryRefV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageSetEntryPinnedInputV1 = ReturnType<typeof TriageSetEntryPinnedInputV1Schema.parse>;
export const TriageSetEntryPinnedInputV1JsonSchema: PluginJsonSchema =
    TriageSetEntryPinnedInputV1Schema.jsonSchema;

export const TriageSetEntryPinnedResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /**
     * `conflict` is a real settled answer, not a failure: another writer won,
     * and the caller re-reads the authoritative marks rather than forcing one.
     */
    status: defineProtocolUnion([
        defineProtocolLiteral('pinned'),
        defineProtocolLiteral('unpinned'),
        defineProtocolLiteral('conflict'),
    ]),
}, { policy: 'closed' });
export type TriageSetEntryPinnedResultV1 = ReturnType<typeof TriageSetEntryPinnedResultV1Schema.parse>;
export const TriageSetEntryPinnedResultV1JsonSchema: PluginJsonSchema =
    TriageSetEntryPinnedResultV1Schema.jsonSchema;

/**
 * Where the previous bounded page of pins stopped.
 *
 * The value is the Account Collection's own opaque cursor, passed back through
 * untouched: nothing here decodes it, orders by it, or derives anything from
 * it. It is composed from the canonical Protocol cursor value through the
 * validator-neutral authoring surface rather than re-declaring its bound,
 * because a cursor the canonical schema refused would be a cursor the reader's
 * own pins could not be reached past.
 */
export const TriageListPinnedEntriesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    limit: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
    }),
    /** Absent asks for the newest page; present asks for the one after it. */
    cursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageListPinnedEntriesInputV1 = ReturnType<typeof TriageListPinnedEntriesInputV1Schema.parse>;
export const TriageListPinnedEntriesInputV1JsonSchema: PluginJsonSchema =
    TriageListPinnedEntriesInputV1Schema.jsonSchema;

export const TriageListPinnedEntriesResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    /**
     * Newest pin first, exactly as the marks index already orders them. Each
     * pin carries everything a row needs on its own; the caller overlays fresher
     * facts for the pins its projection happens to hold.
     */
    pins: defineProtocolArray(defineProtocolObject({
        entryRef: TriageEntryRefV1Schema,
        markedAtMs: defineProtocolNumber({ integer: true, minimum: 0 }),
        displayAtMark: TriageUserMarkDisplayV1Schema,
    }, { policy: 'closed' }), { maxItems: MAX_TRIAGE_LIST_WINDOW_ROWS_V1 }),
    /**
     * Where this bounded page stopped, when the reader has pins after it.
     *
     * It carries the marks query's own cursor rather than the `more: boolean`
     * it used to be reduced to. That reduction was the whole defect: the
     * Collection knew how to reach the next page, the Action threw the answer
     * away, and a reader past the page bound could neither see their older pins
     * nor remove them — durable user intent with no upstream owner to recover
     * it from, stranded by a projection.
     *
     * Absent means the query returned no cursor: every pin has been carried.
     * "Is there more" is derived from that absence rather than reported beside
     * it, so the page bound and the offer to pass it cannot disagree.
     */
    nextCursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageListPinnedEntriesResultV1 = ReturnType<typeof TriageListPinnedEntriesResultV1Schema.parse>;
export const TriageListPinnedEntriesResultV1JsonSchema: PluginJsonSchema =
    TriageListPinnedEntriesResultV1Schema.jsonSchema;

/** The Pin/Unpin write. One Action, both directions, one writer beneath it. */
export const TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1 = 'marks/set-pinned-v1';
/** The authoritative pinned-section read. */
export const TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1 = 'marks/list-pinned-v1';
