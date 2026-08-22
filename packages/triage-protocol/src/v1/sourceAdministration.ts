import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from './bounds.js';
import { TriageSourceInstanceIdV1Schema } from './identity.js';
import { TriageSourceInstanceDraftV1Schema } from './instances.js';

/** The Action's target-local id. */
export const TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1 = 'sources/administer-v1';
/** The Action's stable registration/descriptive id. */
export const TRIAGE_SOURCES_ADMINISTER_ACTION_ID_V1 = 'happier.triage/sources/administer-v1';
/**
 * The exact qualified ref a source Settings surface passes to
 * `hostApi.executeAction(...)`. The Settings UI neither imports a private
 * Triage function nor discovers or searches Actions (`CONTRACT.md` §3.0).
 */
export const TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1 = Object.freeze({
    pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
    localId: TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
});

/**
 * The one caller-bound source-administration ABI.
 *
 * The request carries no source, plugin, or contribution identity: the host
 * derives the caller from the invocation context and requires its admitted V1
 * contribution to agree before the Triage handler runs. `create` never
 * promotes a discovered candidate automatically, and `reactivate` restores only
 * a preexisting eligible caller-owned row (`CONTRACT.md` §3.0).
 */
export const TriageSourceAdministrationActionInputV1Schema = defineProtocolUnion([
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('create'),
        draft: TriageSourceInstanceDraftV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('reconfigure'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
        draft: TriageSourceInstanceDraftV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('remove'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        v: defineProtocolLiteral(1),
        kind: defineProtocolLiteral('reactivate'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
        draft: TriageSourceInstanceDraftV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageSourceAdministrationActionInputV1 = ReturnType<
    typeof TriageSourceAdministrationActionInputV1Schema.parse
>;

/**
 * Every success arm exposes only the canonical `sourceInstanceId`: it never
 * echoes the binding, configuration, locator, credentials, or a provider DTO.
 * The closed failure arms are `invalidCaller`, `currentnessConflict`,
 * `conflict`, and `atMaximum`; ordinary Action cancellation aborts the
 * invocation rather than producing a result member (`CONTRACT.md` §3.0).
 *
 * `atMaximum` is separate from `conflict` because the two ask the caller for
 * different things: a conflict is resolved by re-reading, while a full
 * configured set is resolved only by the user removing a connection they no
 * longer use. Collapsing them would leave a Settings page with nothing true to
 * say.
 */
export const TriageSourceAdministrationActionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('active'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('reused'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('reconfigured'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('reactivated'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('removed'),
        sourceInstanceId: TriageSourceInstanceIdV1Schema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('invalidCaller'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('currentnessConflict'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('conflict'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('atMaximum'),
    }, { policy: 'closed' }),
]);
export type TriageSourceAdministrationActionResultV1 = ReturnType<
    typeof TriageSourceAdministrationActionResultV1Schema.parse
>;
