import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as hostTrust from './hostTrust.js';

import {
  buildSshHostTrustKey,
  resolveSshHostTrust,
} from './hostTrust.js';

describe('SSH host trust protocol helpers', () => {
  it('fingerprints decoded SSH wire bytes identically for generated pins and scanned keys', () => {
    const key = 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const codec = hostTrust as unknown as { computeSshHostKeyFingerprint?: (key: string) => string };
    expect(codec.computeSshHostKeyFingerprint).toBeTypeOf('function');
    const expected = `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/u, '')}`;
    expect(codec.computeSshHostKeyFingerprint!(key)).toBe(expected);
    expect(codec.computeSshHostKeyFingerprint!(` ${key} `)).toBe(expected);
    expect(expected).not.toBe(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`);
  });
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
