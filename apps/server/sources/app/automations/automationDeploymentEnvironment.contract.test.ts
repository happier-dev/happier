import { describe, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';

describe('Environment Automation create contract', () => {
    it.each(['preview_admission', 'preview_cleanup'])('accepts the closed %s preview role', previewRole => {
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Preview' });
        const input = { automationId: crypto.randomUUID(), name: 'Preview', enabled: true, triggers: [],
            assignments: [{ machineId: 'controller' }], executionRecipe: { ...recipe, deploymentEnvironment: {
                serverId: `srv_${'d'.repeat(32)}`, projectSourceId: 'source', environmentId: 'template', previewRole,
            } } };
        expect(AutomationDefinitionCreateRequestSchema.safeParse(input).success).toBe(true);
        expect(AutomationDefinitionCreateRequestSchema.safeParse({ ...input, executionRecipe: { ...input.executionRecipe,
            deploymentEnvironment: { ...input.executionRecipe.deploymentEnvironment, previewRole: 'other' },
        } }).success).toBe(false);
    });
    it('admits qualified Environment provenance through the canonical create input', () => {
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Deploy' });
        const input = AutomationDefinitionCreateRequestSchema.safeParse({ automationId: crypto.randomUUID(),
            name: 'Environment deployment', enabled: true, triggers: [], assignments: [{ machineId: 'controller' }],
            executionRecipe: { ...recipe, deploymentEnvironment: { serverId: `srv_${'d'.repeat(32)}`,
                projectSourceId: 'source', environmentId: 'environment' } } });
        expect(input.success).toBe(true);
    });
});
