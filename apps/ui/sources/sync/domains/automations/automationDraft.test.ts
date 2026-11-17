import { describe, expect, it } from 'vitest';
import { AutomationStoredDefinitionExecutionRecipeV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';

import {
    DEFAULT_NEW_SESSION_AUTOMATION_DRAFT,
    materializeNewSessionAutomationEditorDraft,
    sanitizeNewSessionAutomationDraft,
    replaceExactTurnAutomationRowsWithCurrentTurns,
} from './automationDraft';

const schedule = {
    kind: 'schedule' as const,
    enabled: true,
    schedule: { kind: 'interval' as const, everyMs: 60_000, scheduleExpr: null, timezone: null },
};

describe('automationDraft', () => {
    it('advances an exact Session subject to its observed turn without changing sibling selections', () => {
        const exact = { clientId: 'exact', definition: { kind: 'sessionLifecycle' as const,
            subject: { kind: 'session' as const, serverId: 'srv_00000000000000000000000000000000', sessionId: 'source-session' },
            events: ['parentTurnCompleted' as const], policy: { kind: 'currentTurn' as const, sourceTurnId: 'old-turn' } } };
        const sibling = { clientId: 'schedule', definition: schedule };
        const draft = { ...DEFAULT_NEW_SESSION_AUTOMATION_DRAFT, triggers: [exact, sibling] };
        const next = replaceExactTurnAutomationRowsWithCurrentTurns({ automation: draft,
            readExactTurn: sessionId => sessionId === 'source-session' ? { sourceTurnId: 'current-turn' } : null });
        expect(next).toMatchObject({ changed: true, canReplace: true,
            automation: { triggers: [{ ...exact, definition: { ...exact.definition,
                policy: { kind: 'currentTurn', sourceTurnId: 'current-turn' } } }, sibling] } });
        expect(next.automation.triggers[1]).toBe(sibling);
    });
    it('restores retained trigger definitions while dropping unknown fields recursively', () => {
        expect(sanitizeNewSessionAutomationDraft({ enabled: true, triggers: [{ clientId: 'saved', definition: {
            ...schedule, retired: true, schedule: { ...schedule.schedule, retired: true },
        } }] }).triggers).toEqual([{ clientId: 'saved', definition: schedule }]);
    });
    it('keeps zero or multiple strict trigger rows with stable client identities', () => {
        expect(DEFAULT_NEW_SESSION_AUTOMATION_DRAFT.triggers).toEqual([]);
        expect(sanitizeNewSessionAutomationDraft({
            enabled: true,
            name: 'Daily summary',
            description: '',
            triggers: [
                { clientId: 'schedule-a', definition: schedule },
                {
                    clientId: 'turn-b',
                    definition: {
                        kind: 'sessionLifecycle',
                        enabled: false,
                        subject: { kind: 'session', serverId: 'srv_00000000000000000000000000000000', sessionId: 'session-1' },
                        events: ['parentTurnCompleted'],
                        policy: { kind: 'currentTurn', sourceTurnId: 'turn-1' },
                    },
                },
            ],
        }).triggers.map((row) => row.clientId)).toEqual(['schedule-a', 'turn-b']);
    });

    it('drops malformed and duplicate rows instead of choosing a first trigger', () => {
        expect(sanitizeNewSessionAutomationDraft({
            enabled: true,
            name: 'Automation',
            description: '',
            triggers: [
                { clientId: 'same', definition: schedule },
                { clientId: 'same', definition: schedule },
                { clientId: 'invalid', definition: { kind: 'manual', enabled: true } },
            ],
        }).triggers).toEqual([{ clientId: 'same', definition: schedule }]);
    });

    it('materializes every trigger into the one canonical editor draft', () => {
        const executionRecipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
            v: 1,
            templateVersion: 1,
            template: { t: 'plain', v: { v: 1, prompt: 'Run.' } },
            triggerEvidence: null,
            target: {
                kind: 'executionRun',
                request: {
                    intent: 'task',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                },
            },
        });
        const result = materializeNewSessionAutomationEditorDraft({
            draft: {
                pendingAutomationId: 'automation-stable-retry-id',
                enabled: true,
                name: '  Daily summary  ',
                description: '  Description  ',
                triggers: [{ clientId: 'schedule-a', definition: schedule }],
            },
            executionRecipe,
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
        });
        expect(result).toMatchObject({
            automationId: null,
            pendingAutomationId: 'automation-stable-retry-id',
            expectedTemplateVersion: null,
            name: 'Daily summary',
            description: 'Description',
            enabled: true,
            executionRecipe,
            assignments: [{ machineId: 'machine-1', enabled: true, priority: 100 }],
            triggers: [{ clientId: 'schedule-a', persisted: null, definition: schedule }],
        });
    });
});
