import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { DatabaseFindingSourceScopeV1ProtocolSchema, type DatabaseFindingV1 } from '@happier-dev/plugin-sdk/database';
import { AutomationDatabaseSubjectV1ProtocolSchema } from '@happier-dev/plugin-sdk/events';
import { defineProtocolLiteral, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import type { OpenAutomationEventRequest } from '@happier-dev/plugin-sdk/ui';

export const DATABASE_FINDING_EVENT_REF = { pluginId: 'happier.database', localId: 'finding-observed' } as const;

export const DatabaseFindingEventSourceV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), subject: AutomationDatabaseSubjectV1ProtocolSchema.optional(),
    sourceScope: DatabaseFindingSourceScopeV1ProtocolSchema,
}, { policy: 'closed' });
export type DatabaseFindingEventSourceV1 = ReturnType<typeof DatabaseFindingEventSourceV1Schema.parse>;

export function buildDatabaseFindingWorkflowSeed(finding: DatabaseFindingV1): OpenAutomationEventRequest | undefined {
    const binding = readAutomationDatabaseSubjectV1(finding.sourceScope.serverId, finding.target);
    if (!binding.ok) return undefined;
    return {
        eventRef: DATABASE_FINDING_EVENT_REF,
        monitoringMachineId: finding.sourceScope.machineId,
        setupInput: { v: 1, subject: binding.subject, sourceScope: finding.sourceScope },
        initialFilter: { v: 1, all: [{ op: 'eq', field: '/observation/kind', value: finding.kind }] },
    };
}
