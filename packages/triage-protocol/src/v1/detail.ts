import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';

import { MAX_TRIAGE_LINKED_SESSIONS_V1 } from './bounds.js';
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
export const TriageLinkedSessionProjectionV1JsonSchema: PluginJsonSchema =
    TriageLinkedSessionProjectionV1Schema.jsonSchema;

/**
 * The mounted detail input: the exact configured instance, the host-applied
 * present observation, and the required bounded linked-Session projection.
 *
 * The applied observation is target-stamped — it carries the qualified
 * `entryRef` and the target's `observedAtMs`, which a source result may never
 * contain. `[]` linked sessions means no links.
 *
 * The optional exact origin Composer ref described in `CONTRACT.md` §7 is
 * deliberately absent from V1 of this schema: its canonical validator-neutral
 * composable projection is owned by the Composer/SDK program under blocker
 * `COMPOSER-COMPOSABLE-REF` and does not exist yet. A Triage-local mirror,
 * adoption wrapper, or permissive JSON carrier is explicitly forbidden, so the
 * field is added only after that producer publishes.
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
        maxItems: MAX_TRIAGE_LINKED_SESSIONS_V1,
    }),
}, { policy: 'closed' });
export type TriageDetailSurfaceInputV1 = ReturnType<
    typeof TriageDetailSurfaceInputV1Schema.parse
>;
export const TriageDetailSurfaceInputV1JsonSchema: PluginJsonSchema =
    TriageDetailSurfaceInputV1Schema.jsonSchema;
