import { TodoClaimAttemptBindingV1ProtocolSchema, defineProtocolArray, defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriageSourceFailureV1Schema, TriageSourceInstanceIdV1Schema, TriageTaskVersionV1Schema,
  TriageReadSourceSessionLinksResultV1Schema } from '@happier-dev/triage-protocol/v1';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;

/** Account identity already selected by the Task owner; shared by order projection and drop input. */
export const PersonalTaskOrderScopeSchema = defineProtocolObject({ serverId: text, accountId: text }, closed);

/** Private page projection of the inventory that supplied the scan, never a second inventory read. */
export const InternalTaskListProjectionSchema = defineProtocolObject({
  sourceInstanceId: TriageSourceInstanceIdV1Schema,
  order: defineProtocolObject({ scope: PersonalTaskOrderScopeSchema, undoneOrder: defineProtocolArray(text) }, closed).optional(),
  entries: defineProtocolArray(defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    result: TriageReadSourceSessionLinksResultV1Schema,
    claim: defineProtocolObject({
      attemptBinding: TodoClaimAttemptBindingV1ProtocolSchema,
      claimedAt: defineProtocolNumber().optional(),
      version: TriageTaskVersionV1Schema,
    }, closed).optional(),
  }, closed)),
  failure: TriageSourceFailureV1Schema.optional(),
}, closed);
export type InternalTaskListProjection = ReturnType<typeof InternalTaskListProjectionSchema.parse>;
export type TriageReleasedTaskClaimV1 = NonNullable<InternalTaskListProjection['entries'][number]['claim']> & Readonly<{
  reason: 'run_terminal' | 'host_lost';
}>;
