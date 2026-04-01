import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  spawnSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  approveTerminalAuthRequest,
  reloadConfiguration,
} = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  approveTerminalAuthRequest: vi.fn(async () => undefined),
  reloadConfiguration: vi.fn(),
}));

const { isLoopbackPortAvailable, findAvailableLoopbackPort } = vi.hoisted(() => ({
  isLoopbackPortAvailable: vi.fn<(port: number) => Promise<boolean>>(),
  findAvailableLoopbackPort: vi.fn<(requestedPort: number) => Promise<number>>(),
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
  reloadConfiguration,
}));

vi.mock('@/cloud/loopbackPort', () => ({
  isLoopbackPortAvailable,
  findAvailableLoopbackPort,
}));

vi.mock('@happier-dev/cli-common/systemTasks', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/systemTasks')>(
    '@happier-dev/cli-common/systemTasks',
  );
  return {
    ...actual,
    installRemoteFirstPartyComponent: async (
      ...args: Parameters<typeof actual.installRemoteFirstPartyComponent>
    ) => {
      const [params, deps] = args;
      return await actual.installRemoteFirstPartyComponent(params, {
        ...deps,
        preparePayload: async ({ componentId, channel }) => ({
          componentId,
          channel,
          versionId: 'test-version',
          payloadRoot: '/tmp/mock-payload',
          source: 'unit-test',
          cleanup: async () => undefined,
        }),
      });
    },
  };
});

import { createLiveRemoteSshBootstrapTaskKind } from './liveRemoteSshBootstrap';
import { createServer } from 'node:http';

