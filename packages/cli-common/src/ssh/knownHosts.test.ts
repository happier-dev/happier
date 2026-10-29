import { describe, expect, it } from 'vitest';

import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeKnownHostsTextSync, writeKnownHostsTextSyncWithFs } from './knownHosts.js';
import { SshKnownHostsStore } from './knownHosts.js';

describe('writeKnownHostsTextSync', () => {
  it('leaves existing trust intact and removes its temporary file if atomic replacement fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-known-hosts-test-'));
    const path = join(dir, 'known_hosts');
    const original = 'retained.test ssh-ed25519 AAAA\n';
    fs.writeFileSync(path, original);
    const failure = new Error('rename refused');
    try {
      expect(() => writeKnownHostsTextSyncWithFs(path, 'new.test ssh-ed25519 BBBB', {
        ...fs, renameSync: () => { throw failure; },
      })).toThrow(failure);
      expect(readFileSync(path, 'utf8')).toBe(original);
      expect(readdirSync(dir)).toEqual(['known_hosts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes known_hosts with owner-only permissions on posix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-known-hosts-test-'));
    const path = join(dir, 'known_hosts');

    writeKnownHostsTextSync(path, 'example.test ssh-ed25519 AAAA');

    const stat = statSync(path);
    expect(stat.isFile()).toBe(true);

    if (process.platform !== 'win32') {
      expect(stat.mode & 0o600).toBe(0o600);
      expect(stat.mode & 0o077).toBe(0);
    }
  });
});

describe('SshKnownHostsStore', () => {
  it('rejects host/key tokens containing whitespace to avoid known_hosts injection', () => {
    const store = new SshKnownHostsStore();

    expect(() => store.remember({
      host: 'example.test\nmalicious',
      keyType: 'ssh-ed25519',
      key: 'AAAA',
    })).toThrow(/host/i);

    expect(() => store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519 malicious',
      key: 'AAAA',
    })).toThrow(/keyType/i);

    expect(() => store.remember({
      host: 'example.test',
      keyType: 'ssh-ed25519',
      key: 'AAAA BBBB',
    })).toThrow(/key/i);
  });
});
