import { describe, expect, it } from 'vitest';

import {
  storedProcessIdentityProvesPidReuse,
  storedProcessIdentityMatchesCurrentIdentity,
} from './sessionRunnerProcessIdentity';

describe('session runner process identity', () => {
  it('uses the process-instance fingerprint, not command drift, as PID generation proof', () => {
    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      currentIdentity: {
        kind: 'happy',
        processCommandHash: 'b'.repeat(64),
        processInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      },
    })).toBe(false);

    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      currentIdentity: {
        kind: 'happy',
        processCommandHash: 'b'.repeat(64),
        processInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      },
    })).toBe(true);
  });

  it('proves PID reuse only when both stored and observed process instances differ', () => {
    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: 'linux-proc:100',
      currentIdentity: {
        kind: 'not_happy',
        processInstanceFingerprint: 'linux-proc:200',
      },
    })).toBe(true);

    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'not_happy', processInstanceFingerprint: 'linux-proc:200' },
    })).toBe(false);
  });

  it('keeps legacy command hashes strict for positive identity matching', () => {
    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64) },
    })).toBe(true);
    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'happy', processCommandHash: 'b'.repeat(64) },
    })).toBe(false);
  });
});
