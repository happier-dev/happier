import { describe, expect, it } from 'vitest';
import { AutomationDefinitionDetailSchema, type AutomationDefinitionDetail, type AutomationDefinitionPatchRequest } from '../../automations/automationApiV3.js';
import { isAvailableE2eeAutomationAccountEncryptionV1, type AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { createAccountScopedCryptoMaterialSnapshotV1, openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '../../crypto/accountScopedCipher.js';
import { AutomationStoredWorkflowDefinitionV2ReadSchema } from '../../automations/automationWorkflowRecipeV2.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { backfillAutomationManagedTargetsV1, createAccountWorkflowTriggerActions } from './workflowTriggerAccountHost.js';
import type { WorkflowTriggerAutomationOperations } from './workflowTriggerActions.js';

const plain: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
const encrypted: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
  material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };
const randomBytes = (length: number) => new Uint8Array(length).fill(3);
const target = { homeId: 'home-one', managedId: 'managed-one' };
const managedDefinition = WorkflowDefinitionV1Schema.parse({ version: 1, defaults: {}, inputs: [], blocks: [{
  kind: 'action', id: 'end', actionId: 'machines.managed.power.set', input: {
    homeId: { kind: 'literal', value: target.homeId }, managedId: { kind: 'literal', value: target.managedId },
    intent: { kind: 'literal', value: 'stop' }, when: { kind: 'literal', value: 'after-idle' },
  },
}] });

function fixture(encryption: AvailableAutomationAccountEncryptionV1 = plain) {
  const rows = new Map<string, AutomationDefinitionDetail>();
  const writes: string[] = [];
  const reads: string[] = [];
  const lists: unknown[] = [];
  let fail: 'conflict' | 'lost-receipt' | null = null;
  let editMetadataBeforeWrite = false;
  const seed = (id: string, managed = false, known = false, visibleTeamId: string | null = null) => {
    const payload = { workspace: { directory: '/private/repo' }, executionTarget: { kind: 'detached_run' },
      visibleTeamId,
      ...(managed ? { inlineDefinition: managedDefinition } : {}) };
    const workflow = isAvailableE2eeAutomationAccountEncryptionV1(encryption)
      ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
        material: encryption.material.material, payload, randomBytes }) }
      : { t: 'plain', v: payload };
    const metadata = known ? { managedTarget: managed ? target : null } : {};
    const row = AutomationDefinitionDetailSchema.parse({ id, name: 'Private name', description: null, enabled: false,
      workflowDefinitionId: managed ? null : visibleTeamId ? '13a629b8-d285-40eb-acfe-91451d9cc6cb' : 'builtin:unrelated', scopeSessionId: null, targetType: null, existingSessionId: null,
      templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [], ...metadata,
      executionRecipe: { v: 2, templateVersion: 1, workflow, triggerEvidence: null, ...metadata } });
    rows.set(id, row);
  };
  // The persistent/network Automation boundary is simulated; codecs, schema admission and CAS inputs run real.
  const automations: WorkflowTriggerAutomationOperations & Readonly<{
    patch: (id: string, input: AutomationDefinitionPatchRequest, beforeWrite?: () => Promise<void>) => Promise<AutomationDefinitionDetail>;
  }> = {
    list: async input => {
      lists.push(input);
      return { automations: [...rows.values()].filter(row => !input.managedTargetUnindexed || row.managedTarget === undefined)
        .map(({ executionRecipe: _private, ...row }) => row), nextCursor: null };
    },
    get: async id => { reads.push(id); return rows.get(id) ?? null; },
    create: async () => { throw new Error('No creation during backfill'); }, delete: async () => ({ ok: true }),
    reconcile: async () => { throw new Error('Backfill must not replace complete editor metadata'); },
    patch: async (id, input, beforeWrite) => {
      await beforeWrite?.();
      const row = rows.get(id)!;
      if (fail === 'conflict' || row.templateVersion !== input.expectedTemplateVersion) {
        throw Object.assign(new Error('conflict'), { code: 'currentness_conflict' });
      }
      writes.push(id);
      if (editMetadataBeforeWrite) { row.name = 'Edited concurrently'; row.enabled = true; }
      expect(Object.keys(input).sort()).toEqual(['executionRecipe', 'expectedTemplateVersion']);
      const next = AutomationDefinitionDetailSchema.parse({ ...row, templateVersion: row.templateVersion + 1,
        executionRecipe: input.executionRecipe, managedTarget: input.executionRecipe?.managedTarget });
      rows.set(id, next);
      if (fail === 'lost-receipt') throw Object.assign(new Error('lost'), { code: 'workflow_outcome_unresolved' });
      return next;
    },
  };
  const params = { automations, resolveEncryption: async () => encryption, randomBytes };
  return { params, rows, writes, reads, lists, seed, fail: (value: typeof fail) => { fail = value; },
    editMetadataBeforeWrite: () => { editMetadataBeforeWrite = true; } };
}

