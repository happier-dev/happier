import {
  createAccountScopedCryptoMaterialSnapshotV1,
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  serializeAutomationRunExecutionRecipeV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';

type DispatchSessionServerStart = NonNullable<
  Parameters<typeof executeClaimedRun>[0]['dispatchSessionServerStart']
>;

const PLAIN_CURRENTNESS = {
  mode: 'plain' as const,
  version: 41,
  contentKeyFingerprint: null,
};

function strictNewSessionRecipe(params: Readonly<{ templateEnvelope?: unknown }> = {}) {
  return {
    v: 1,
    templateVersion: 1,
    template: params.templateEnvelope ?? {
      t: 'plain' as const,
      v: { v: 1, prompt: 'create a private failure detail' },
    },
    triggerEvidence: null,
    target: {
      kind: 'newSession' as const,
      spawn: {
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: '/tmp/automation-failure-detail',
        agentTarget: {
          kind: 'agent' as const,
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    },
  };
}

function buildStrictClaimedRun(params: Readonly<{
  runId: string;
  accountCurrentness: unknown;
  recipe: unknown;
}>): ClaimableRunPayload {
  const serialized = serializeAutomationRunExecutionRecipeV1(params.recipe);
  if (serialized.kind !== 'available') {
    throw new Error('Strict Automation recipe fixture must serialize');
  }
  return {
    protocol: 'v3',
    run: {
      id: params.runId,
      automationId: 'automation-1',
      attempt: 1,
      executionInputEnvelope: serialized.serialized,
      triggerId: null,
      cause: { kind: 'manual', invokedAt: 1_723_247_201_000 },
    },
    automation: {
      id: 'automation-1',
      name: 'Private failure detail',
      enabled: true,
    },
    accountCurrentness: params.accountCurrentness,
  } as ClaimableRunPayload;
}

function nonretryableSessionFailure(): DispatchSessionServerStart {
  return async () => ({
    type: 'error',
    code: 'incompatible_target',
    retryable: false,
  });
}

function readFailureCall(failRun: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = failRun.mock.calls[0]?.[0];
  if (!call || typeof call !== 'object') {
    throw new Error('expected one Automation Run failure settlement');
  }
  return call as Record<string, unknown>;
}

describe('Automation Run failure detail sealing', () => {
  it('seals a plain V3 failure detail before the terminal settlement and never sends raw errorMessage', async () => {
    const failRun = vi.fn(async () => {});
    const privateDetail = 'Automation Session start failed: incompatible_target';

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient: {
        startRun: vi.fn(async () => PLAIN_CURRENTNESS),
        heartbeatRun: vi.fn(async () => {}),
        succeedRun: vi.fn(async () => {}),
        failRun,
      },
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart: nonretryableSessionFailure(),
      resolveAutomationAccountEncryption: vi.fn(async () => ({
        kind: 'available' as const,
        witness: PLAIN_CURRENTNESS,
      })),
      claimed: buildStrictClaimedRun({
        runId: 'run-plain-private-failure',
        accountCurrentness: PLAIN_CURRENTNESS,
        recipe: strictNewSessionRecipe(),
      }),
    });

    const failure = readFailureCall(failRun);
    expect(failure).toMatchObject({
      runId: 'run-plain-private-failure',
      errorCode: 'incompatible_target',
      accountCurrentness: PLAIN_CURRENTNESS,
    });
    expect(failure).not.toHaveProperty('errorMessage');
    expect(failure).toHaveProperty('errorDetailEnvelope');
    expect(JSON.parse(String(failure.errorDetailEnvelope))).toEqual({
      t: 'plain',
      v: {
        v: 1,
        correspondence: {
          automationId: 'automation-1',
          runId: 'run-plain-private-failure',
        },
        detail: privateDetail,
      },
    });
  });

  it('uses an encrypted, purpose-bound V3 failure detail for an E2EE Account', async () => {
    const accountEncryption = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(19) },
    });
    const currentness = {
      mode: 'e2ee' as const,
      version: 42,
      contentKeyFingerprint: 'content-key-42',
    };
    const failRun = vi.fn(async () => {});
    const privateDetail = 'Automation Session start failed: incompatible_target';
    const encryptedTemplate = sealAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: accountEncryption.material,
      payload: { v: 1, prompt: 'create an encrypted private failure detail' },
      randomBytes: (length) => new Uint8Array(length).fill(20),
    });

    await executeClaimedRun({
      token: 'token',
      machineId: 'machine-1',
      claimClient: {
        startRun: vi.fn(async () => currentness),
        heartbeatRun: vi.fn(async () => {}),
        succeedRun: vi.fn(async () => {}),
        failRun,
      },
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'must-not-spawn',
      })),
      heartbeatMs: 60_000,
      leaseDurationMs: 120_000,
      dispatchSessionServerStart: nonretryableSessionFailure(),
      resolveAutomationAccountEncryption: vi.fn(async () => ({
        kind: 'available' as const,
        witness: currentness,
        material: accountEncryption,
      })),
      claimed: buildStrictClaimedRun({
        runId: 'run-e2ee-private-failure',
        accountCurrentness: currentness,
        recipe: strictNewSessionRecipe({
          templateEnvelope: { t: 'encrypted', c: encryptedTemplate },
        }),
      }),
    });

    const failure = readFailureCall(failRun);
    expect(failure).not.toHaveProperty('errorMessage');
    expect(failure).toHaveProperty('errorDetailEnvelope');
    const envelope = JSON.parse(String(failure.errorDetailEnvelope));
    expect(envelope).toMatchObject({ t: 'encrypted' });
    expect(String(failure.errorDetailEnvelope)).not.toContain(privateDetail);
    expect(readAccountScopedCiphertextKindByte(envelope.c)).toBe(22);
  });
});
