import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';

import { MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1 } from './bounds.js';
import {
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1Schema,
    TriageIdentifierV1ProtocolSchema,
    TriageTextV1ProtocolSchema,
} from './identity.js';
import { TriageConfiguredSourceInstanceV1Schema } from './instances.js';
import {
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceViewerFactsV1Schema,
} from './observations.js';

/**
 * One retained Triage entry-to-Session link. A link whose generic Session
 * summary is unavailable or tombstoned keeps its `sessionId` and omits the two
 * presentation fields; no renderer may infer that such a Session was never
 * linked. Sources receive no Session metadata beyond these three fields
 * (`CONTRACT.md` §7).
 */
export const TriageLinkedSessionProjectionV1Schema = defineProtocolObject({
    sessionId: SessionIdSchema,
    displayTitle: TriageTextV1ProtocolSchema.optional(),
    updatedAtMs: defineProtocolNumber({ integer: true }).optional(),
}, { policy: 'closed' });
export type TriageLinkedSessionProjectionV1 = ReturnType<
    typeof TriageLinkedSessionProjectionV1Schema.parse
>;

/**
 * The mounted detail input: the exact configured instance, the host-applied
 * present observation, and the required bounded linked-Session projection.
 *
 * The applied observation is target-stamped — it carries the qualified
 * `entryRef` and the target's `observedAtMs`, which a source result may never
 * contain. `[]` linked sessions means no links.
 *
 * A Composer-origin launch adds no field here. Its `originComposer` address
 * lives in exactly one carrier — Triage's own CLOSED private launch input at
 * `packages/plugins/triage/src/composer/entryDetailLaunchInput.ts` (PEP `03d1`
 * §17.8) — because the destination resolves it with an exact
 * `get(originComposer)`, and the drop policy below would silently empty it
 * instead of refusing. This envelope is also what every third-party source
 * receives, and an address is not theirs to read.
 *
 * The outer object is `additive-open/drop` for the same reason as the descriptor
 * and snapshot envelopes (`CONTRACT.md` §8): each source pins its own copy of
 * this schema and gates its whole detail render on one `safeParse`, so a closed
 * envelope would turn "the host added an optional field" into a source that can
 * no longer show the entry at all. Every inner shape — the target-stamped
 * observation and each linked-Session projection — stays closed, because those
 * carry identity and admission authority.
 */
export const TriageDetailSurfaceInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    observation: defineProtocolObject({
        entryRef: TriageEntryRefV1Schema,
        observedAtMs: defineProtocolNumber({ integer: true }),
        locator: TriageEntryLocatorV1Schema,
        snapshot: TriageSourceEntrySnapshotV1Schema,
        viewer: TriageSourceViewerFactsV1Schema,
        sourceUpdatedAtMs: defineProtocolNumber({ integer: true }).optional(),
        nativeRevision: TriageIdentifierV1ProtocolSchema.optional(),
    }, { policy: 'closed' }),
    linkedSessions: defineProtocolArray(TriageLinkedSessionProjectionV1Schema, {
        maxItems: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    }),
    linkedSessionsHasMore: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]).optional(),
}, { policy: 'additive-open/drop' });
export type TriageDetailSurfaceInputV1 = ReturnType<
    typeof TriageDetailSurfaceInputV1Schema.parse
>;
export const TriageDetailSurfaceInputV1JsonSchema: PluginJsonSchema =
    TriageDetailSurfaceInputV1Schema.jsonSchema;
