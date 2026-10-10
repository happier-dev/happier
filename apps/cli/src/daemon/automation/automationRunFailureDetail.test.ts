import { createAccountScopedCryptoMaterialSnapshotV1, readAccountScopedCiphertextKindByte } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { executeClaimedRun } from './automationRunExecutor';

describe('Automation Run failure detail sealing', () => {
  it.each(['plain', 'e2ee'] as const)('seals a %s Workflow admission refusal without sending raw errorMessage', async (mode) => {
    const witness = { mode, version: 41, contentKeyFingerprint: mode === 'plain' ? null : 'content-key-41' };
    const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    }) : undefined;
    const encryption = material
      ? { kind: 'available' as const, witness: { ...witness, mode: 'e2ee' as const, contentKeyFingerprint: 'content-key-41' }, material }
      : { kind: 'available' as const, witness: { ...witness, mode: 'plain' as const, contentKeyFingerprint: null } };
    // Run persistence and machine transport are external boundaries. Admission
    // and the private refusal settlement execute through their actual owners.
    const storage = vi.fn(async () => { throw new Error('unadmitted_run_must_not_write'); });
    const machineAdmissionTransport = vi.fn(async () => { throw new Error('unadmitted_run_must_not_dispatch'); });
    const coordinate = createProductionWorkflowRunCoordinator({
      token: 'token', accountId: 'account-1', machineId: 'machine-1',
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
      resolveAccountEncryption: async () => encryption,
      isAcceptedAuthorizationCurrent: async () => true,
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineAdmissionTransport,
        resolveExistingSessionConversation: async () => null,
        detachedRun: { actionExecutor: { execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) },
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) } },
      onCommittedTransition: () => {}, storage: { execute: storage, observeChanges: () => ({ async dispose() {} }) },
    });
    const failRun = vi.fn(async (_failure: Parameters<Parameters<typeof executeClaimedRun>[0]['claimClient']['failRun']>[0]) => {});
    await executeClaimedRun({
      machineId: 'machine-1', heartbeatMs: 60_000, leaseDurationMs: 120_000,
      claimClient: { heartbeatRun: async () => {}, failRun },
      coordinateWorkflowRun: coordinate, resolveAutomationAccountEncryption: async () => encryption,
      claimed: { protocol: 'v3', accountCurrentness: witness,
        automation: { id: 'automation-1', name: 'Private refusal', enabled: true },
        run: { id: 'run-private-failure', automationId: 'automation-1', revision: 0, attempt: 1,
          recipeKind: 'workflow-v2', triggerId: null, cause: { kind: 'manual', invokedAt: 1 }, causeWorkDepth: 0,
          executionInputEnvelope: JSON.stringify({ t: 'plain', v: null }), resultDelivery: { kind: 'none' } } },
    });
    const failure = failRun.mock.calls[0]?.[0];
    expect(failure).toMatchObject({ runId: 'run-private-failure', errorCode: 'source_unavailable', accountCurrentness: witness });
    expect(failure).not.toHaveProperty('errorMessage');
    const envelope = JSON.parse(String(failure?.errorDetailEnvelope));
    if (mode === 'plain') {
      expect(envelope).toEqual({ t: 'plain', v: { v: 1,
        correspondence: { automationId: 'automation-1', runId: 'run-private-failure' },
        detail: 'Workflow trigger admission refused: source_unavailable' } });
    } else {
      expect(envelope).toMatchObject({ t: 'encrypted' });
      expect(String(failure?.errorDetailEnvelope)).not.toContain('Workflow trigger admission refused');
      expect(readAccountScopedCiphertextKindByte(envelope.c)).toBe(22);
    }
    expect(storage).not.toHaveBeenCalled();
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
  });
});
