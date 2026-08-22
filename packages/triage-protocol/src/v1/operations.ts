import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1 } from './bounds.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import {
    TriageEntryLocatorV1Schema,
    TriageSourceEntryLocalRefV1Schema,
} from './identity.js';
import { TriageConfiguredSourceInstanceV1Schema } from './instances.js';
import {
    TriageScanContinuationV1Schema,
    TriageScanObservationsV1ProtocolSchema,
    TriageSourceObservationV1Schema,
    TriageSourceScanEvidenceV1Schema,
} from './observations.js';

/**
 * One scan page request.
 *
 * The initial arm carries the caller's page `limit`; the continuation arm
 * carries only the source's bounded opaque continuation, which already binds
 * that limit and the provider-native page geometry. Omitting `limit` from the
 * continuation arm is deliberate: it makes a mid-scan limit change
 * unrepresentable (`CONTRACT.md` §5.1).
 */
export const TriageScanInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        instance: TriageConfiguredSourceInstanceV1Schema,
        page: defineProtocolObject({
            kind: defineProtocolLiteral('initial'),
            limit: defineProtocolNumber({
                integer: true,
                minimum: 1,
                maximum: MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1,
            }),
        }, { policy: 'closed' }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        instance: TriageConfiguredSourceInstanceV1Schema,
        page: defineProtocolObject({
            kind: defineProtocolLiteral('continuation'),
            continuation: TriageScanContinuationV1Schema,
        }, { policy: 'closed' }),
    }, { policy: 'closed' }),
]);
export type TriageScanInputV1 = ReturnType<typeof TriageScanInputV1Schema.parse>;

/**
 * One settled scan page.
 *
 * `page` continues the same in-memory invocation; `complete` ends it. Neither
 * successful arm can express a retry deadline — that fact belongs only to a
 * `TriageSourceFailureV1`, so a provider "retry later" response ends the walk
 * rather than delaying a successful page (`CONTRACT.md` §5.1, §5.2).
 */
export const TriageScanResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('page'),
        observations: TriageScanObservationsV1ProtocolSchema,
        evidence: TriageSourceScanEvidenceV1Schema,
        continuation: TriageScanContinuationV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('complete'),
        observations: TriageScanObservationsV1ProtocolSchema,
        evidence: TriageSourceScanEvidenceV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageScanResultV1 = ReturnType<typeof TriageScanResultV1Schema.parse>;

/**
 * One authoritative read of one local ref through one exact configured
 * instance. The result's `localRef` must equal this input exactly; a different
 * ref is invalid rather than a redirect (`CONTRACT.md` §5, §6).
 *
 * `lastKnownLocator` is the newest locator the target observed for this exact
 * entry, copied back unchanged. An account-wide scan discovers entries across
 * many provider scopes, so the configured instance alone cannot name the one
 * this entry lives in; without the locator a source would have to either
 * re-derive a route from identity — which the locator-only rule forbids — or
 * answer `unresolved`. The locator carries no authority: the source is still
 * the only parser of its own opaque `routingToken`, still reauthorizes the
 * exact account, and still validates the provider response against the
 * requested ref before calling anything `present`. It is absent on a first read
 * and on any entry the target has never observed (`CONTRACT.md` §5, §6).
 */
export const TriageGetInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
    lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageGetInputV1 = ReturnType<typeof TriageGetInputV1Schema.parse>;

/**
 * `get` is the only operation that may conclude absence, so its result is the
 * complete four-arm observation union rather than a second envelope
 * (`CONTRACT.md` §2.2, §4).
 */
export const TriageGetResultV1Schema = TriageSourceObservationV1Schema;
export type TriageGetResultV1 = ReturnType<typeof TriageGetResultV1Schema.parse>;
