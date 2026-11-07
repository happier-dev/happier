import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  TriageSourceEntryLocalRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

const target = {
  v: defineProtocolLiteral(1),
  instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema,
};

export const SentryIssueWriteInputV1Schema = defineProtocolObject(target, { policy: 'closed' });
export const SentryIssueAssignInputV1Schema = defineProtocolObject({
  ...target,
  assignee: defineProtocolUnion([defineProtocolObject({
    type: defineProtocolUnion([defineProtocolLiteral('user'), defineProtocolLiteral('team')]),
    id: defineProtocolString({ pattern: '^[0-9]+$' }),
  }, { policy: 'closed' }), defineProtocolLiteral(null)]),
}, { policy: 'closed' });
