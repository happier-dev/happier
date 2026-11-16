import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { TriageSessionHandoffContextV1Schema } from '@happier-dev/triage-protocol/v1';
import { FailureAgentActionV1Schema, FailureActionOutcomeV1Schema, FailureActionPlacementV1Schema } from '@happier-dev/plugin-sdk/ui';

export const TRIAGE_NATIVE_FAILURE_ACTION_LOCAL_ID_V1 = 'native-failure/handle-v1';
const closed = { policy: 'closed' } as const;
const text = defineProtocolString();
const bool = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const context = { context: TriageSessionHandoffContextV1Schema };

/** This plugin owns operation parsing; the host only forwards the selected contribution's input. */
export const TriageNativeFailureInputV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('readAgentActions'), ...context, includeDefault: bool }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('launch'), ...context, actionId: text.optional(),
    delivery: defineProtocolUnion([defineProtocolLiteral('send'), defineProtocolLiteral('compose')]).optional(),
    placement: FailureActionPlacementV1Schema.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('readLinkedSession'), ...context }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('edit'), actionId: text.optional() }, closed),
]);
export type TriageNativeFailureInputV1 = ReturnType<typeof TriageNativeFailureInputV1Schema.parse>;

export const TriageNativeFailureResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('actions'), actions: defineProtocolArray(FailureAgentActionV1Schema).nullable() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('presentation'), outcome: FailureActionOutcomeV1Schema.nullable() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('linkedSession'), session: ActionSessionAddressV1Schema.nullable() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('edited') }, closed),
]);
