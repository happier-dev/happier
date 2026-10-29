import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '../crypto/base64.js';

import {
  RunnerActivationProgressPhaseV1Schema,
} from './progress.js';
import {
  RunnerActivationProgressUpdateV1Schema,
  signRunnerActivationProgressUpdateV1,
  verifyRunnerActivationProgressUpdateV1,
} from './progressProof.js';

describe('Runner activation progress', () => {
  it('carries only the launch step the activation projection cannot express', () => {
    expect(RunnerActivationProgressPhaseV1Schema.parse('checking_ai_access')).toBe('checking_ai_access');
    // Every other phase is derived by the creator from state/review/readiness,
    // so the endpoint must not be able to report one.
    for (const derived of ['connected', 'installing_agent', 'preparing_encryption', 'creating_session']) {
      expect(RunnerActivationProgressPhaseV1Schema.safeParse(derived).success).toBe(false);
    }
  });

  it('rejects unknown phases and unknown proof fields', () => {
    expect(RunnerActivationProgressPhaseV1Schema.safeParse('preparing_session').success).toBe(false);
    const activationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
    const installationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(14));
    const update = signRunnerActivationProgressUpdateV1({
      payload: {
        v: 1,
        purpose: 'happier.ephemeral-session-runner.activation-progress',
        activationId: '00000000-0000-4000-8000-000000000013',
        sessionId: 'session-13',
        machineId: 'machine-13',
        creatorTokenEpoch: 1,
        phase: 'checking_ai_access',
      },
      activationSecretKey: activationKey.secretKey,
      installationSecretKey: installationKey.secretKey,
    });
    expect(RunnerActivationProgressUpdateV1Schema.safeParse(update).success).toBe(true);
    expect(RunnerActivationProgressUpdateV1Schema.safeParse({
      ...update,
      payload: { ...update.payload, extra: true },
    }).success).toBe(false);
  });

  it('binds the phase and current activation identity to both endpoint keys', () => {
    const activationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
    const installationKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(14));
    const payload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-session-runner.activation-progress' as const,
      activationId: '00000000-0000-4000-8000-000000000013',
      sessionId: 'session-13',
      machineId: 'machine-13',
      creatorTokenEpoch: 1,
      phase: 'checking_ai_access' as const,
    };
    const update = signRunnerActivationProgressUpdateV1({
      payload,
      activationSecretKey: activationKey.secretKey,
      installationSecretKey: installationKey.secretKey,
    });
    const verification = {
      update,
      expectedPayload: payload,
      activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
      installationPublicKey: encodeBase64(installationKey.publicKey, 'base64url'),
    };
    const verify = (expectedPayload: unknown) => verifyRunnerActivationProgressUpdateV1({
      ...verification,
      expectedPayload,
    });

    expect(verify(payload)).toEqual(update);
    expect(verify({ ...payload, phase: 'preparing_session' })).toBeNull();
    const changedIdentity = { ...payload, machineId: 'machine-other' };
    expect(RunnerActivationProgressUpdateV1Schema.safeParse({ ...update, payload: changedIdentity }).success).toBe(true);
    expect(verify(changedIdentity)).toBeNull();
    const otherKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(15));
    expect(verifyRunnerActivationProgressUpdateV1({
      ...verification,
      activationSigningPublicKey: encodeBase64(otherKey.publicKey, 'base64url'),
    })).toBeNull();
    expect(verifyRunnerActivationProgressUpdateV1({
      ...verification,
      installationPublicKey: encodeBase64(otherKey.publicKey, 'base64url'),
    })).toBeNull();
  }, 15_000);
});
