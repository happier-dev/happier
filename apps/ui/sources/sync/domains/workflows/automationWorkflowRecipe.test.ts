import { describe, expect, it } from 'vitest';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema, type WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { openAutomationWorkflowRecipeForAuthoring } from './automationWorkflowRecipe';

const definition: WorkflowDefinitionV1 = {
    version: 1,
    inputs: [],
    defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    blocks: [{ kind: 'step', id: 'analyze', document: { text: 'Analyze the release', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
};

describe('automation workflow recipe', () => {
    it.each(['plain', 'encrypted'] as const)('opens unknown stored %s context fields without weakening required fields', async (mode) => {
        const context = { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: definition };
        const stored = { ...context, extra: true, workspace: { ...context.workspace, extra: true }, inlineDefinition: { ...definition, extra: true } };
        const recipe = { v: 2 as const, templateVersion: 3, triggerEvidence: null, extra: true,
            workflow: mode === 'plain' ? { t: 'plain' as const, v: stored, extra: true } : { t: 'encrypted' as const, c: 'ciphertext', extra: true } };
        expect(await openAutomationWorkflowRecipeForAuthoring({ recipe, decryptRaw: async () => stored })).toEqual(context);
        await expect(openAutomationWorkflowRecipeForAuthoring({ recipe: { ...recipe, workflow: { t: 'encrypted', c: 'ciphertext' } },
            decryptRaw: async () => ({ ...stored, workspace: { directory: null } }) })).rejects.toThrow();
    });
    it('opens inline or referenced context through the same Account reader', async () => {
        const context = { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' }, inlineDefinition: definition };
        const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 3, workflow: { t: 'encrypted', c: 'ciphertext' }, triggerEvidence: null });
        expect(await openAutomationWorkflowRecipeForAuthoring({ recipe, decryptRaw: async () => context })).toEqual(context);
        await expect(openAutomationWorkflowRecipeForAuthoring({ recipe })).rejects.toThrow();
        await expect(openAutomationWorkflowRecipeForAuthoring({ recipe, decryptRaw: async () => context, isCurrent: () => false })).rejects.toThrow();
    });
});