function jsonResult(data: Record<string, unknown>) {
  return {
    status: 0,
    stdout: `${JSON.stringify(data)}\n`,
    stderr: '',
  };
}

	const TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
	const MISMATCHED_TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
	const BRACKETED_PORT_HOST_KEY = '[127.0.0.1]:54470 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
	const UNBRACKETED_PORT_KEYSCAN_OUTPUT = '127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('createLiveRemoteSshBootstrapTaskKind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isLoopbackPortAvailable.mockResolvedValue(true);
    findAvailableLoopbackPort.mockImplementation(async (requestedPort: number) => requestedPort + 1);
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
	        expect(remoteCommand).not.toContain('--public-server-url');
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

	  it('never emits deprecated --public-server-url when a relay public url is provided', async () => {
	    const previousImplementation = spawnSync.getMockImplementation();
	    if (!previousImplementation) {
	      throw new Error('Missing spawnSync mock implementation');
	    }
	    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
	      if (command === 'ssh') {
	        const remoteCommand = String(args.at(-1) ?? '');
	        if (remoteCommand.includes('server set')) {
	          expect(remoteCommand).toContain('https://public.example.test');
	          expect(remoteCommand).not.toContain('127.0.0.1:3005');
	          expect(remoteCommand).not.toContain('localhost:3005');
	        }
	      }
	      return previousImplementation(command, args);
	    });

	    const kind = createLiveRemoteSshBootstrapTaskKind();

	    await kind.run({
	      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
          publicRelayUrl: 'https://public.example.test',
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
	  });

	  it('prompts to replace host keys when known_hosts already contains a mismatched entry for a non-22 port', async () => {
	    readFileSync.mockReturnValue(`${BRACKETED_PORT_HOST_KEY}\n`);

	    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
	      if (command === 'ssh-keyscan') {
	        expect(args).toContain('-p');
	        expect(args).toContain('54470');
	        return {
	          status: 0,
	          stdout: `${UNBRACKETED_PORT_KEYSCAN_OUTPUT}\n`,
	          stderr: '',
	        };
	      }
	      throw new Error(`Unexpected command: ${command}`);
	    });

	    const kind = createLiveRemoteSshBootstrapTaskKind();

	    await expect(kind.run({
	      params: {
	        ssh: {
	          target: '127.0.0.1:54470',
	          auth: 'agent',
	          knownHostsPath: '/tmp/custom-known_hosts',
	        },
	        relay: {
	          relayUrl: 'https://relay.example.test',
	        },
	        channel: 'preview',
	        serviceMode: 'none',
	      },
	      emit: () => undefined,
	      prompt: async (request) => {
	        if (request.kind === 'ssh.replaceHostKey') {
	          return { trusted: false };
	        }
	        throw new Error(`Unexpected prompt: ${request.kind}`);
	      },
	    })).rejects.toThrow(/host trust was declined/i);
	  });

  it('installs the remote CLI from the verified payload path instead of curl-bash', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) {
      throw new Error('Missing spawnSync mock implementation');
    }
    let serverConfigureAttempts = 0;
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh') {
        const remoteCommand = String(args.at(-1) ?? '');
        if (remoteCommand.includes('server set') && serverConfigureAttempts++ === 0) {
          return {
            status: 127,
            stdout: '',
            stderr: 'bash: happier: command not found\n',
          };
        }
      }
      return previousImplementation(command, args as any);
    });

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

    expect(sshRemoteCommands.some((command) => command.includes('ln -sfn'))).toBe(true);
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

  it('honors explicit ssh.port when resolving trusted host keys (even if the ssh config file does not match the target)', async () => {
    const promptKinds: string[] = [];
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const trustedHostKey = '[dev.example.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnlyDoNotUseInProd';

    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) {
      throw new Error('Missing spawnSync mock implementation');
    }

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G') && args.includes('-F') && args.includes('/tmp/ssh_config')) {
        // Simulate a config file that exists but doesn't apply to the target; ssh -G falls back to port 22.
        return {
          status: 0,
          stdout: 'hostname dev.example.test\nport 22\n',
          stderr: '',
        };
      }
      if (command === 'ssh-keyscan') {
        // Mirror the port-aware host token so it matches `ssh.port` resolution.
        return {
          status: 0,
          stdout: `${trustedHostKey}\n`,
          stderr: '',
        };
      }
      return previousImplementation(command, args);
    });

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev.example.test',
          port: 2222,
          auth: 'agent',
          sshConfigFile: '/tmp/ssh_config',
          trustedHostKey,
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
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    })).resolves.toBeTruthy();

    // Guardrail: trusted host key should avoid SSH trust prompts.
    expect(promptKinds).toEqual(['auth.approveRemoteProvisioning']);

    const keyscanArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh-keyscan')
      .map(([, args]) => args as readonly string[]);
    expect(keyscanArgs).toHaveLength(1);
    expect(keyscanArgs[0]).toContain('-p');
    expect(keyscanArgs[0]).toContain('2222');
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

  it('surfaces stdout when an SSH command fails without stderr', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
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
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      if (remoteCommand.includes('server set')) {
        return {
          status: 127,
          stdout: '',
          stderr: 'bash: happier: command not found\n',
        };
      }
      if (remoteCommand.includes('ln -sfn') || remoteCommand.includes('cp -R')) {
        return {
          status: 255,
          stdout: 'remote installer failed\n',
          stderr: '',
        };
      }
      return jsonResult({ ok: true, data: {} });
    });

    await expect(
      kind.run({
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
            trustedHostKey: TRUSTED_HOST_KEY,
          },
          relay: {
            relayUrl: 'https://relay.example.test',
          },
          channel: 'preview',
          knownHostsMode: 'system',
          serviceMode: 'none',
        },
        emit: () => undefined,
        prompt: async () => {
          throw new Error('Unexpected prompt');
        },
      }),
    ).rejects.toThrow(/remote installer failed/i);
  });

  it('parses JSON output even when the remote command exits non-zero (auth status not authenticated)', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) {
      throw new Error('Missing spawnSync mock implementation');
    }

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh') {
        const remoteCommand = String(args.at(-1) ?? '');
        if (remoteCommand.includes('auth status --json')) {
          return {
            status: 1,
            stdout: `${JSON.stringify({
              v: 1,
              ok: false,
              kind: 'auth_status',
              error: { code: 'not_authenticated' },
            })}\n`,
            stderr: '',
          };
        }
      }
      return previousImplementation(command, args);
    });

    await expect(kind.run({
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
    })).resolves.toBeDefined();

    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({ publicKey: 'pub-key' });
  });

  it('temporarily applies the target relay selection when approving remote provisioning against a non-loopback relay URL', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    const previousLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;

    process.env.HAPPIER_SERVER_URL = 'https://original.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://original-app.example.test';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://original-public.example.test';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:59999';

    let observedServerUrl: string | null = null;
    let observedWebappUrl: string | null = null;

    approveTerminalAuthRequest.mockImplementation(async () => {
      observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
      observedWebappUrl = String(process.env.HAPPIER_WEBAPP_URL ?? '');
    });

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
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

    expect(observedServerUrl).toBe('https://relay.example.test');
    expect(observedWebappUrl).toBe('https://app.example.test');

    expect(process.env.HAPPIER_SERVER_URL).toBe('https://original.example.test');
    expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://original-app.example.test');
    expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBe('https://original-public.example.test');
    expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:59999');

    if (typeof previousServerUrl === 'string') process.env.HAPPIER_SERVER_URL = previousServerUrl;
    else delete process.env.HAPPIER_SERVER_URL;
    if (typeof previousWebappUrl === 'string') process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
    else delete process.env.HAPPIER_WEBAPP_URL;
    if (typeof previousPublicServerUrl === 'string') process.env.HAPPIER_PUBLIC_SERVER_URL = previousPublicServerUrl;
    else delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    if (typeof previousLocalServerUrl === 'string') process.env.HAPPIER_LOCAL_SERVER_URL = previousLocalServerUrl;
    else delete process.env.HAPPIER_LOCAL_SERVER_URL;
  });

  it('opens a loopback relay tunnel over ssh before approving remote provisioning', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    let observedServerUrl: string | null = null;
    const relayPort = await new Promise<number>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number } | null)?.port ?? 0;
        server.close(() => resolve(port));
      });
    });
    if (!relayPort) {
      throw new Error('Expected to reserve an available loopback port for test');
    }

    approveTerminalAuthRequest.mockImplementation(async () => {
      observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
    });

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: `http://127.0.0.1:${relayPort}`,
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
          env: {
            PORT: String(relayPort),
          },
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

    expect(
      spawnSync.mock.calls.some(
        ([command, args]) =>
          command === 'ssh' &&
          Array.isArray(args) &&
          args.includes('-L') &&
          args.includes(`${relayPort}:127.0.0.1:${relayPort}`),
      ),
    ).toBe(true);
    expect(observedServerUrl).toMatch(new RegExp(`^http://(127\\\\.0\\\\.0\\\\.1|localhost):${relayPort}$`, 'u'));
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({ publicKey: 'pub-key' });
    expect(reloadConfiguration).toHaveBeenCalled();
    expect(process.env.HAPPIER_SERVER_URL).toBe(previousServerUrl);
    expect(process.env.HAPPIER_WEBAPP_URL).toBe(previousWebappUrl);
  });

	  it('falls back to an available local port when the loopback relay port is already occupied', async () => {
	    const kind = createLiveRemoteSshBootstrapTaskKind();
	    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
	    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
	    let observedServerUrl: string | null = null;

    const occupied = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', () => resolve());
    });
	    const occupiedPort = (occupied.address() as { port: number } | null)?.port ?? 0;
	    if (!occupiedPort) {
	      throw new Error('Failed to allocate an occupied loopback port for test');
	    }
	    isLoopbackPortAvailable.mockImplementation(async (port) => port !== occupiedPort);
	    findAvailableLoopbackPort.mockImplementation(async () => occupiedPort + 1);

	    try {
	      approveTerminalAuthRequest.mockImplementation(async () => {
	        observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
	      });

      await kind.run({
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          relay: {
            relayUrl: `http://127.0.0.1:${occupiedPort}`,
          },
          relayRuntime: {
            enabled: true,
            mode: 'user',
            env: {
              PORT: String(occupiedPort),
            },
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

      const forwarded = spawnSync.mock.calls
        .filter(([command, args]) => command === 'ssh' && Array.isArray(args) && args.includes('-L'))
        .map(([, args]) => {
          const tokens = args as readonly string[];
          const idx = tokens.indexOf('-L');
          return idx >= 0 ? String(tokens[idx + 1] ?? '') : '';
        })
        .find((spec) => spec.endsWith(`:127.0.0.1:${occupiedPort}`));

      expect(forwarded).toBeTruthy();
      const localPort = Number(String(forwarded ?? '').split(':')[0] ?? '');
      expect(Number.isFinite(localPort)).toBe(true);
      expect(localPort).not.toBe(occupiedPort);
      expect(observedServerUrl).toMatch(new RegExp(`^http://(127\\\\.0\\\\.0\\\\.1|localhost):${localPort}$`, 'u'));
      expect(approveTerminalAuthRequest).toHaveBeenCalledWith({ publicKey: 'pub-key' });
      expect(reloadConfiguration).toHaveBeenCalled();
      expect(process.env.HAPPIER_SERVER_URL).toBe(previousServerUrl);
      expect(process.env.HAPPIER_WEBAPP_URL).toBe(previousWebappUrl);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('redacts sensitive values and absolute paths from stderr when ssh config resolution fails', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G')) {
        return {
          status: 1,
          stdout: '',
          stderr: [
            'Bad configuration option: IdentityFile /Users/leeroy/.ssh/id_ed25519',
            'password=supersecret',
            'known_hosts=/mock-home/ssh/known_hosts',
          ].join('\n'),
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
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      return jsonResult({ ok: true, data: {} });
    });

    try {
      await kind.run({
        params: {
          ssh: {
            target: 'lima-happier-wsrepl-qa-local',
            auth: 'agent',
            sshConfigFile: '/Users/leeroy/.ssh/config',
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('/Users/leeroy/.ssh/id_ed25519');
      expect(message).not.toContain('/mock-home/ssh/known_hosts');
      expect(message).not.toContain('supersecret');
      expect(message).toContain('id_ed25519');
      expect(message).toContain('known_hosts');
    }
  });
});
