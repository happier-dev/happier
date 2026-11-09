import { describe, expect, it } from 'vitest';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, sealWorkflowFinalResultStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
  AutomationPluginEventOccurrenceEvidenceV1Schema,
  deriveAutomationOccurrenceKeyV1} from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationStoredContentEnvelopeV1Schema} from '@happier-dev/protocol/automations/automationStoredContentEnvelopeV1';
import { deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1} from '@happier-dev/protocol/automations/automationEventTriggerEvidence';
import {
  openAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { Encryption } from '@/sync/encryption/encryption';
import { buildAccountEncryptionMigrationStorageDirectives } from './buildAccountEncryptionMigrationStorageDirectives';

describe('active Account migration Workflow client', () => {
  it('prepares owner key envelopes and reseals current Workflow content in the signed V4 directive', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const accountId = 'account-a';
    const automationId = '33333333-3333-4333-8333-333333333333';
    const triggerId = 'trigger-a';
    const evidence = AutomationPluginEventOccurrenceEvidenceV1Schema.parse({
      v: 1, kind: 'pluginEvent',
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      sourceSelectorId: '44444444-4444-4444-8444-444444444444',
      occurrenceId: 'delivery-a', occurredAt: 1, payload: { action: 'opened' },
    });
    const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId, evidence });
    const targetMaterial = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
    const invocationId = '22222222-2222-4222-8222-222222222222';
    const index = { id: invocationId, runId, sequence: '0', parentRecordId: null,
      memberOrdinal: '0', attempt: '0', contentRevision: '3', lifecycle: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as const;
    const materialized = await materializeWorkflowAcceptedSnapshotV1({
      definition: { version: 1, defaults: { agentTarget: { kind: 'agent',
        identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['Private task'] },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      context: {
      inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
      source: { kind: 'automation', automationId }, authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', runId, accountId },
      acceptedSnapshot: materialized.snapshot,
    }));
    const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'checkpoint', accountId, runId },
      checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: invocationId,
        nextSequence: '1', frontier: { nextBlockOrdinal: 1, paused: false } },
    }));
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', invocationPath: { blockId: '$root', scope: [] },
        attempt: '0', logicalInvocationRecordId: invocationId, result: 'Private answer' },
    }));
    const resultEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'final_result', accountId, runId },
      finalResult: { kind: 'happier.workflow-final-result.v1', result: { kind: 'text', value: 'Private answer' },
        producerInvocation: { recordId: invocationId } },
    }));
    const params = { fromMode: 'plain' as const, toMode: 'e2ee' as const,
      sourceEncryption: null, targetEncryption: await Encryption.create(new Uint8Array(32).fill(7)),
      machines: [], todos: [], artifacts: [], sessions: [], reviewCommentsInventory: { v: 1 as const, items: [] },
      sessionOrganizationInventory: { version: 0, folders: [], tags: [], labels: [] },
      sessionSourceCredentials: { token: 'token' },
      sessionTargetCredentials: { token: 'token', secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64url') },
      scope: { scope: { serverId: 'home', accountId }, isCurrent: () => true },
      automationsInventory: { templates: [], runs: [{ runId, expectedRunRevision: 4,
        triggerEvidenceEnvelope: JSON.stringify({ t: 'plain', v: evidence }),
        occurrenceEvidenceEqualityTag: null, executionInputEnvelope: null,
        resultEnvelope, replyContextEnvelope: null, failureDetailEnvelope: null,
        automationId, occurrenceKey, triggerId, summaryCiphertext: null,
        workflow: { acceptedSnapshotEnvelope: acceptedEnvelope, checkpointEnvelope,
          invocations: [{ index, contentEnvelope }],
          keyCensus: { runId, ownerAccountId: accountId, access: 'owner' as const, visibleTeamId: null, encryptionMode: 'plain' as const,
            ownerAccountCurrentness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null },
            dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] } } }] },
    };
    const directive = await buildAccountEncryptionMigrationStorageDirectives(params);
    expect(directive).toHaveProperty('automations.runs.0.workflow.recipientKeyEnvelopes', [expect.objectContaining({ recipientAccountId: accountId })]);
    expect(directive).toHaveProperty('automations.runs.0.workflow.expectedDataEncryptionKey', null);
    expect(directive).toHaveProperty('automations.runs.0.workflow.sourceAcceptedSnapshotEnvelope', acceptedEnvelope);
    expect(directive).toHaveProperty('automations.runs.0.workflow.invocations.0.expectedContentRevision', '3');
    if (directive.automations?.action !== 'migrate') throw new Error('Missing migration directive');
    const target = directive.automations.runs?.[0];
    expect(target?.occurrenceEvidenceEqualityTag).toBe(deriveAutomationOccurrenceTriggerEvidenceEqualityTagV1({
      material: targetMaterial, accountId, automationId, triggerId, evidence,
    }));
    const convertedEvidence = AutomationStoredContentEnvelopeV1Schema.parse(JSON.parse(target!.triggerEvidenceEnvelope!));
    if (convertedEvidence.t !== 'encrypted') throw new Error('Missing encrypted occurrence evidence');
    expect(openAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence', material: targetMaterial, ciphertext: convertedEvidence.c,
    })?.value).toEqual(evidence);
    const targetBytes = JSON.stringify({ accepted: target?.workflow?.acceptedSnapshotEnvelope,
      checkpoint: target?.workflow?.checkpointEnvelope, result: target?.resultEnvelope,
      invocations: target?.workflow?.invocations.map(row => row.contentEnvelope) });
    expect(targetBytes).not.toContain('Private task');
    expect(targetBytes).not.toContain('Private answer');
    const mismatchedOccurrenceKey = deriveAutomationOccurrenceKeyV1({
      triggerId, evidence: { ...evidence, occurrenceId: 'another-delivery' },
    });
    await expect(buildAccountEncryptionMigrationStorageDirectives({
      ...params,
      automationsInventory: {
        ...params.automationsInventory,
        runs: [{ ...params.automationsInventory.runs[0]!, occurrenceKey: mismatchedOccurrenceKey }],
      },
    })).rejects.toBeInstanceOf(TypeError);
  });
});
