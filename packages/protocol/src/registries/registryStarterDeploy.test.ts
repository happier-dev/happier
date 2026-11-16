import { it, expect } from 'vitest';
import { RegistryStarterV1Schema } from './registryStarterV1.js';
import { LlmTaskIdV1Schema, LLM_TASK_DECLARATIONS_V1 } from '../llm/tasks/llmTaskRunnerSelection.js';
it('admits names-only starter deployment facts and rejects a variable value', () => {
    const starter = { repository: 'https://github.com/mdn/beginner-html-site-styled', title: 'Static', description: 'Static', tags: ['static'], buildGoal: 'Build',
        deploy: { framework: 'html', output: 'static', variables: [{ key: 'API_KEY', secret: true }] } };
    expect(RegistryStarterV1Schema.safeParse(starter).success).toBe(true);
    expect(RegistryStarterV1Schema.safeParse({ ...starter, deploy: { ...starter.deploy, variables: [{ key: 'API_KEY', secret: true, value: 'secret' }] } }).success).toBe(false);
});
it('declares a structured no-tools deploy task', () => {
    expect(LlmTaskIdV1Schema.safeParse('deploy_suggestion').success).toBe(true);
    expect(LLM_TASK_DECLARATIONS_V1).toHaveProperty('deploy_suggestion', { structuredOutput: 'required', permissionModes: ['no_tools'], costTiers: 'standard_first' });
});