describe('Automation managed-target migration', () => {
  it('does not overwrite a concurrent metadata-only edit that keeps the same recipe CAS revision', async () => {
    const f = fixture(); f.seed('old-managed', true); f.editMetadataBeforeWrite();
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 1, unresolved: 0 });
    expect(f.rows.get('old-managed')).toMatchObject({ name: 'Edited concurrently', enabled: true });
  });

  it('keeps an unreadable candidate unknown instead of returning a ready empty rule selection', async () => {
    const f = fixture(); f.seed('unknown-inline');
    f.rows.set('unknown-inline', { ...f.rows.get('unknown-inline')!, workflowDefinitionId: null });
    const actions = createAccountWorkflowTriggerActions({ ...f.params, newId: () => 'unused',
      resolveWorkflow: async () => { throw new Error('Inline candidate reads no library'); } });
    await expect(actions.list({ managedTarget: target })).rejects.toMatchObject({ code: 'source_unavailable' });
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 1 });
    expect(f.writes).toHaveLength(0);
  });

  it.each([plain, encrypted])('backfills once through recipe CAS and does no work for 1k already indexed definitions ($witness.mode)', async mode => {
    const f = fixture(mode);
    for (let index = 0; index < 1000; index++) f.seed(`unrelated-${index}`, false, true);
    f.seed('old-managed', true);
    f.seed('old-unrelated', false, false, 'team-one');
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 2, unresolved: 0 });
    expect(f.writes).toEqual(['old-managed', 'old-unrelated']);
    expect(f.reads).toEqual(['old-managed', 'old-unrelated']);
    expect(f.rows.get('old-managed')?.managedTarget).toEqual(target);
    expect(f.rows.get('old-unrelated')?.managedTarget).toBeNull();
    f.reads.length = 0;
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 0 });
    expect(f.writes).toHaveLength(2);
    expect(f.reads).toHaveLength(0);
    expect(f.lists).toEqual([{ managedTargetUnindexed: true }, { managedTargetUnindexed: true }]);
    const recipe = f.rows.get('old-managed')!.executionRecipe!;
    if (recipe.v !== 2) throw new Error('Current recipe required');
    expect(recipe.managedTarget).toEqual(target);
    expect(Object.keys(recipe).sort()).toEqual(['managedTarget', 'templateVersion', 'triggerEvidence', 'v', 'visibleTeamId', 'workflow']);
    expect(recipe.visibleTeamId).toBeNull();
    expect(f.rows.get('old-unrelated')!.executionRecipe).toMatchObject({ v: 2, visibleTeamId: 'team-one' });
    const opened = recipe.workflow.t === 'plain' ? recipe.workflow.v : isAvailableE2eeAutomationAccountEncryptionV1(mode)
      ? openAccountScopedBlobCiphertext({ kind: 'automation_template_payload', material: mode.material.material, ciphertext: recipe.workflow.c })?.value : null;
    expect(AutomationStoredWorkflowDefinitionV2ReadSchema.parse(opened).workspace.directory).toBe('/private/repo');
  });

  it('resumes after a committed write loses its acknowledgement without writing the row again', async () => {
    const f = fixture(); f.seed('old-managed', true); f.fail('lost-receipt');
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 1 });
    f.fail(null);
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 0 });
    expect(f.writes).toEqual(['old-managed']);
  });

  it('does not hot-retry a conflicting definition or treat it as indexed', async () => {
    const f = fixture(); f.seed('old-managed', true); f.fail('conflict');
    expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 1 });
    expect(f.reads).toEqual(['old-managed']);
    expect(f.writes).toHaveLength(0);
    expect(f.rows.get('old-managed')?.managedTarget).toBeUndefined();
  });

  it('refuses to reseal opened content after Account authority changes or the client retires', async () => {
    const f = fixture(); f.seed('old-managed', true);
    let reads = 0;
    expect(await backfillAutomationManagedTargetsV1({ ...f.params,
      resolveEncryption: async () => ++reads === 1 ? plain : encrypted,
    })).toEqual({ updated: 0, unresolved: 1 });
    expect(f.writes).toHaveLength(0);
    const controller = new AbortController();
    await expect(backfillAutomationManagedTargetsV1({ ...f.params, signal: controller.signal,
      resolveEncryption: async () => { controller.abort(); return plain; },
    })).rejects.toBeDefined();
    expect(f.writes).toHaveLength(0);
  });
});
