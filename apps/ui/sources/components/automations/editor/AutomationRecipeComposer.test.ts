import { describe, expect, it } from 'vitest';
import { AutomationStoredDefinitionExecutionRecipeV1Schema } from '@happier-dev/protocol';

import type { AutomationEditorDraft } from '@/sync/domains/automations/automationEditorDraft';
import {
    buildAutomationExecutionRunTarget,
    sessionCanBeAutomationExecutionTarget,
} from './AutomationRecipeComposer';

function draft(): AutomationEditorDraft {
    return {
        automationId: 'automation-1',
        pendingAutomationId: null,
        expectedTemplateVersion: 1,
        removedTriggers: [],
        name: 'Review',
        description: null,
        enabled: true,
        executionRecipe: AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
            v: 1,
            templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: 'Review' } },
            triggerEvidence: null,
            target: { kind: 'existingSession', sessionId: 'target-session' },
        }),
        assignments: [{ machineId: 'machine-1', enabled: true, priority: 0 }],
        triggers: [{
            clientId: 'turn-trigger',
            persisted: null,
            definition: {
                kind: 'sessionLifecycle',
                enabled: true,
                event: 'parentTurnCompleted',
                scope: { kind: 'exactTurn', sourceSessionId: 'source-session', sourceTurnId: 'turn-1' },
                consumption: 'once',
            },
        }],
    };
}

describe('AutomationRecipeComposer owners', () => {
    it('builds only the strict detached bounded execution target', () => {
        expect(buildAutomationExecutionRunTarget({
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            permissionMode: 'read_only',
        })).toEqual({
            kind: 'executionRun',
            request: {
                intent: 'task',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
        });
    });

    it('does not offer an exact-turn source Session as the execution target', () => {
        expect(sessionCanBeAutomationExecutionTarget(draft(), 'source-session')).toBe(false);
        expect(sessionCanBeAutomationExecutionTarget(draft(), 'another-session')).toBe(true);
    });
});
