import { describe, expect, it } from 'vitest';

import { resolveSshKnownHostTrust } from './sshHostTrust.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const MULTI_HOST_DIFFERENT_KEY = 'example.test,127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const MULTI_HOST_SCANNED_KEY = 'example.test,127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('resolveSshKnownHostTrust', () => {
  it('fails closed when an explicit trusted host key does not match the fresh ssh-keyscan result', () => {
    expect(resolveSshKnownHostTrust({
      knownHostsText: `${SCANNED_HOST_KEY}\n`,
      scannedHostKeyLine: SCANNED_HOST_KEY,
      trustedHostKey: DIFFERENT_HOST_KEY,
    })).toEqual({
      status: 'rejected',
      reason: 'trustedHostKeyMismatch',
      scanned: expect.objectContaining({
        host: 'example.test',
        keyType: 'ssh-ed25519',
        key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      }),
      message: expect.stringContaining('does not match'),
      trustedFingerprint: expect.stringMatching(/^SHA256:/),
    });
  });

  it('persists a matching explicit trusted host key into known_hosts state', () => {
    expect(resolveSshKnownHostTrust({
      scannedHostKeyLine: SCANNED_HOST_KEY,
      trustedHostKey: SCANNED_HOST_KEY,
    })).toEqual({
      status: 'trusted',
      scanned: expect.objectContaining({
        host: 'example.test',
        keyType: 'ssh-ed25519',
      }),
      nextKnownHostsText: SCANNED_HOST_KEY,
    });
  });

  it('treats comma-separated host lists as one entry and prompts to replace on mismatch', () => {
    expect(resolveSshKnownHostTrust({
      knownHostsText: `${MULTI_HOST_DIFFERENT_KEY}\n`,
      scannedHostKeyLine: SCANNED_HOST_KEY,
    })).toEqual({
      status: 'prompt',
      promptKind: 'ssh.replaceHostKey',
      scanned: expect.objectContaining({
        host: 'example.test',
        keyType: 'ssh-ed25519',
      }),
      existingFingerprint: expect.stringMatching(/^SHA256:/),
      nextKnownHostsText: MULTI_HOST_SCANNED_KEY,
    });
  });
});
