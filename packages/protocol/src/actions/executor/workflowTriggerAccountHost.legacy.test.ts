import { describe, expect, it } from 'vitest';
import type { AutomationDefinitionDetail, AutomationDefinitionReconcileRequest } from '../../automations/automationApiV3.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import type { AvailableAutomationAccountEncryptionV1 } from '../../automations/automationAccountCurrentnessV1.js';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../../crypto/accountScopedCipher.js';
import { createAccountWorkflowTriggerActions } from './workflowTriggerAccountHost.js';
import { WorkflowTriggerListResultV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED,
  AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../automations/automationTemplateV02.testFixtures.js';

const plain: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
const encrypted: AvailableAutomationAccountEncryptionV1 = { kind: 'available', witness: { mode: 'e2ee', version: 1, contentKeyFingerprint: 'current' },
  material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }) };

function fixture(templateCiphertext: string, encryption = plain, targetType: AutomationDefinitionDetail['targetType'] = 'newSession') {
  let row: AutomationDefinitionDetail = { id: 'legacy-one', name: 'Release review', description: null, enabled: true,
    targetType, existingSessionId: null, templateVersion: 3, templateCiphertext,
    workflowDefinitionId: null, scopeSessionId: null, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-one', enabled: true, priority: 2, updatedAt: 1 }],
    triggers: [{ id: AutomationTriggerIdSchema.parse('schedule-one'), kind: 'schedule', enabled: true, revision: 2,
      schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null },
      createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null }] };
  let writes = 0;
  let written: AutomationDefinitionReconcileRequest | null = null;
  // Automation HTTP persistence is a system boundary; the real trigger/codec owners run beneath it.
  const params = { resolveEncryption: async () => encryption, randomBytes: (length: number) => new Uint8Array(length).fill(1),
    newId: () => 'unused', resolveWorkflow: async () => { throw new Error('No Artifact is read for legacy rows'); },
    automations: { get: async () => row, list: async () => ({ automations: [row], nextCursor: null }),
      create: async () => { throw new Error('No Automation is created'); }, delete: async () => {},
      reconcile: async (_id: string, input: AutomationDefinitionReconcileRequest) => {
        if (input.expectedTemplateVersion !== row.templateVersion) throw Object.assign(new Error('conflict'), { code: 'currentness_conflict' });
        writes++;
        written = input;
        const { templateCiphertext: _old, ...retained } = row;
        row = { ...(input.executionRecipe === undefined ? row : { ...retained, targetType: null, executionRecipe: input.executionRecipe }),
          templateVersion: row.templateVersion + 1, triggers: row.triggers.filter((trigger) => !input.removedTriggers.some((removed) => removed.triggerId === trigger.id)),
          enabled: input.enabled, workflowDefinitionId: input.workflowDefinitionId ?? row.workflowDefinitionId };
        return row;
      } } };
  return { params, row: () => row, writes: () => writes, written: () => written };
}

