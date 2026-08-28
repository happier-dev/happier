import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol';

import { createAutomationDefinitionFromDetail } from './automationDefinitionProjection';
import type { AutomationDefinition } from './automationTypes';
import {
    countEnabledAutomationDefinitionsLinkedToSession,
    filterAutomationDefinitionsLinkedToSession,
    projectAutomationDefinitionSessionLink,
} from './automationSessionLink';

const timestamp = 1_786_257_600_000;

function detail(overrides: Partial<AutomationDefinitionDetail> = {}): AutomationDefinitionDetail {
    return {
        id: 'automation-1',
        name: 'Current automation',
        description: null,
        enabled: true,
        targetType: 'existingSession',
        existingSessionId: 'session-1',
        templateVersion: 3,
        lastRunAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        assignments: [],
        retiredTriggers: [],
        triggers: [],
        executionRecipe: {
            v: 1,
            templateVersion: 3,
            template: { t: 'plain', v: { v: 1, prompt: 'Review the current work.' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'session-1' },
        },
        ...overrides,
    };
}

describe('automationSessionLink', () => {
    it('projects the current existing-Session association only from exact direct detail', () => {
        const projected = projectAutomationDefinitionSessionLink({
            automation: createAutomationDefinitionFromDetail(detail()),
        });

        expect(projected.linkedExistingSessionId).toBe('session-1');
    });

    it('fails closed for summaries, new-Session targets, and mismatched recipe revisions', () => {
        const summaryOnly = {
            id: 'summary-only',
            enabled: true,
            targetType: 'existingSession',
            linkedExistingSessionId: null,
            detail: { kind: 'unloaded', templateVersion: 3 },
        } as AutomationDefinition;
        const newSession = {
            ...createAutomationDefinitionFromDetail(detail({ id: 'new-session' })),
            targetType: 'newSession',
            linkedExistingSessionId: 'stale-session',
        } as AutomationDefinition;
        const mismatched = createAutomationDefinitionFromDetail(detail({
            id: 'mismatched',
            executionRecipe: { ...detail().executionRecipe!, templateVersion: 2 },
        }));

        expect(projectAutomationDefinitionSessionLink({ automation: summaryOnly }).linkedExistingSessionId).toBeNull();
        expect(projectAutomationDefinitionSessionLink({ automation: newSession }).linkedExistingSessionId).toBeNull();
        expect(projectAutomationDefinitionSessionLink({ automation: mismatched }).linkedExistingSessionId).toBeNull();
    });

    it('filters and counts enabled definitions using the one projected association', () => {
        const linked = projectAutomationDefinitionSessionLink({
            automation: createAutomationDefinitionFromDetail(detail()),
        });
        const disabled = { ...linked, id: 'disabled', enabled: false } as AutomationDefinition;
        const other = { ...linked, id: 'other', linkedExistingSessionId: 'session-2' } as AutomationDefinition;

        expect(filterAutomationDefinitionsLinkedToSession([linked, disabled, other], 'session-1').map((item) => item.id))
            .toEqual(['automation-1', 'disabled']);
        expect(countEnabledAutomationDefinitionsLinkedToSession([linked, disabled, other], 'session-1')).toBe(1);
    });
});
