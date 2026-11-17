import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectAutomationSessionLifecycleStructuralTrigger, type AutomationSessionLifecycleTrigger } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { openAutomationTriggerDefinitionStoredEnvelopeV1, sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { decodeAutomationSessionLifecycleConfiguration, encodeAutomationSessionLifecycleConfiguration } from './automationSessionLifecycleConfigurationCodec';

describe('Session lifecycle matching-header persistence', () => {
    it.each(['plain', 'e2ee'] as const)('roundtrips %s private filters with digest-only matching headers', mode => {
        const definition: AutomationSessionLifecycleTrigger = {
            kind: 'sessionLifecycle', events: ['parentTurnCompleted'], policy: { kind: 'firstMatch' },
            filter: { v: 1, all: [
                { field: '/launchProfileId', op: 'in', values: ['profile-private-a', 'profile-private-b'] },
                { field: '/changedFiles', op: 'eq', value: false },
            ] },
        };
        const binding = { v: 1 as const, automationId: randomUUID(), triggerId: randomUUID(),
            triggerRevision: 1, triggerKind: 'sessionLifecycle' as const };
        const material = { type: 'dataKey' as const, machineKey: randomBytes(32) };
        const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, definition,
            ...(mode === 'plain' ? { mode } : { mode, material, randomBytes }) });
        const projected = projectAutomationSessionLifecycleStructuralTrigger(definition);
        const row = encodeAutomationSessionLifecycleConfiguration(projected);
        const stored = decodeAutomationSessionLifecycleConfiguration(row);
        expect(stored.definition).toEqual(projected);
        expect(stored.definition.filter?.all[1]).toEqual({ field: '/changedFiles', op: 'eq', value: false });
        expect(JSON.stringify(row)).not.toContain('profile-private');
        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ binding, envelope,
            ...(mode === 'plain' ? { mode } : { mode, material }) });
        expect(opened).toMatchObject({ kind: 'available', definition });
    });
});