describe('0.2 Automation Account trigger host', () => {
  it('reads retained E2EE Session content on a plain Account with explicit historical custody', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      resolveRetainedSession: async (sessionId) => ({ sessionId, encryptionMode: 'e2ee' as const,
        material: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } }),
    });
    expect((await host.list({ scope: 'account_inline' })).sets[0]).toMatchObject({ health: 'available', legacy: { editable: false },
      target: { definition: { defaults: { conversation: { sessionId: 'session-old' } } } } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    expect(f.writes()).toBe(0);
  });
  it.each([AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_ENCRYPTED])('lists locked encrypted legacy rows and permits deletion without their keys', async (templateCiphertext) => {
    const f = fixture(templateCiphertext, plain, templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED ? 'existingSession' : 'newSession');
    const host = createAccountWorkflowTriggerActions(f.params);
    const set = WorkflowTriggerListResultV1Schema.parse(await host.list({ scope: 'account_inline' })).sets[0];
    expect(set).toMatchObject({ health: 'source_unavailable', legacy: { editable: false,
      lockedReason: templateCiphertext === AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED ? 'session_key_required' : 'migration_required' } });
    expect(set?.target).toBeUndefined();
    await host.remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(f.row().triggers).toEqual([]);
    expect(f.row().templateCiphertext).toBe(templateCiphertext);
  });
  it('converts existing-Session predecessor bytes using its actual Agent and placement instead of stale template settings', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      observeLegacyChannelAssociation: async () => ({ kind: 'absent' as const }),
      resolveSession: async () => ({ project: { machineId: 'machine-one', directory: '/actual-session-directory' }, nativeGoalOwner: null,
        executionSelection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'read-only' as const } }),
    });
    const result = await host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } });
    expect(result.set).toMatchObject({ revision: 4, target: { definition: { defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }, permissionMode: 'read-only',
      conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-one' },
    } } }, project: { machineId: 'machine-one', directory: '/actual-session-directory' } });
    expect(f.writes()).toBe(1);
  });
  it.each(['missing Agent', 'mismatched Machine'])('refuses existing-Session conversion with %s', async (unproven) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      observeLegacyChannelAssociation: async () => ({ kind: 'absent' as const }),
      resolveSession: async () => ({ project: { machineId: unproven === 'mismatched Machine' ? 'another-machine' : 'machine-one', directory: '/repo' }, nativeGoalOwner: null,
        ...(unproven === 'missing Agent' ? {} : { executionSelection: {
          agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        } }) }),
    });
    await expect(host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'legacy_conversion_unsupported', details: { reason: 'conversation_unrepresentable' } });
    expect(f.writes()).toBe(0);
  });
  it.each([{ machines: [] }, { machines: ['machine-one', 'machine-two'] }])('reads every retained placement without assigning a canonical project: $machines', async ({ machines }) => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    f.row().assignments = machines.map((machineId) => ({ machineId, enabled: true, priority: 0, updatedAt: 1 }));
    const result = WorkflowTriggerListResultV1Schema.parse(await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' }));
    expect(result.sets[0]).toMatchObject({ health: 'available', legacy: {
      placements: machines.map((machineId) => ({ machineId, directory: '/repo' })),
    }, target: { definition: { blocks: [{ document: { text: 'Review the release' } }] } },
    triggers: [{ nextRunAt: 2 }] });
    expect(result.sets[0]?.project).toBeUndefined();
    expect(f.writes()).toBe(0);
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
  });
  it('reads encrypted placement content without advertising disabled assignments or changing its envelope', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted);
    f.row().assignments.push({ machineId: 'machine-two', enabled: false, priority: 0, updatedAt: 1 });
    const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
    expect(sets[0]).toMatchObject({ health: 'available', legacy: { placements: [
      { machineId: 'machine-one', directory: '/repo' },
    ] }, target: { definition: { blocks: [{ document: { text: 'Review the release' } }] } } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_ENCRYPTED);
    expect(f.row().assignments).toHaveLength(2);
    expect(f.writes()).toBe(0);
  });
  it('resolves the exact Session machine rather than selecting a multi-placement assignment', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    f.row().assignments.push({ machineId: 'machine-two', enabled: true, priority: 0, updatedAt: 1 });
    const { sets } = await createAccountWorkflowTriggerActions({ ...f.params,
      resolveSession: async (sessionId) => {
        expect(sessionId).toBe('session-old');
        return { project: { machineId: 'actual-session-machine', directory: '/repo' }, nativeGoalOwner: null };
      },
    }).list({ scope: 'account_inline' });
    expect(sets[0]?.target).toMatchObject({ definition: { defaults: {
      conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'actual-session-machine' },
    } } });
    expect(sets[0]?.project).toBeUndefined();
    expect(f.writes()).toBe(0);
  });
  it('removes the legacy trigger without conversion, preserving assignments and omitting an execution rewrite', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    await createAccountWorkflowTriggerActions(f.params).remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(f.written()).toMatchObject({ assignments: [{ machineId: 'machine-one', enabled: true, priority: 2 }],
      triggers: [], removedTriggers: [{ triggerId: 'schedule-one', expectedRevision: 2 }] });
    expect(f.written()?.executionRecipe).toBeUndefined();
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
    expect(f.row().triggers).toEqual([]);
  });
  it('retains a legacy row and permits removal when its existing Session is unavailable', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain, 'existingSession');
    f.row().assignments = [];
    const host = createAccountWorkflowTriggerActions({ ...f.params, resolveSession: async () => {
      throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
    } });
    const { sets } = await host.list({ scope: 'account_inline' });
    expect(sets[0]).toMatchObject({ health: 'source_unavailable', legacy: { reason: 'created_in_0_2' } });
    const removed = await host.remove({ automationId: 'legacy-one', triggerId: AutomationTriggerIdSchema.parse('schedule-one') });
    expect(removed.set).toMatchObject({ health: 'source_unavailable', triggers: [] });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN);
  });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted]] as const)
    ('projects predecessor bytes with prompt, placement, schedule and a distinct legacy state', async (bytes, encryption) => {
      const f = fixture(bytes, encryption);
      const result = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      const set = WorkflowTriggerListResultV1Schema.parse(result).sets[0];
      expect(set).toMatchObject({ health: 'available', legacy: { editable: false, reason: 'created_in_0_2' },
        project: { machineId: 'machine-one', directory: '/repo' }, target: { kind: 'inline', definition: {
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
          blocks: [{ document: { text: 'Review the release' } }] } }, triggers: [{ nextRunAt: 2, schedule: { everyMs: 60_000 } }] });
      expect(f.row().templateCiphertext).toBe(bytes);
      expect(f.writes()).toBe(0);
    });
  it.each([[AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, encrypted]] as const)
    ('retains the exact existing Session target', async (bytes, encryption) => {
      const f = fixture(bytes, encryption, 'existingSession');
      const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      expect(sets[0]?.target).toMatchObject({ definition: { defaults: {
        conversation: { kind: 'existing_session', sessionId: 'session-old', machineId: 'machine-one' } } } });
    });
  it('refuses conversion without an authoritative Channels witness and retains predecessor bytes', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_PLAIN);
    await expect(createAccountWorkflowTriggerActions(f.params).update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'legacy_conversion_unsupported', details: { reason: 'channel_association_unknown' } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_PLAIN);
    expect(f.writes()).toBe(0);
  });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, plain], [AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted],
    [AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED, encrypted]] as const)
    ('converts a representable 0.2 row through one Automation CAS after the Channels boundary proves absence', async (bytes, encryption) => {
    const f = fixture(bytes, encryption);
    const host = createAccountWorkflowTriggerActions({ ...f.params,
      observeLegacyChannelAssociation: async () => ({ kind: 'absent' as const }) });
    const result = await host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } });
    expect(result.set).toMatchObject({ revision: 4, enabled: false, health: 'available',
      target: { kind: 'inline', definition: { blocks: [{ document: { text: 'Review the release' } }] } } });
    expect(result.set.legacy).toBeUndefined();
    expect(result.set.triggers).toEqual(f.row().triggers);
    expect(f.row().assignments).toEqual([{ machineId: 'machine-one', enabled: true, priority: 2, updatedAt: 1 }]);
    expect(f.row().templateCiphertext).toBeUndefined();
    expect(f.row().workflowDefinitionId).toBeNull();
    expect(f.writes()).toBe(1);
    expect(f.written()).toMatchObject({ expectedTemplateVersion: 3, workflowDefinitionId: null,
      assignments: [{ machineId: 'machine-one', enabled: true, priority: 2 }],
      triggers: [{ kind: 'existing', triggerId: 'schedule-one', expectedRevision: 2 }], removedTriggers: [] });
    await expect(host.update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: true } }))
      .rejects.toMatchObject({ code: 'currentness_conflict' });
    expect(f.writes()).toBe(1);
  });
  it('refuses bound rows through the real converter while preserving their execution bytes', async () => {
    const f = fixture(AUTOMATION_TEMPLATE_V02_ENCRYPTED, encrypted);
    await expect(createAccountWorkflowTriggerActions({ ...f.params,
      observeLegacyChannelAssociation: async () => ({ kind: 'bound' as const }) })
      .update({ automationId: 'legacy-one', expectedRevision: 3, patch: { enabled: false } }))
      .rejects.toMatchObject({ code: 'legacy_conversion_unsupported', details: { reason: 'channel_reply_handoff' } });
    expect(f.row().templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_ENCRYPTED);
    expect(f.writes()).toBe(0);
  });
  it.each([[AUTOMATION_TEMPLATE_V02_PLAIN, encrypted]] as const)
    ('fails mode mismatch closed before disclosure or mutation', async (bytes, encryption) => {
      const f = fixture(bytes, encryption);
      const { sets } = await createAccountWorkflowTriggerActions(f.params).list({ scope: 'account_inline' });
      expect(sets[0]).toMatchObject({ health: 'source_unavailable', legacy: { lockedReason: 'migration_required' } });
      expect(sets[0]?.target).toBeUndefined();
      expect(sets[0]?.context).toBeUndefined();
      expect(f.writes()).toBe(0);
    });
});
