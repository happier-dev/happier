import { describe, expect, it } from 'vitest';
import { AccountEncryptionMigrateAutomationsDirectiveSchema } from './encryptionMigrate.js';
import { randomBytes } from 'node:crypto';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '../crypto/accountScopedCipher.js';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from './encryptionKeyFingerprintV1.js';
import { convertWorkflowRunAccountEncryptionV1 } from '../workflows/workflowRunAccountEncryptionV1.js';
import { resolveWorkflowRunDataKeyV1 } from '../workflows/workflowRunDataKeyV1.js';
import { materializeWorkflowAcceptedSnapshotV1 } from '../workflows/materializeWorkflowAcceptedSnapshotV1.js';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, sealWorkflowFinalResultStoredEnvelopeV1,
  openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowCheckpointStoredEnvelopeV1,
  openWorkflowProgressStoredEnvelopeV1, openWorkflowFinalResultStoredEnvelopeV1,
  parseWorkflowStoredContentEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '../workflows/workflowStoredContentV1.js';
import type { AccountEncryptionMigrateAutomationsInventoryResponse } from './encryptionMigrate.js';

describe('active Account transition Workflow participant', () => {
  it('carries one current-run key transition with exact invocation currentness', () => {
    const workflow = {
      sourceAcceptedSnapshotEnvelope: 'source-snapshot', acceptedSnapshotEnvelope: 'target-snapshot',
      sourceCheckpointEnvelope: null, checkpointEnvelope: null, expectedDataEncryptionKey: null,
      recipientKeyEnvelopes: [], invocations: [{ id: '22222222-2222-4222-8222-222222222222',
        expectedContentRevision: '3', sourceContentEnvelope: 'source-row', contentEnvelope: 'target-row' }],
    };
    const request = { action: 'migrate', templates: [], runs: [{ runId: '11111111-1111-4111-8111-111111111111',
      expectedRunRevision: 4, triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null,
      executionInputEnvelope: null, resultEnvelope: null, replyContextEnvelope: null, failureDetailEnvelope: null,
      workflow }] };
    expect(AccountEncryptionMigrateAutomationsDirectiveSchema.safeParse(request).success).toBe(true);
    expect(AccountEncryptionMigrateAutomationsDirectiveSchema.safeParse({ ...request, runs: [{ ...request.runs[0],
      workflow: { ...workflow, runDataKey: new Uint8Array(32) } }] }).success).toBe(false);
    expect(AccountEncryptionMigrateAutomationsDirectiveSchema.safeParse({ ...request, runs: [{ ...request.runs[0],
      workflow: { ...workflow, invocations: [{ ...workflow.invocations[0], expectedContentRevision: undefined }] } }] }).success).toBe(false);
  });

  it('reseals all four current purposes with one transferable Run key and returns to keyless plain', async () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const id = '22222222-2222-4222-8222-222222222222';
    const accountId = 'owner';
    const binding = { v: 1 as const, accountId, runId };
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1,
      defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } }, blocks: ['Work'] },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
        authorization: { principal: { kind: 'host' } } },
    });
    if (!materialized.ok) throw new Error(materialized.error.code);
    const plain = { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } };
    const index = { id, runId, sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0', contentRevision: '3',
      lifecycle: 'completed' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const rowBinding = { ...binding, purpose: 'invocation_progress' as const, recordId: id,
      sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' };
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: id,
      nextSequence: '1', frontier: { nextBlockOrdinal: 1, paused: false } };
    const run: AccountEncryptionMigrateAutomationsInventoryResponse['runs'][number] = {
      runId, expectedRunRevision: 4, automationId: null, occurrenceKey: null, triggerId: null, summaryCiphertext: null,
      triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null, executionInputEnvelope: null,
      replyContextEnvelope: null, failureDetailEnvelope: null,
      resultEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowFinalResultStoredEnvelopeV1({ mode: 'plain',
        binding: { ...binding, purpose: 'final_result' }, finalResult: { kind: 'happier.workflow-final-result.v1',
          result: { kind: 'text', value: 'Kept answer' }, producerInvocation: { recordId: id } } })),
      workflow: { acceptedSnapshotEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { ...binding, purpose: 'accepted_snapshot' }, acceptedSnapshot: materialized.snapshot })),
        checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
          binding: { ...binding, purpose: 'checkpoint' }, checkpoint })),
        keyCensus: { runId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', visibleTeamId: null,
          ownerAccountCurrentness: plain.witness, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] },
        invocations: [{ index, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
          mode: 'plain', binding: rowBinding, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root',
            invocationPath: { blockId: '$root', scope: [] }, attempt: '0', logicalInvocationRecordId: id, result: 'Kept answer' } })) }] },
    };
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: randomBytes(32) } });
    const target = { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 2,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) }, material };
    const encrypted = convertWorkflowRunAccountEncryptionV1({ accountId, run, sourceEncryption: plain, targetEncryption: target, randomBytes });
    const envelope = encrypted.workflow.recipientKeyEnvelopes[0].encryptedDataKey;
    const census = { ...run.workflow!.keyCensus, encryptionMode: 'e2ee' as const, ownerAccountCurrentness: target.witness,
      dataEncryptionKey: envelope, callerDataEncryptionKey: envelope };
    const resolved = resolveWorkflowRunDataKeyV1({ encryption: target, census });
    if (resolved.kind !== 'available') throw new Error('target_key_unavailable');
    const crypto = resolved.encryption.runCrypto;
    expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...crypto, binding: { ...binding, purpose: 'accepted_snapshot' },
      envelope: parseWorkflowStoredContentEnvelopeV1(encrypted.workflow.acceptedSnapshotEnvelope) }))
      .toEqual({ kind: 'available', content: materialized.snapshot });
    expect(openWorkflowCheckpointStoredEnvelopeV1({ ...crypto, binding: { ...binding, purpose: 'checkpoint' },
      envelope: parseWorkflowStoredContentEnvelopeV1(encrypted.workflow.checkpointEnvelope) }))
      .toEqual({ kind: 'available', content: checkpoint });
    const progress = openWorkflowProgressStoredEnvelopeV1({ ...crypto, binding: rowBinding,
      envelope: parseWorkflowStoredContentEnvelopeV1(encrypted.workflow.invocations[0].contentEnvelope) });
    expect(progress.kind === 'available' && progress.content.result).toBe('Kept answer');
    const finalResult = openWorkflowFinalResultStoredEnvelopeV1({ ...crypto, binding: { ...binding, purpose: 'final_result' },
      envelope: parseWorkflowStoredContentEnvelopeV1(encrypted.resultEnvelope) });
    expect(finalResult.kind === 'available' && finalResult.content.result.value).toBe('Kept answer');
    const decrypted = convertWorkflowRunAccountEncryptionV1({ accountId, sourceEncryption: target, targetEncryption: plain,
      run: { ...run, resultEnvelope: encrypted.resultEnvelope, workflow: { ...run.workflow!, keyCensus: census,
        acceptedSnapshotEnvelope: encrypted.workflow.acceptedSnapshotEnvelope, checkpointEnvelope: encrypted.workflow.checkpointEnvelope,
        invocations: [{ index, contentEnvelope: encrypted.workflow.invocations[0].contentEnvelope }] } },
      randomBytes: () => { throw new Error('Plain target must not generate keys'); },
    });
    expect(decrypted.workflow.recipientKeyEnvelopes).toEqual([]);
    expect(JSON.parse(decrypted.resultEnvelope!).t).toBe('plain');
    expect(JSON.parse(decrypted.resultEnvelope!).v.content.result.value).toBe('Kept answer');
  });
});
