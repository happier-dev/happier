import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import type { RelayAccessConfig } from '@happier-dev/cli-common/relayAccess';
import type { SystemTaskSshConnectionConfig } from '@happier-dev/cli-common/systemTasks';

import { createRelayAccessConfigStore } from './relayAccessConfigStore.js';

describe('relayAccessConfigStore', () => {
  it('writes local relay access config into an already-resolved happy home dir (no nested .happier)', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'hsetup-relay-access-local-'));
    const happyHomeDir = join(rootDir, '.happier');
    try {
      const store = createRelayAccessConfigStore({
        resolveHappyHomeDir: () => happyHomeDir,
      });

      const config: RelayAccessConfig = {
        providerId: 'lan',
        url: 'http://192.168.0.2:3005',
      };

      await store.writeConfig({
        target: { kind: 'local' },
        config,
      });

      const persisted = await readFile(join(happyHomeDir, 'relay', 'access', 'local.json'), 'utf8');
      expect(persisted).toContain('"providerId": "lan"');
      expect(persisted).toContain('"url": "http://192.168.0.2:3005"');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('writes local relay access config into an override happy home dir (HAPPIER_HOME_DIR style)', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'hsetup-relay-access-home-override-'));
    try {
      const store = createRelayAccessConfigStore({
        resolveHappyHomeDir: () => happyHomeDir,
      });

      const config: RelayAccessConfig = {
        providerId: 'localOnly',
      };

      await store.writeConfig({
        target: { kind: 'local' },
        config,
      });

      const persisted = await readFile(join(happyHomeDir, 'relay', 'access', 'local.json'), 'utf8');
      expect(persisted).toContain('"providerId": "localOnly"');
    } finally {
      await rm(happyHomeDir, { recursive: true, force: true });
    }
  });

  it('writes ssh relay access config without leaking secrets into remote commands', async () => {
      const localHomeDir = await mkdtemp(join(tmpdir(), 'hsetup-relay-access-store-'));
    try {
      const runRemoteText = vi.fn(async (_params: { ssh: SystemTaskSshConnectionConfig; remoteCommand: string }) => ({
        status: 0,
        stdout: '',
        stderr: '',
      }));
      let copiedLocalContents = '';
      const copyLocalFileToRemote = vi.fn(async (params: { ssh: SystemTaskSshConnectionConfig; localPath: string; remotePath: string }) => {
        copiedLocalContents = await readFile(params.localPath, 'utf8');
      });

      const store = createRelayAccessConfigStore({
        resolveHappyHomeDir: () => join(localHomeDir, '.happier'),
        ssh: {
          runRemoteText,
          copyLocalFileToRemote,
        },
      });

      const ssh: SystemTaskSshConnectionConfig = {
        target: 'root@example.test',
        auth: 'agent',
      };

      const config: RelayAccessConfig = {
        providerId: 'cloudflareNamed',
        hostname: 'relay.example.test',
        token: 'super-secret',
      };

      await store.writeConfig({
        target: { kind: 'ssh', ssh },
        config,
      });

      const concatenatedRemoteCommands = runRemoteText.mock.calls
        .map((call) => String(call[0]?.remoteCommand ?? ''))
        .join('\n');
      expect(concatenatedRemoteCommands).not.toContain('super-secret');

      expect(copyLocalFileToRemote).toHaveBeenCalledTimes(1);
      expect(copiedLocalContents).toContain('"token": "super-secret"');
    } finally {
      await rm(localHomeDir, { recursive: true, force: true });
    }
  });
});
