import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RelayAccessConfig } from '@happier-dev/cli-common/relayAccess';
import type { RelayAccessTaskTarget, SystemTaskSshConnectionConfig } from '@happier-dev/cli-common/systemTasks';

type RemoteTextResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

export type RelayAccessConfigStore = Readonly<{
  readConfig: (params: Readonly<{ target: RelayAccessTaskTarget }>) => Promise<RelayAccessConfig | null>;
  writeConfig: (params: Readonly<{ target: RelayAccessTaskTarget; config: RelayAccessConfig | null }>) => Promise<void>;
}>;

type RelayAccessConfigStoreSshDeps = Readonly<{
  runRemoteText: (params: Readonly<{ ssh: SystemTaskSshConnectionConfig; remoteCommand: string }>) => Promise<RemoteTextResult>;
  copyLocalFileToRemote: (params: Readonly<{ ssh: SystemTaskSshConnectionConfig; localPath: string; remotePath: string }>) => Promise<void>;
}>;

const REMOTE_CONFIG_DIR = '$HOME/.happier/relay/access';
const REMOTE_CONFIG_PATH = '$HOME/.happier/relay/access/local.json';

function resolveConfigPathForLocalMachine(happyHomeDir: string): Readonly<{ dir: string; path: string }> {
  const dir = join(happyHomeDir, 'relay', 'access');
  return {
    dir,
    path: join(dir, 'local.json'),
  };
}

function parsePersistedRelayAccessConfig(raw: string): RelayAccessConfig | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
  if (!providerId) return null;

  if (providerId === 'localOnly') return { providerId: 'localOnly' };
  if (providerId === 'tailscaleServe') return { providerId: 'tailscaleServe' };
  if (providerId === 'tailscaleFunnel') return { providerId: 'tailscaleFunnel' };
  if (providerId === 'lan') {
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    return url ? { providerId: 'lan', url } : null;
  }
  if (providerId === 'cloudflareNamed') {
    const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
    const token = typeof record.token === 'string' ? record.token.trim() : '';
    return hostname && token ? { providerId: 'cloudflareNamed', hostname, token } : null;
  }
  return null;
}

function stringifyPersistedRelayAccessConfig(config: RelayAccessConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function createRelayAccessConfigStore(params: Readonly<{
  resolveHappyHomeDir: () => string;
  ssh?: RelayAccessConfigStoreSshDeps;
}>): RelayAccessConfigStore {
  const resolveHappyHomeDir = params.resolveHappyHomeDir;

  return {
    readConfig: async ({ target }) => {
      if (target.kind !== 'ssh') {
        const happyHomeDir = resolveHappyHomeDir();
        const { path } = resolveConfigPathForLocalMachine(happyHomeDir);
        const raw = await readFile(path, 'utf8').catch(() => '');
        return parsePersistedRelayAccessConfig(raw);
      }

      if (!params.ssh) return null;
      const result = await params.ssh.runRemoteText({
        ssh: target.ssh,
        remoteCommand: `cat ${REMOTE_CONFIG_PATH} 2>/dev/null || true`,
      });
      if (result.status !== 0) return null;
      return parsePersistedRelayAccessConfig(result.stdout);
    },

    writeConfig: async ({ target, config }) => {
      if (target.kind !== 'ssh') {
        const happyHomeDir = resolveHappyHomeDir();
        const { dir, path } = resolveConfigPathForLocalMachine(happyHomeDir);
        if (!config) {
          await rm(path, { force: true });
          return;
        }

        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(path, stringifyPersistedRelayAccessConfig(config), { encoding: 'utf8', mode: 0o600 });
        await chmod(path, 0o600).catch(() => undefined);
        return;
      }

      if (!params.ssh) {
        throw new Error('ssh relay access requires ssh dependencies');
      }

      if (!config) {
        await params.ssh.runRemoteText({
          ssh: target.ssh,
          remoteCommand: `rm -f ${REMOTE_CONFIG_PATH}`,
        });
        return;
      }

      const tmpRoot = await mkdtemp(join(tmpdir(), 'hsetup-relay-access-'));
      const localPath = join(tmpRoot, 'local.json');
      try {
        await writeFile(localPath, stringifyPersistedRelayAccessConfig(config), { encoding: 'utf8', mode: 0o600 });
        await chmod(localPath, 0o600).catch(() => undefined);

        await params.ssh.runRemoteText({
          ssh: target.ssh,
          remoteCommand: `mkdir -p ${REMOTE_CONFIG_DIR} && chmod 700 $HOME/.happier $HOME/.happier/relay ${REMOTE_CONFIG_DIR} || true`,
        });

        await params.ssh.copyLocalFileToRemote({
          ssh: target.ssh,
          localPath,
          remotePath: REMOTE_CONFIG_PATH,
        });

        await params.ssh.runRemoteText({
          ssh: target.ssh,
          remoteCommand: `chmod 600 ${REMOTE_CONFIG_PATH} || true`,
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
