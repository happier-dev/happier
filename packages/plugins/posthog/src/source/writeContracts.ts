import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    TriageSourceEntryLocalRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

const target = {
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
};
export const PosthogIssueWriteInputV1Schema = defineProtocolObject(target, { policy: 'closed' });
export const PosthogAssigneeV1Schema = defineProtocolUnion([
    defineProtocolObject({ type: defineProtocolLiteral('user'), id: defineProtocolNumber({ integer: true, minimum: 1 }) }, { policy: 'closed' }),
    defineProtocolObject({ type: defineProtocolLiteral('role'), id: defineProtocolString({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }, { policy: 'closed' }),
]);
export const PosthogIssueAssignInputV1Schema = defineProtocolObject({
    ...target,
    assignee: defineProtocolUnion([
        PosthogAssigneeV1Schema,
        // PostHog's ErrorTrackingIssueAssignRequestSerializer explicitly accepts
        // null to remove assignment (posthog/posthog, issues.py, 2026-11-07).
        defineProtocolLiteral(null),
    ]),
}, { policy: 'closed' });
