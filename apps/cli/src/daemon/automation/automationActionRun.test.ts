import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { executeClaimedRun } from './automationRunExecutor';
import type { AutomationV3ClaimedRunPayload } from './automationTypes';

const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
const action = { pluginId: 'com.example.jobs', localId: 'refresh' };
function claim(): Extract<AutomationV3ClaimedRunPayload, { automation: { id: string } }> {
  return { protocol: 'v3', accountCurrentness: witness, automation: { id: 'automation-1', name: 'Refresh', enabled: true },
    run: { id: 'run-1', automationId: 'automation-1', attempt: 1, revision: 1, recipeKind: 'action-v1',
      leaseExpiresAt: Date.now() + 120_000, triggerId: null, cause: { kind: 'manual', invokedAt: 100 },
      resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({
        v: 1, templateVersion: 1, assignmentMachineIds: ['machine-1'], triggerEvidence: null,
        target: { kind: 'contributedAction', action },
        template: { t: 'plain', v: { v: 1, prompt: '', actionInput: { kind: 'literal', value: { project: 'demo' } } } },
      }) } };
}

describe('claimed Automation Action execution', () => {
  it('does not report an approval request as a completed Action effect', async () => {
    const daemon = vi.fn(async () => ({ matched: true as const, result: { ok: true as const,
      result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'action.invoke' } } }));
    const succeedRun = vi.fn(async () => {});
    const failRun = vi.fn(async () => {});
    await executeClaimedRun({ machineId: 'machine-1', claimed: claim(), heartbeatMs: 60_000, leaseDurationMs: 120_000,
      actionExecutor: createPluginActionExecutor({ base: createActionExecutor({}), requestPluginActionExecution: daemon }),
      claimClient: { heartbeatRun: vi.fn(), startRun: async () => witness, succeedRun, failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness }) });
    expect(succeedRun).not.toHaveBeenCalled();
    expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'approval_required' }));
  });
  it('opens an E2EE Action template only on its assigned Machine', async () => {
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } });
    const encryptedWitness = { mode: 'e2ee' as const, version: 1,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) };
    const base = claim();
    const claimed = { ...base, accountCurrentness: encryptedWitness, run: { ...base.run,
      executionInputEnvelope: JSON.stringify({ v: 1, templateVersion: 1,
      assignmentMachineIds: ['machine-1'], triggerEvidence: null, target: { kind: 'contributedAction', action },
      template: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'automation_template_payload',
        material: material.material, payload: { v: 1, prompt: '', actionInput: { kind: 'literal', value: { private: 'input' } } },
        randomBytes: length => new Uint8Array(length).fill(3) }) } }) } };
    const daemon = vi.fn(async () => ({ matched: true as const, result: { ok: true as const, result: null } }));
    const succeedRun = vi.fn(async () => {});
    await executeClaimedRun({ machineId: 'machine-1', claimed, heartbeatMs: 60_000, leaseDurationMs: 120_000,
      actionExecutor: createPluginActionExecutor({ base: createActionExecutor({}), requestPluginActionExecution: daemon }),
      claimClient: { heartbeatRun: vi.fn(), startRun: async () => encryptedWitness, succeedRun, failRun: vi.fn() },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness: encryptedWitness, material }) });
    expect(daemon).toHaveBeenCalledWith(expect.objectContaining({ input: { action, input: { private: 'input' } } }),
      expect.anything(), expect.anything());
    expect(succeedRun).toHaveBeenCalledOnce();
    expect(claimed.run.executionInputEnvelope).not.toContain('private');
  });
  it('propagates cancellation to the admitted Action and does not settle its late result', async () => {
    const controller = new AbortController();
    let actionSignal: AbortSignal | undefined;
    const daemon = vi.fn(async (_request, options: { signal?: AbortSignal }) => {
      actionSignal = options.signal;
      controller.abort();
      return { matched: true as const, result: { ok: true as const, result: null } };
    });
    const executor = createPluginActionExecutor({ base: createActionExecutor({}), requestPluginActionExecution: daemon });
    const succeedRun = vi.fn(async () => {});
    const failRun = vi.fn(async () => {});
    await executeClaimedRun({ machineId: 'machine-1', claimed: claim(), heartbeatMs: 60_000, leaseDurationMs: 120_000,
      signal: controller.signal, actionExecutor: executor,
      claimClient: { heartbeatRun: vi.fn(), startRun: async () => witness, succeedRun, failRun },
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness }) });
    expect(actionSignal?.aborted).toBe(true);
    expect(succeedRun).not.toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
  });
  it.each([true, false])('settles the Run with the daemon Action outcome (available=%s)', async available => {
    // The daemon process transport is the boundary; Action routing and recipe materialization stay real.
    const daemon = vi.fn(async () => ({ matched: true as const, result: available
      ? { ok: true as const, result: { refreshed: true } }
      : { ok: false as const, errorCode: 'plugin_action_execution_placement_unavailable', error: 'Unavailable' } }));
    const executor = createPluginActionExecutor({ base: createActionExecutor({}), requestPluginActionExecution: daemon });
    const startRun = vi.fn(async () => witness);
    const succeedRun = vi.fn(async () => {});
    const failRun = vi.fn(async () => {});
    await executeClaimedRun({ machineId: 'machine-1', claimed: claim(), heartbeatMs: 60_000, leaseDurationMs: 120_000,
      claimClient: { heartbeatRun: vi.fn(), startRun, succeedRun, failRun }, actionExecutor: executor,
      resolveAutomationAccountEncryption: async () => ({ kind: 'available', witness }) });
    expect(daemon).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'action.invoke', input: { action, input: { project: 'demo' } } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }), expect.objectContaining({
        context: expect.objectContaining({ actionCaller: expect.objectContaining({ kind: 'automationRun', runId: 'run-1' }) }),
      }));
    expect(startRun).toHaveBeenCalledOnce();
    if (available) {
      expect(succeedRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1' }));
      expect(failRun).not.toHaveBeenCalled();
    } else {
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'plugin_action_execution_placement_unavailable' }));
      expect(succeedRun).not.toHaveBeenCalled();
    }
  });
});
