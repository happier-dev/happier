import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { persistSshKnownHostTrust, resolveSshKnownHostTrust } from './sshHostTrust.js';

const SCANNED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const DIFFERENT_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const MULTI_HOST_DIFFERENT_KEY = 'example.test,127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const MULTI_HOST_SCANNED_KEY = 'example.test,127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('persistSshKnownHostTrust', () => {
  it('makes overlapping approvals of the same key idempotent and preserves CRLF in a nested path with spaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-trust-commit-'));
    const path = join(root, 'Home with spaces', 'ssh', 'known_hosts');
    const original = '# retained annotation\r\nother.test ssh-ed25519 AAAAOTHER annotation\r\n';
    const first = resolveSshKnownHostTrust({ knownHostsText: original, scannedHostKeyLine: SCANNED_HOST_KEY });
    const second = resolveSshKnownHostTrust({ knownHostsText: original, scannedHostKeyLine: SCANNED_HOST_KEY });
    if (first.status !== 'prompt' || second.status !== 'prompt') throw new Error('Expected first-use approval');
    try {
      mkdirSync(join(root, 'Home with spaces', 'ssh'), { recursive: true });
      writeFileSync(path, original);
      persistSshKnownHostTrust({ knownHostsPath: path, trust: first });
      persistSshKnownHostTrust({ knownHostsPath: path, trust: second });
      expect(readFileSync(path, 'utf8')).toBe(`${original}${SCANNED_HOST_KEY}\r\n`);
      expect(readdirSync(join(root, 'Home with spaces', 'ssh'))).toEqual(['known_hosts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the second conflicting approval for the same host without replacing the first approved key', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-trust-commit-'));
    const path = join(root, 'known_hosts');
    const first = resolveSshKnownHostTrust({ scannedHostKeyLine: SCANNED_HOST_KEY });
    const second = resolveSshKnownHostTrust({ scannedHostKeyLine: DIFFERENT_HOST_KEY });
    if (first.status !== 'prompt' || second.status !== 'prompt') throw new Error('Expected first-use approval');
    try {
      persistSshKnownHostTrust({ knownHostsPath: path, trust: first });
      expect(() => persistSshKnownHostTrust({ knownHostsPath: path, trust: second }))
        .toThrow(expect.objectContaining({ code: 'trusted_host_key_mismatch' }));
      expect(readFileSync(path, 'utf8')).toBe(`${SCANNED_HOST_KEY}\n`);
      expect(readdirSync(root)).toEqual(['known_hosts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveSshKnownHostTrust', () => {
  it('preserves unrelated raw comments, hashed hosts, authority markers and CRLF when adding trust', () => {
    const original = [
      '# retained annotation',
      '|1|hashed-salt|hashed-host ssh-ed25519 AAAAHASHED annotation',
      '@cert-authority *.other.test ssh-ed25519 AAAAAUTHORITY annotation',
      'other.test ssh-rsa AAAAOTHER annotation',
      '',
    ].join('\r\n');
    const result = resolveSshKnownHostTrust({ knownHostsText: original, scannedHostKeyLine: SCANNED_HOST_KEY });
    expect(result).toMatchObject({ status: 'prompt', promptKind: 'ssh.trustHost' });
    if (result.status !== 'prompt') throw new Error('Expected first-use approval');
    expect(result.nextKnownHostsText).toBe(`${original}${SCANNED_HOST_KEY}`);
  });

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
