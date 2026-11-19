import { describe, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema, AutomationDefinitionListRequestSchema, AutomationV3WorkerClaimedRunSchema, AutomationTriggerReconcileExistingItemSchema } from './automationApiV3.js';
import { AutomationActionEncryptedTriggerSchema, ActionAutomationIndexV1Schema } from './automationActionTriggerV1.js';
import { AutomationRunCauseSchema } from './automationRunCause.js';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '../artifacts/artifactListSelectionV1.js';
import { AutomationScheduleTriggerInputSchema } from './automationTriggerDefinition.js';

describe('workflow trigger wire contract', () => {
  it('carries shared Workflow-key Action definitions in writes, reseals and the actor index', () => {
    const content = { t: 'encrypted', c: 'workflow-key-ciphertext' };
    const triggerDefinitionEnvelope = { t: 'workflow', revision: { headerVersion: 1, bodyVersion: 1 }, content };
    expect(AutomationActionEncryptedTriggerSchema.safeParse({ kind: 'action', phase: 'after',
      actionIds: ['session.archive'], triggerDefinitionEnvelope }).success).toBe(true);
    expect(AutomationTriggerReconcileExistingItemSchema.safeParse({ kind: 'existing', triggerId: 'trigger',
      expectedRevision: 1, enabled: true, triggerDefinitionEnvelope }).success).toBe(true);
    expect(ActionAutomationIndexV1Schema.safeParse({ v: 1, rows: [{ automationId: 'automation', triggerId: 'trigger',
      triggerRevision: 1, workflowId: 'workflow', workflowRevision: 1, ownerAccountId: 'owner',
      phase: 'after', actionIds: ['session.archive'], reachesOthers: true, sharedDefinitionEnvelope: content }] }).success).toBe(true);
  });
  it('preserves an absolute one-time instant and refuses an unrepresentable Date', () => {
    const trigger = { kind: 'schedule', enabled: true, schedule: { kind: 'once', scheduledAt: Date.UTC(2026, 10, 10, 9) } };
    expect(AutomationScheduleTriggerInputSchema.parse(trigger)).toEqual(trigger);
    expect(AutomationScheduleTriggerInputSchema.safeParse({ ...trigger, schedule: { kind: 'once', scheduledAt: Number.MAX_SAFE_INTEGER } }).success).toBe(false);
  });
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
