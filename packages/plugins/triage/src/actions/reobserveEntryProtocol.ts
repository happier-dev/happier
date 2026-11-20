import {
  defineProtocolLiteral,
  defineProtocolJsonValue,
  defineProtocolObject,
  defineProtocolUnion,
  TriageIdentifierV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { ScmComparisonSourceProtocolSchema } from '@happier-dev/plugin-sdk/scm';
import {
  TriageEntryLocatorV1Schema,
  TriageEntryRefV1Schema,
  TriageSourceInstanceIdV1Schema,
  TriageSourceFailureV1Schema,
  TriageTaskFieldChoicesV1Schema,
  TriageTaskFieldsV1Schema,
  TriageInvestigationDefaultsV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { TriageProjectedObservationV1Schema } from './listEntriesProtocol.js';

const exactEntryInput = {
  v: defineProtocolLiteral(1),
  entryRef: TriageEntryRefV1Schema,
  sourceInstanceId: TriageSourceInstanceIdV1Schema,
  /** Private exact row address from source admission; never configuration authority. */
  sourceInstanceRowId: TriageIdentifierV1ProtocolSchema.optional(),
  lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
  /** Exact edit recovery only; full field values never enter the list projection. */
  includeTaskFields: defineProtocolLiteral(true).optional(),
  /** The opened detail's field directories; never read for a list row. */
  includeTaskFieldChoices: defineProtocolLiteral(true).optional(),
};
export const TriageReadPullRequestStatusInputV1Schema = defineProtocolObject(exactEntryInput, { policy: 'closed' });
export const TriageReobserveEntryInputV1Schema = defineProtocolObject({
  ...exactEntryInput,
  includeComparisonSource: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });
export type TriageReobserveEntryActionInputV1 = ReturnType<
  typeof TriageReobserveEntryInputV1Schema.parse
>;

export const TriageReobserveEntryResultV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('observed'),
    entryRef: TriageEntryRefV1Schema,
    observation: TriageProjectedObservationV1Schema,
    taskFields: TriageTaskFieldsV1Schema.optional(),
    taskFieldChoices: TriageTaskFieldChoicesV1Schema.optional(),
    investigationDefaults: TriageInvestigationDefaultsV1Schema.optional(),
    comparisonSource: ScmComparisonSourceProtocolSchema.optional(),
    detailData: defineProtocolJsonValue().optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('rejected') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('invalidCaller') }, { policy: 'closed' }),
]);
export type TriageReobserveEntryActionResultV1 = ReturnType<
  typeof TriageReobserveEntryResultV1Schema.parse
>;

export const TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 = 'entries/reobserve-v1';
