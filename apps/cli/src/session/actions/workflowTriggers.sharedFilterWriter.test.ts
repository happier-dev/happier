import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { WorkflowDefinitionV1Schema } from '@happier-dev/protocol/workflows/workflowV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { AutomationDefinitionDetailSchema, type AutomationDefinitionCreateRequest,
  type AutomationDefinitionDetail, type AutomationDefinitionReconcileRequest } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationActionTriggerSchema, projectAutomationActionTriggerStructuralV1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { isAvailableE2eeAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('writes and re-saves a retained Workflow filter through its resource codec (%s)', async mode => {
  const machineKey = new Uint8Array(32).fill(43);
  const credentials = { token: 'author', encryption: { type: 'dataKey' as const,
    machineKey, publicKey: x25519.getPublicKey(machineKey) } };
  const resource = await createResourceDataKey({ credentials, mode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const artifactId = '11111111-1111-4111-8111-111111111111';
  // HTTP storage/key delivery is the only mocked boundary; the writer and both codecs stay real.
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
    id: artifactId, ownerAccountId: 'author', access: 'owner', publicAudience: 'none', encryptionMode: mode,
    dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: encode({ kind: 'workflow-definition.v1' }), body: encode({ body: '{}' }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
  } });
  const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => mode });
  const content = await store.readForUpdate(artifactId, { prepareRecipients: false, includeSharedAudience: false });
  if (!content) throw new Error('Missing Workflow');
  const binding = { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
  const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'action', id: 'notice',
    actionId: 'notifications.notify_me', input: { message: { kind: 'literal', value: 'Notice' } } }] });
  let written: AutomationDefinitionCreateRequest | undefined;
  let retained: AutomationDefinitionDetail | undefined;
  let reconciled: AutomationDefinitionReconcileRequest | undefined;
  const settled = new Error('captured HTTP mutation');
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected mutation'); };
  let nextId = 0;
  const params = {
    resolveEncryption: async () => mode === 'plain'
      ? { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }
      : { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1, contentKeyFingerprint: 'current' },
        material: createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: new Uint8Array(32).fill(44) } }) },
    randomBytes: (length: number) => new Uint8Array(length).fill(45), newId: () => `writer-${++nextId}`,
    resolveWorkflow: async () => ({ definition }),
    resolveWorkflowTeamIds: async () => [],
    resolveWorkflowContent: async () => ({
      revision: binding.expectedRevision,
      sealAssociatedContent: async (value: unknown) => content.sealAssociatedContent({ ...binding, value }),
      openAssociatedContent: async (envelope: Parameters<typeof content.openAssociatedContent>[0]['content']) =>
        content.openAssociatedContent({ ...binding, content: envelope }),
    }),
    automations: { list: async () => ({ automations: [], nextCursor: null }),
      listDetails: async () => ({ automations: [], nextCursor: null }), get: async () => retained ?? null,
      create: async (input: AutomationDefinitionCreateRequest): Promise<never> => { written = input; throw settled; },
      reconcile: async (_id: string, input: AutomationDefinitionReconcileRequest): Promise<never> => { reconciled = input; throw settled; },
      delete: unexpected },
  };
  const actions = createAccountWorkflowTriggerActions(params);
  const authoredTrigger = AutomationActionTriggerSchema.parse({
    kind: 'action', phase: 'after', actionIds: ['notifications.notify_me'],
    filter: { v: 1, all: [{ field: '/requestId', op: 'eq', value: 'shared-private-marker' }] },
  });
  await expect(actions.add({ workflow: artifactId,
    project: { machineId: 'machine-one', directory: '/repo' },
    trigger: { ...authoredTrigger, enabled: true },
  })).rejects.toBe(settled);
  expect(written).toBeDefined();
  const trigger = written!.triggers[0]!.trigger;
  expect(trigger).toHaveProperty('triggerDefinitionEnvelope.t', 'workflow');
  if (mode === 'e2ee') expect(JSON.stringify(written)).not.toContain('shared-private-marker');
  else expect(JSON.stringify(written)).toContain('shared-private-marker');

  if (!written || !('executionRecipe' in written)) throw new Error('Missing saved Workflow recipe');
  const { automationId, executionRecipe } = written;
  const { triggerId } = written.triggers[0]!;
  const encryption = await params.resolveEncryption();
  const oldEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
    ...(isAvailableE2eeAutomationAccountEncryptionV1(encryption)
      ? { mode: 'e2ee' as const, material: encryption.material.material, randomBytes: params.randomBytes }
      : { mode: 'plain' as const }),
    definition: authoredTrigger,
    binding: { v: 1, automationId, triggerId, triggerRevision: 0, triggerKind: 'action' },
  });
  const retainedTrigger = { ...projectAutomationActionTriggerStructuralV1(authoredTrigger), id: triggerId, revision: 0,
    enabled: true, createdAt: 1, updatedAt: 1, triggerDefinitionEnvelope: JSON.stringify(oldEnvelope) };
  retained = AutomationDefinitionDetailSchema.parse({
    id: automationId, name: written.name, description: null, enabled: true, workflowDefinitionId: artifactId,
    targetType: null, existingSessionId: null, templateVersion: 1, executionRecipe,
    lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId: 'machine-one', enabled: true, priority: 0, updatedAt: 1 }],
    triggers: [retainedTrigger],
  });
  const save = () => actions.update({ automationId, triggerId, expectedRevision: 1, patch: { trigger: authoredTrigger } });
  await expect(save()).rejects.toBe(settled);
  const update = reconciled?.triggers[0];
  expect(update).toHaveProperty('trigger.triggerDefinitionEnvelope.t', 'workflow');
  if (update?.kind !== 'existing' || !update.trigger || !('triggerDefinitionEnvelope' in update.trigger)
    || update.trigger.triggerDefinitionEnvelope.t !== 'workflow') throw new Error('Missing Workflow envelope');
  expect(content.openAssociatedContent({ ...binding, content: update.trigger.triggerDefinitionEnvelope.content }))
    .toMatchObject({ binding: { automationId, triggerId, triggerRevision: 1 }, definition: authoredTrigger });

  retained.triggers[0] = { ...retainedTrigger, revision: 1,
    triggerDefinitionEnvelope: JSON.stringify(update.trigger.triggerDefinitionEnvelope) };
  await expect(save()).rejects.toBe(settled);
  expect(reconciled?.triggers).toEqual([{ kind: 'existing', triggerId, expectedRevision: 1 }]);
});
