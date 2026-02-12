import { describe, expect, it } from 'vitest';

import type { Automation } from './automationTypes';
import { countEnabledAutomationsLinkedToSession, filterAutomationsLinkedToSession } from './automationSessionLink';

function makeAutomation(params: Partial<Automation> & Pick<Automation, 'id' | 'targetType' | 'templateCiphertext'>): Automation {
    return {
        id: params.id,
        name: params.name ?? 'A',
        description: params.description ?? null,
        enabled: params.enabled ?? true,
        schedule: params.schedule ?? { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
        targetType: params.targetType,
        templateCiphertext: params.templateCiphertext,
        templateVersion: params.templateVersion ?? 1,
        nextRunAt: params.nextRunAt ?? null,
        lastRunAt: params.lastRunAt ?? null,
        createdAt: params.createdAt ?? Date.now(),
        updatedAt: params.updatedAt ?? Date.now(),
        assignments: params.assignments ?? [],
    };
}

describe('automationSessionLink', () => {
    it('filters automations linked to a session by reading the envelope existingSessionId', () => {
        const linked = makeAutomation({
            id: 'a1',
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
                existingSessionId: 's1',
            }),
        });
        const otherSession = makeAutomation({
            id: 'a2',
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
                existingSessionId: 's2',
            }),
        });
        const newSession = makeAutomation({
            id: 'a3',
            targetType: 'new_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
            }),
        });

        expect(filterAutomationsLinkedToSession([linked, otherSession, newSession], 's1').map((a) => a.id)).toEqual(['a1']);
    });

    it('counts enabled automations linked to a session', () => {
        const enabledLinked = makeAutomation({
            id: 'a1',
            enabled: true,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
                existingSessionId: 's1',
            }),
        });
        const disabledLinked = makeAutomation({
            id: 'a2',
            enabled: false,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
                existingSessionId: 's1',
            }),
        });
        const other = makeAutomation({
            id: 'a3',
            enabled: true,
            targetType: 'existing_session',
            templateCiphertext: JSON.stringify({
                kind: 'happier_automation_template_encrypted_v1',
                payloadCiphertext: 'cipher',
                existingSessionId: 's2',
            }),
        });

        expect(countEnabledAutomationsLinkedToSession([enabledLinked, disabledLinked, other], 's1')).toBe(1);
    });
});
