import { describe, expect, it } from 'vitest';

import { buildRuntimeAuthRecoveryKey } from './runtimeAuthRecoveryKey';

describe('runtimeAuthRecoveryKey', () => {
  it('builds a versioned composite in-process identity without delimiter collisions', () => {
    const key = buildRuntimeAuthRecoveryKey({
      sessionId: 'session:with/slashes',
      serviceId: 'openai-codex',
      profileId: 'profile:primary',
      groupId: null,
    });
    const collisionCandidate = buildRuntimeAuthRecoveryKey({
      sessionId: 'session',
      serviceId: 'with/slashes:openai-codex',
      profileId: 'profile:primary',
      groupId: null,
    });

    expect(key).toMatch(/^runtime-auth:v1:/);
    expect(key).not.toContain('session:with/slashes');
    expect(key).not.toBe(collisionCandidate);
  });

  it('canonicalizes group-backed keys so profile changes in the same group share one in-process identity', () => {
    const a = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: 'member-a',
    });
    const b = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: 'member-b',
    });

    expect(a).toBe(b);
  });

  it('keeps group-backed keys distinct for different failing access-token fingerprints', () => {
    const a = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: 'member-a',
      failingAccessTokenFingerprint: 'token-a',
    });
    const b = buildRuntimeAuthRecoveryKey({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: 'member-b',
      failingAccessTokenFingerprint: 'token-b',
    });

    expect(a).not.toBe(b);
  });
});
