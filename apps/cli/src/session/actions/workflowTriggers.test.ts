import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema, createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  type AutomationDefinitionDetail, type AutomationDefinitionCreateRequest, type AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';

const network = vi.hoisted(() => ({ currentness: vi.fn(), session: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), reconcile: vi.fn(), remove: vi.fn() }));
// These are network transport adapters; Workflow semantics and the Account codec remain real.
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: network.currentness }));
vi.mock('@/api/automations', () => ({ listAutomationDefinitions: network.list, getAutomationDefinition: network.get,
  createAutomationDefinition: network.create, reconcileAutomationDefinition: network.reconcile, deleteAutomationDefinition: network.remove }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: network.session }));

const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'prompt', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});
const trigger = { kind: 'schedule' as const, enabled: true,
  schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };

describe('CLI workflow trigger Account codec', () => {
  let stored: AutomationDefinitionDetail;
  beforeEach(() => {
    for (const adapter of Object.values(network)) adapter.mockReset();
    network.create.mockImplementation(async ({ input }: { input: AutomationDefinitionCreateRequest }) => {
      stored = { id: input.automationId, name: input.name, description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
      executionRecipe: input.executionRecipe, assignments: (input.assignments ?? []).map((assignment) => ({ ...assignment,
        enabled: assignment.enabled ?? true, priority: assignment.priority ?? 0, updatedAt: 1 })),
      triggers: [] };
      network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
      return stored;
    });
    network.get.mockImplementation(async () => stored);
    network.list.mockResolvedValue({ automations: [], nextCursor: null });
  });
  it('pauses retained encrypted rows before disclosure and requires explicit device Save for a plain Workflow', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    stored = { id: 'automation-old', name: 'Old', description: null, enabled: true, targetType: 'existingSession',
      existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
    network.session.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null });
    network.reconcile.mockImplementation(async ({ input }: { input: AutomationDefinitionReconcileRequest }) => {
      stored = { ...stored, templateVersion: stored.templateVersion + 1, enabled: input.enabled,
        ...(input.executionRecipe === undefined ? {} : { targetType: null, templateCiphertext: undefined,
          executionRecipe: input.executionRecipe }) };
      return stored;
    });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
      resolveWorkflow: async () => definition,
      resolveSession: async () => ({ project: { machineId: 'machine', directory: '/repo' }, nativeGoalOwner: false,
        executionSelection: { agentTarget: definition.defaults!.agentTarget! } }) });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ enabled: false, health: 'source_unavailable',
      legacy: { lockedReason: 'review_required' } });
    expect(stored.executionRecipe).toBeUndefined();
    expect(network.session).not.toHaveBeenCalled();
    expect(stored.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    const caller = { surface: 'cli' as const, authority: 'present_user' as const };
    const reviewed = (await actions.list({ review: true, automationId: stored.id }, caller)).sets[0]!;
    expect(reviewed).toMatchObject({ health: 'available', legacy: { lockedReason: 'review_required' },
      target: { definition: { defaults: { conversation: { sessionId: 'session-old' } } } } });
    expect(stored.executionRecipe).toBeUndefined();
    const keyless = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => definition });
    await expect(keyless.list({ review: true, automationId: stored.id }, caller))
      .rejects.toMatchObject({ code: 'session_key_required' });
    if (!reviewed.target || !reviewed.project) throw new Error('review_did_not_open_source');
    await actions.update({ automationId: stored.id, expectedRevision: reviewed.revision, confirmLegacyConversion: true,
      patch: { target: reviewed.target, project: reviewed.project, enabled: true } }, caller);
    expect(stored).toMatchObject({ id: 'automation-old', enabled: true, executionRecipe: { v: 2, workflow: { t: 'plain' } } });
    expect(stored.templateCiphertext).toBeUndefined();
  });
  it('converts predecessor rows in place without changing their Channels association identity', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    stored = { id: 'automation-old', name: 'Old', description: null, enabled: true,
      targetType: 'newSession', existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
    network.reconcile.mockImplementation(async ({ input }: { input: AutomationDefinitionReconcileRequest }) => {
      stored = { ...stored, templateVersion: 2, templateCiphertext: undefined, executionRecipe: input.executionRecipe, enabled: input.enabled };
      return stored;
    });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => definition });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ automationId: 'automation-old',
      revision: 2, health: 'available', context: { workspace: { directory: '/repo' } } });
    expect(stored.id).toBe('automation-old');
    expect(stored.executionRecipe).toMatchObject({ v: 2 });
  });
  it('writes a keyless plain Account inline payload through the Automation owner', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => definition });
    const written = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger });
    expect(written.set.health).toBe('available');
    expect(written.set.context).toMatchObject({ inlineDefinition: definition, executionTarget: { kind: 'session' } });
    expect(network.create.mock.calls[0]?.[0].input.executionRecipe.workflow).toMatchObject({ t: 'plain', v: { workspace: { directory: '/work' } } });
  });
  it('opens real E2EE context only while the Account mode and key witness match', async () => {
    const secret = new Uint8Array(32).fill(7);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    network.currentness.mockResolvedValue({ mode: 'e2ee', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint), updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: { type: 'legacy', secret } },
      resolveWorkflow: async () => definition });
    const written = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger });
    expect(stored.executionRecipe?.v === 2 && stored.executionRecipe.workflow.t).toBe('encrypted');
    expect(written.set.context?.inlineDefinition).toEqual(definition);
    network.currentness.mockResolvedValue({ mode: 'plain', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 });
    await expect(actions.list({ scope: 'account_inline' })).rejects.toMatchObject({ code: 'content_unavailable' });
  });
  it.each(['plain', 'e2ee'] as const)('validates the saved Workflow audience before encoding the %s trigger context', async (mode) => {
    const secret = new Uint8Array(32).fill(7);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    network.currentness.mockResolvedValue({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: mode === 'plain' ? null
        : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint), updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret } },
      resolveWorkflow: async () => definition, resolveWorkflowTeamIds: async () => ['team-one', 'team-two'] });
    const input = { workflow: '11111111-1111-4111-8111-111111111111', project: { machineId: 'machine', directory: '/work' }, trigger };
    await expect(actions.add(input)).rejects.toMatchObject({ code: 'visible_team_not_granted' });
    expect(network.create).not.toHaveBeenCalled();
    const written = await actions.add({ ...input, visibleTeamId: 'team-two' });
    expect(written.set.context?.visibleTeamId).toBe('team-two');
    expect(stored.executionRecipe).toMatchObject({ v: 2, workflow: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
  });
  it('keeps scoped trigger writes in the authorized Session and the keyless Account codec', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => definition,
      resolveSession: async () => ({ project: { machineId: 'session-machine', directory: '/session-work' }, nativeGoalOwner: false }) });
    const written = await actions.sessionAdd({ sessionId: 'session-one', target: { kind: 'inline', definition }, trigger,
      onComplete: { kind: 'originating_session' } });
    expect(written.set.health).toBe('available');
    expect(stored).toMatchObject({ scopeSessionId: 'session-one', assignments: [{ machineId: 'session-machine' }], executionRecipe: {
      v: 2, workflow: { t: 'plain', v: { workspace: { directory: '/session-work' }, onComplete: { kind: 'originating_session' } } },
    } });
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([]);
    expect((await actions.sessionList({ sessionId: 'session-one' })).sets).toHaveLength(1);
  });
});
