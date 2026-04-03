import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  spawnSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  approveTerminalAuthRequest,
} = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  approveTerminalAuthRequest: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', () => ({
  spawnSync,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync,
    readFileSync,
    writeFileSync,
  };
});

vi.mock('@/auth/terminalAuthApproval', () => ({
  approveTerminalAuthRequest,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/mock-home',
  },
}));

import { createLiveRemoteSshBootstrapTaskKind } from './liveRemoteSshBootstrap';

function jsonResult(data: Record<string, unknown>) {
  return {
    status: 0,
    stdout: `${JSON.stringify(data)}\n`,
    stderr: '',
  };
}

const TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MISMATCHED_TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('createLiveRemoteSshBootstrapTaskKind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileSync.mockImplementation(() => {
      throw new Error('missing known_hosts');
    });
    writeFileSync.mockReturnValue(undefined);
    mkdirSync.mockReturnValue(undefined);
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G')) {
        expect(args).toContain('-F');
        expect(args).toContain('/tmp/lima-ssh.config');
        expect(args).toContain('lima-happier-wsrepl-qa-local');
        return {
          status: 0,
          stdout: [
            'hostname 127.0.0.1',
            'port 50977',
            'user leeroy',
          ].join('\n'),
          stderr: '',
        };
      }
      if (command === 'ssh-keyscan') {
        return {
          status: 0,
          stdout: `${TRUSTED_HOST_KEY}\n`,
          stderr: '',
        };
      }
      if (command === 'scp') {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }
      if (command !== 'ssh') {
        throw new Error(`Unexpected command: ${command}`);
      }
      const remoteCommand = String(args.at(-1) ?? '');
      if (remoteCommand.includes('$PATH') && remoteCommand.includes('printf')) {
        return {
          status: 0,
          stdout: '/usr/local/bin:/usr/bin:/bin\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('exit 0') && remoteCommand.includes('echo ""')) {
        return {
          status: 0,
          stdout: '\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('echo yes') && (remoteCommand.includes('[ -d ') || remoteCommand.includes('[ -f '))) {
        return {
          status: 0,
          stdout: 'yes\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('homeDir')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
          homeDir: '/home/leeroy',
        });
      }
      if (remoteCommand.includes('prismaEnginePath')) {
        return jsonResult({
          hasNodeModules: true,
          prismaEnginePath: '/home/leeroy/.happier/server/current/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node',
        });
      }
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      if (remoteCommand.includes('auth status --json')) {
        return jsonResult({
          ok: true,
          data: {
            authenticated: false,
          },
        });
      }
      if (remoteCommand.includes('server set')) {
        return jsonResult({
          ok: true,
          data: {},
        });
      }
      if (remoteCommand.includes('auth request')) {
        return jsonResult({
          ok: true,
          data: {
            publicKey: 'pub-key',
            claimSecret: 'secret',
            stateFile: '/tmp/state.json',
          },
        });
      }
      if (remoteCommand.includes('auth wait')) {
        return jsonResult({
          ok: true,
          data: {
            machineId: 'machine-1',
          },
        });
      }
      return jsonResult({
        ok: true,
        data: {},
      });
    });
  });

  it('uses ssh config files to resolve Lima-style SSH aliases and target the real host', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'lima-happier-wsrepl-qa-local',
          auth: 'agent',
          sshConfigFile: '/tmp/lima-ssh.config',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        if (request.kind === 'ssh.trustHost' || request.kind === 'ssh.replaceHostKey') {
          return { trusted: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshInvocations = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => args as readonly string[]);

    expect(sshInvocations.some((args) => args.includes('-F') && args.includes('/tmp/lima-ssh.config'))).toBe(true);
  });

  it('installs the remote CLI from the verified payload path instead of curl-bash', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshRemoteCommands = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => String((args as readonly string[]).at(-1) ?? ''));

    expect(sshRemoteCommands.some((command) => command.includes('self __install-payload'))).toBe(true);
    expect(sshRemoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({ publicKey: 'pub-key' });
  });

  it('executes remote shell commands via bash -lc to avoid /bin/sh pipefail incompatibilities', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => args as readonly string[]);

    expect(sshArgs.some((args) => args.includes('bash') && args.includes('-lc'))).toBe(true);
  });

  it('installs the relay runtime over ssh without hstack self-host and returns the computed relay url', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    const result = await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
        relayRuntime: {
          enabled: true,
          mode: 'user',
          env: {
            PORT: '4001',
          },
        },
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(result.relayRuntime?.relayUrl).toBe('http://127.0.0.1:4001');

    const sshRemoteCommands = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => String((args as readonly string[]).at(-1) ?? ''))
      .join('\n');

    expect(sshRemoteCommands).not.toContain('hstack');
    expect(sshRemoteCommands).not.toContain('hstack self-host');
    expect(sshRemoteCommands).not.toContain('self-host install');
    expect(sshRemoteCommands).not.toContain("--component 'hstack'");
    expect(sshRemoteCommands).not.toContain('/Users/leeroy/Documents/Development/happier/dev');
    // Guardrail: relay runtime install must use the shared relay host engine, not the bespoke heredoc/prisma probe flow.
    expect(sshRemoteCommands).not.toContain('HAPPIER_EOF');
    expect(sshRemoteCommands).not.toContain('prismaEnginePath');
  });

  it('honors provided trusted host keys and known_hosts paths without prompting again', async () => {
    const promptKinds: string[] = [];
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
          knownHostsPath: '/tmp/custom-known_hosts',
          trustedHostKey: TRUSTED_HOST_KEY,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        promptKinds.push(request.kind);
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        if (request.kind === 'ssh.trustHost' || request.kind === 'ssh.replaceHostKey') {
          return { trusted: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(promptKinds).toEqual(['auth.approveRemoteProvisioning']);

    const transportArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh' || command === 'scp')
      .map(([, args]) => args as readonly string[]);

    expect(transportArgs.every((args) => args.includes('UserKnownHostsFile=/tmp/custom-known_hosts'))).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith('/tmp/custom-known_hosts', `${TRUSTED_HOST_KEY}\n`, 'utf8');
  });

  it('fails closed when an explicit trusted host key mismatches the fresh keyscan result', async () => {
    readFileSync.mockReturnValue(`${TRUSTED_HOST_KEY}\n`);
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
          knownHostsPath: '/tmp/custom-known_hosts',
          trustedHostKey: MISMATCHED_TRUSTED_HOST_KEY,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    })).rejects.toThrow(/trusted host key/i);

    expect(spawnSync.mock.calls.filter(([command]) => command === 'ssh')).toHaveLength(0);
    expect(spawnSync.mock.calls.filter(([command]) => command === 'scp')).toHaveLength(0);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(approveTerminalAuthRequest).not.toHaveBeenCalled();
  });
});
