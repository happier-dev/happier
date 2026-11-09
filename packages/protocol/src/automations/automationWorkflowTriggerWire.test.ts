import { describe, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionListRequestSchema, AutomationV3WorkerClaimedRunSchema } from './automationApiV3.js';
import { AutomationRunCauseSchema } from './automationRunCause.js';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '../artifacts/artifactListSelectionV1.js';

describe('workflow trigger wire contract', () => {
  it('admits one complete Artifact page of workflow selectors and refuses conflicting or oversized demand', () => {
    const ids = Array.from({ length: ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 }, (_, index) => `plugin:com.external.workflows/page-${index}`);
    expect(AutomationDefinitionListRequestSchema.safeParse({ workflowDefinitionIds: ids }).success).toBe(true);
    expect(AutomationDefinitionListRequestSchema.safeParse({ workflowDefinitionIds: [...ids, 'builtin:extra'] }).success).toBe(false);
    expect(AutomationDefinitionListRequestSchema.safeParse({ workflowDefinitionIds: [], workflowDefinitionId: 'builtin:review' }).success).toBe(false);
    expect(AutomationDefinitionListRequestSchema.safeParse({ workflowDefinitionIds: [], scope: 'account_inline' }).success).toBe(false);
    expect(AutomationDefinitionListRequestSchema.parse({ workflowDefinitionIds: [] }).workflowDefinitionIds).toEqual([]);
  });
  it('carries the reference outside the sealed context and scopes definition reads', () => {
    expect(AutomationDefinitionCreateRequestSchema.safeParse({
      automationId: 'fbd3d978-0c53-47f9-a708-86bf36fe27b4', name: 'Review', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge', scopeSessionId: null,
      executionRecipe: { v: 2, templateVersion: 0, workflow: { t: 'plain', v: {
        workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
      } }, triggerEvidence: null }, assignments: [{ machineId: 'machine' }], triggers: [],
    }).success).toBe(true);
    expect(AutomationDefinitionListRequestSchema.safeParse({ workflowDefinitionId: 'builtin:review-and-converge' }).success).toBe(true);
    expect(AutomationDefinitionListRequestSchema.safeParse({ scope: 'account_inline' }).success).toBe(true);
    expect(AutomationDefinitionListRequestSchema.safeParse({ scope: 'account_inline', workflowDefinitionId: 'builtin:review-and-converge' }).success).toBe(false);
    expect(AutomationDefinitionListRequestSchema.safeParse({ scope: 'account_inline', scopeSessionId: 'session' }).success).toBe(false);
  });

  it('retains scoped conversation trigger identity and frozen cause depth through claim parsing', () => {
    const cause = { kind: 'conversation', triggerId: 'trigger', occurrenceKey: 'A'.repeat(43), occurredAt: 10 };
    expect(AutomationRunCauseSchema.safeParse(cause).success).toBe(true);
    expect(AutomationV3WorkerClaimedRunSchema.safeParse({
      id: 'run', automationId: 'automation', attempt: 1, leaseExpiresAt: Date.now() + 120_000, revision: 0, recipeKind: 'workflow-v2',
      executionInputEnvelope: 'sealed', automationEvidenceEnvelope: 'evidence', triggerId: 'trigger',
      triggerRetired: false, cause, causeWorkDepth: 3,
    }).success).toBe(true);
  });
});
