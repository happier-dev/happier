import { describe, expect, it } from 'vitest';

import {
  buildSshCommand,
  redactRemoteBootstrapPayload,
  SshKnownHostsStore,
} from './sshTransport';

describe('buildSshCommand', () => {
  it('builds strict ssh invocations with an isolated known_hosts file and selected identity', () => {
    expect(buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@example.test',
      remoteCommand: ['bash', '-lc', 'echo ok'],
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      auth: { mode: 'agent' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    })).toEqual({
      command: 'ssh',
      args: [
        '-F', '/tmp/lima-ssh.config',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=/tmp/happier-known-hosts',
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=20',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'LogLevel=ERROR',
        'dev@example.test',
        'bash',
        '-lc',
        'echo ok',
      ],
      redactedLabel: 'ssh dev@example.test bash -lc …',
    });

    expect(buildSshCommand({
      sshBin: 'ssh',
      target: 'dev@example.test',
      remoteCommand: ['uname', '-s'],
      sshConfigFile: '/tmp/lima-ssh.config',
      knownHostsPath: '/tmp/happier-known-hosts',
      auth: { mode: 'keyFile', privateKeyPath: '/Users/alex/.ssh/id_ed25519' },
      connectTimeoutSec: 15,
      serverAliveIntervalSec: 20,
      serverAliveCountMax: 2,
    }).args).toContain('/Users/alex/.ssh/id_ed25519');
  });
});

describe('redactRemoteBootstrapPayload', () => {
  it('removes auth secrets and state file paths before any prompt/event payload is surfaced', () => {
    expect(redactRemoteBootstrapPayload({
      publicKey: 'pub-key',
      claimSecret: 'top-secret',
      stateFile: '/tmp/happier/state.json',
      webappUrl: 'https://relay.example.test',
      supportsV2: true,
    })).toEqual({
      publicKey: 'pub-key',
      webappUrl: 'https://relay.example.test',
      supportsV2: true,
    });
  });
});

describe('SshKnownHostsStore', () => {
  it('records trusted keys, detects mismatches, and forgets hosts deterministically', () => {
    const store = new SshKnownHostsStore({
      initialText: '',
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    })).toEqual({
      status: 'added',
      fingerprint: expect.stringMatching(/^SHA256:/),
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    })).toEqual({
      status: 'unchanged',
      fingerprint: expect.stringMatching(/^SHA256:/),
    });

    expect(store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    })).toEqual({
      status: 'mismatch',
      fingerprint: expect.stringMatching(/^SHA256:/),
      existingFingerprint: expect.stringMatching(/^SHA256:/),
    });

    store.forget('example.test');
    expect(store.toString()).toBe('');
  });
});
