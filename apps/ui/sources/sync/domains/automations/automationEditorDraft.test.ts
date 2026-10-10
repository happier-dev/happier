import { describe, expect, it } from 'vitest';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, AutomationTriggerIdSchema } from '@happier-dev/protocol';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import {
    createAutomationEditorLifetimeIdentity,
    isAutomationEditorLifetimeIdentityCurrent,
    replaceAutomationEditorExecutionRecipe,
    shouldValidateAutomationEditorLifecycleTrigger,
    type AutomationEditorDraft,
} from './automationEditorDraft';

describe('Automation editor draft continuity', () => {
    it('binds a mounted draft to its exact Account, server, and definition identity', () => {
        const mounted = createAutomationEditorLifetimeIdentity(
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-a',
        );
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-a',
        )).toBe(true);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-b' },
            'automation-a',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-b', accountId: 'account-a' },
            'automation-a',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(
            mounted,
            { serverId: 'server-a', accountId: 'account-a' },
            'automation-b',
        )).toBe(false);
        expect(isAutomationEditorLifetimeIdentityCurrent(null, null, 'automation-a')).toBe(false);
    });


    it('owns the exact next-version transition for a Workflow recipe edit', () => {
        const executionRecipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 8,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                inlineDefinition: createWorkflowDefinitionFixture() } }, triggerEvidence: null });
        const current: AutomationEditorDraft = { automationId: 'automation-1', pendingAutomationId: null,
            expectedTemplateVersion: 8, removedTriggers: [], name: 'Workflow', description: null, enabled: true,
            executionRecipe, assignments: [], triggers: [] };
        const next = replaceAutomationEditorExecutionRecipe(current, { ...executionRecipe, templateVersion: 9 });
        expect(next.recipeDirty).toBe(true);
        expect(next.executionRecipe.templateVersion).toBe(9);
        expect(() => replaceAutomationEditorExecutionRecipe(current, current.executionRecipe)).toThrow();
    });

    it('revalidates exact-turn currentness only for new or changed rows', () => {
        const lifecycle = {
            clientId: 'turn-trigger',
            persisted: { id: AutomationTriggerIdSchema.parse('turn-trigger'), revision: 4 },
            definition: {
                kind: 'sessionLifecycle' as const,
                enabled: true,
                sourceSessionId: 'source',
                events: ['parentTurnCompleted'] as ['parentTurnCompleted'],
                policy: { kind: 'currentTurn' as const, sourceTurnId: 'turn' },
            },
        };

        expect(shouldValidateAutomationEditorLifecycleTrigger(lifecycle)).toBe(false);
        expect(shouldValidateAutomationEditorLifecycleTrigger({ ...lifecycle, isDirty: true })).toBe(true);
        expect(shouldValidateAutomationEditorLifecycleTrigger({
            ...lifecycle,
            isDirty: true,
            definition: { ...lifecycle.definition, enabled: false },
        })).toBe(false);
        expect(shouldValidateAutomationEditorLifecycleTrigger({ ...lifecycle, persisted: null })).toBe(true);
    });
});
