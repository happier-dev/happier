import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryLocatorV1Schema,
  TriageEntryRefV1Schema,
  TriageSourceInstanceIdV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { TriageProjectedObservationV1Schema } from './listEntriesProtocol.js';

export const TriageReobserveEntryInputV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1),
  entryRef: TriageEntryRefV1Schema,
  sourceInstanceId: TriageSourceInstanceIdV1Schema,
  lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
}, { policy: 'closed' });
export type TriageReobserveEntryActionInputV1 = ReturnType<
  typeof TriageReobserveEntryInputV1Schema.parse
>;

export const TriageReobserveEntryResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('observed'),
    entryRef: TriageEntryRefV1Schema,
    observation: TriageProjectedObservationV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('rejected') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('invalidCaller') }, { policy: 'closed' }),
]);
export type TriageReobserveEntryActionResultV1 = ReturnType<
  typeof TriageReobserveEntryResultV1Schema.parse
>;

export const TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 = 'entries/reobserve-v1';
