import { describe, expect, it } from 'vitest';

import {
  buildRuntimeAuthRecoveryKey,
  parseRuntimeAuthRecoveryKey,
} from './runtimeAuthRecoveryKey';

describe('runtimeAuthRecoveryKey', () => {
  it('round-trips a versioned composite recovery identity without delimiter collisions', () => {
    const parts = {
      sessionId: 'session:with/slashes',
      serviceId: 'openai-codex',
      profileId: 'profile:primary',
      groupId: null,
    };

    const key = buildRuntimeAuthRecoveryKey(parts);

    expect(key).toMatch(/^runtime-auth:v1:/);
    expect(key).not.toContain('session:with/slashes');
    expect(parseRuntimeAuthRecoveryKey(key)).toEqual(parts);
  });

  it('canonicalizes group-backed keys so profile changes in the same group share one durable key', () => {
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
    expect(parseRuntimeAuthRecoveryKey(a)).toEqual({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: null,
    });
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
    expect(parseRuntimeAuthRecoveryKey(a)).toEqual({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      groupId: 'codex-main',
      profileId: null,
      failingAccessTokenFingerprint: 'token-a',
    });
  });
});
