import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1,
    TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from './bounds.js';
import { TriageConfiguredSourceInstanceV1Schema } from './instances.js';

/** The Action's target-local id. */
export const TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1 = 'sources/read-configured-v1';
/** The Action's stable registration/descriptive id. */
export const TRIAGE_SOURCES_READ_CONFIGURED_ACTION_ID_V1 =
    'happier.triage/sources/read-configured-v1';
/**
 * The exact qualified ref a source Settings surface passes to
 * `hostApi.executeAction(...)`, exactly as the administration Action's ref is
 * passed. There is no private cross-plugin import, Action search, or second
 * transport (`CONTRACT.md` §3.0).
 */
export const TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
});

/**
 * The read half of caller-bound source administration.
 *
 * `sources/administer-v1` has four lifecycle arms, and three of them —
 * `reconfigure`, `remove`, and `reactivate` — name a `sourceInstanceId` the
 * caller must already hold. Nothing published one. A source Settings page could
 * therefore only ever ADD a source: it could not list what it had already
 * configured, so it could not offer to change or remove it, and three quarters
 * of the approved lifecycle was unreachable from the product.
 *
 * The request carries no source, plugin, or contribution identity, for the same
 * reason the administration request does not: the host stamps the caller and
 * the target resolves its currently admitted V1 contribution. A caller sees ONLY
 * the instances its own contribution owns — never another source's — and the
 * result is deliberately unfilterable, because a caller-supplied scope would be
 * a second authority over the same question.
 *
 * This is a read. `sources/administer-v1` remains the sole writer; nothing here
 * creates, retires, reactivates, or reorders a row.
 */
export const TriageReadConfiguredSourceInstancesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
}, { policy: 'closed' });
export type TriageReadConfiguredSourceInstancesInputV1 = ReturnType<
    typeof TriageReadConfiguredSourceInstancesInputV1Schema.parse
>;
export const TriageReadConfiguredSourceInstancesInputV1JsonSchema: PluginJsonSchema =
    TriageReadConfiguredSourceInstancesInputV1Schema.jsonSchema;

/**
 * One configured instance of the calling source, with the one lifecycle fact
 * that decides which administration arm the Settings page may offer.
 *
 * `active` admits `reconfigure` and `remove`; `retired` admits `reactivate`.
 * The retirement REASON is deliberately absent: no approved flow branches on it,
 * and a Settings page that rendered "removed by you" versus "replaced by a
 * reconfiguration" would be presenting the target's own bookkeeping as source
 * state.
 *
 * `configured` is the exact value the target holds — the same
 * `TriageConfiguredSourceInstanceV1` it passes to `scan`, `get`, and `detail`.
 * The caller owns its own `configuration` token's encoding, so returning the
 * whole record is what lets a reconfiguration start from the current
 * configuration instead of from an empty form.
 */
export const TriageConfiguredSourceInstanceRecordV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    lifecycle: defineProtocolUnion([
        defineProtocolLiteral('active'),
        defineProtocolLiteral('retired'),
    ]),
    configured: TriageConfiguredSourceInstanceV1Schema,
}, { policy: 'closed' });
export type TriageConfiguredSourceInstanceRecordV1 = ReturnType<
    typeof TriageConfiguredSourceInstanceRecordV1Schema.parse
>;
export const TriageConfiguredSourceInstanceRecordV1JsonSchema: PluginJsonSchema =
    TriageConfiguredSourceInstanceRecordV1Schema.jsonSchema;

/**
 * `complete` means every instance this caller owns is named. `truncated` means
 * the bounded result could not carry them all — reusing the same honest
 * vocabulary `listInstances` and the aggregate list already answer with, rather
 * than letting the surplus vanish behind a page that looks finished.
 *
 * `invalidCaller` is the same refusal the administration Action returns for a
 * caller with no currently admitted V1 source contribution, and it is a settled
 * answer rather than a thrown error: a Settings page that has just been retired
 * must render a refusal, not a crash.
 *
 * `currentnessConflict` is kept separate from it for the same reason the
 * administration result keeps them separate, and here the distinction is the
 * difference between two opposite sentences: a caller whose admitted view moved
 * DURING the read is still a configured source, and answering `invalidCaller`
 * would tell a person their source is not configured when re-reading would show
 * it is.
 */
export const TriageReadConfiguredSourceInstancesResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('read'),
        instances: defineProtocolArray(TriageConfiguredSourceInstanceRecordV1Schema, {
            maxItems: MAX_TRIAGE_CONFIGURED_INSTANCE_RECORDS_V1,
        }),
        status: defineProtocolUnion([
            defineProtocolLiteral('complete'),
            defineProtocolLiteral('truncated'),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('invalidCaller'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('currentnessConflict'),
    }, { policy: 'closed' }),
]);
export type TriageReadConfiguredSourceInstancesResultV1 = ReturnType<
    typeof TriageReadConfiguredSourceInstancesResultV1Schema.parse
>;
export const TriageReadConfiguredSourceInstancesResultV1JsonSchema: PluginJsonSchema =
    TriageReadConfiguredSourceInstancesResultV1Schema.jsonSchema;
