import { describe, expect, it } from 'vitest';

import {
  buildSshHostTrustKey,
  resolveSshHostTrust,
} from './hostTrust.js';

describe('SSH host trust protocol helpers', () => {
  it('normalizes host and port into stable trust keys', () => {
    expect(buildSshHostTrustKey({
      host: ' Example.TEST ',
      port: 2222,
      algorithm: ' ssh-ed25519 ',
    })).toBe('example.test:2222:ssh-ed25519');
  });

  it('trusts exact algorithm and fingerprint matches for the same endpoint', () => {
    expect(resolveSshHostTrust({
      host: 'example.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:new',
      trusted: {
        host: 'EXAMPLE.test',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: 'SHA256:new',
      },
    })).toEqual({
      status: 'trusted',
    });
  });

  it('classifies missing and changed keys using shared system-task prompt kinds', () => {
    expect(resolveSshHostTrust({
      host: 'example.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:new',
      trusted: null,
    })).toEqual({
      status: 'prompt',
      promptKind: 'ssh.trustHost',
    });

    expect(resolveSshHostTrust({
      host: 'example.test',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:new',
      trusted: {
        host: 'example.test',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprintSha256: 'SHA256:old',
      },
    })).toEqual({
      status: 'prompt',
      promptKind: 'ssh.replaceHostKey',
      existingFingerprintSha256: 'SHA256:old',
    });
  });
});
