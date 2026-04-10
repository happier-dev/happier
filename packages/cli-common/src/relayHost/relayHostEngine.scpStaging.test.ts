import { describe, expect, it } from 'vitest';

import { createRelayHostEngine } from './relayHostEngine.js';

describe('RelayHostEngine (remote SSH)', () => {
  it('fails closed when another remote relay lane already occupies the same base URL', async () => {
    let installCalls = 0;

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('/self-host-state.json') && command.includes('/self-host-preview/')) {
          return { status: 1, stdout: '', stderr: 'missing\n' };
        }
        if (command.includes('/self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env') && command.includes('/self-host/config/')) {
          return { status: 0, stdout: 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return { status: 0, stdout: 'ActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => {
        installCalls += 1;
        return { binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' };
      },
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    })).rejects.toThrow(/stable/i);

    expect(installCalls).toBe(0);
  });

  it('restarts the systemd service on install so updated unit/env changes take effect', async () => {
    let serviceInstallCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('daemon-reload') && command.includes('enable')) {
          serviceInstallCommand = command;
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(serviceInstallCommand).toContain('systemctl --user daemon-reload');
    expect(serviceInstallCommand).toContain('systemctl --user enable');
    expect(serviceInstallCommand).toContain('systemctl --user restart');
    expect(serviceInstallCommand).toContain('XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"');
    expect(serviceInstallCommand).toContain('DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"');
    expect(serviceInstallCommand).not.toContain('enable --now');
  });

  it('uses server.env to report the configured baseUrl (instead of defaults)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\\nHAPPIER_SERVER_HOST=0.0.0.0\\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\\nSubState=running\\nUnitFileState=enabled\\n',
            stderr: '',
          };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'system',
    });

    expect(status.baseUrl).toBe('http://127.0.0.1:24851');
  });

  it('returns the configured relayUrl from installOrUpdate (including env overrides such as PORT)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    const result = await engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      env: {
        PORT: '24851',
      },
    });

    expect(result.relayUrl).toBe('http://127.0.0.1:24851');
  });

  it('preserves an existing remote PORT when installOrUpdate runs without an explicit override', async () => {
    let stagedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          stagedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    const result = await engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(result.relayUrl).toBe('http://127.0.0.1:24851');
    expect(stagedEnvText).toContain('PORT=24851');
  });

  it('parses systemd service state from key=value output (order-independent)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(status.service).toEqual({ enabled: true, active: false });
  });

  it('uses an scp-safe remote stage path when staging under $HOME', async () => {
    const copiedRemotePaths: string[] = [];

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async () => ({ status: 0, stdout: 'no', stderr: '' }),
      copyLocalDirectoryToRemote: async ({ remotePath }) => {
        copiedRemotePaths.push(remotePath);
      },
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(copiedRemotePaths.some((path) => path.startsWith('$HOME'))).toBe(false);
    expect(copiedRemotePaths.some((path) => path.startsWith('.happier/bootstrap-staging/relay-runtime-123'))).toBe(true);
    expect(copiedRemotePaths.some((path) => path.startsWith('.happier/bootstrap-staging/relay-service-'))).toBe(true);
  });

  it('creates the remote bin dir before installing the shim', async () => {
    let setupCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('mkdir -p') && command.includes('server.env') && command.includes('self-host-state.json')) {
          setupCommand = command;
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(setupCommand).toContain('mkdir -p $HOME/.happier/bin');
  });

  it('installs a local server binary override onto the remote host before rendering relay env', async () => {
    let renderedEnvText = '';
    let capturedLocalBinaryPath: string | undefined;

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId, localBinaryPath }) => {
        if (componentId === 'happier-server') {
          capturedLocalBinaryPath = localBinaryPath;
        }
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
      selfHostRelayBinaryOverride: '/tmp/local/happier-server',
    });

    expect(capturedLocalBinaryPath).toBe('/tmp/local/happier-server');
    expect(renderedEnvText).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/home/remote-user/.happier/happier-server/current/prisma/sqlite/migrations');
    expect(renderedEnvText).not.toContain('/tmp/local/happier-server');
  });

  it('fails installOrUpdate when the remote relay /health probe does not become ready', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'PrismaClientInitializationError: missing query engine\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    })).rejects.toThrow(/health/i);
  });

  it('treats the relay /health probe as successful when it prints an ok token (even if exit status is non-zero)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: 'HAPPIER_RELAY_HEALTH_OK\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await expect(engine.installOrUpdate({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    })).resolves.toEqual({ relayUrl: 'http://127.0.0.1:3005', mode: 'user' });
  });

  it('rejects remote start when the service command succeeds but the relay never becomes healthy', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=53388\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('systemctl') && command.includes(' start ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'startup failed\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'start',
    })).rejects.toThrow(/healthy/i);
  });

  it('ensures the shim install command creates the destination directory before copying', async () => {
    let setupCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('rm -f') && command.includes('happier-server') && command.includes('(ln -s')) {
          setupCommand = command;
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(setupCommand).toContain('mkdir -p $HOME/.happier/bin;');
    expect(setupCommand).toContain('rm -f $HOME/.happier/bin/happier-server;');
  });

  it('renders a systemd user service without $HOME shell tokens', async () => {
    let renderedServiceDefinition = '';
    let renderedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const candidate = join(localPath, 'service-definition');
        renderedServiceDefinition = await readFile(candidate, 'utf8').catch(() => '');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(renderedServiceDefinition).toContain('WorkingDirectory=/home/remote-user');
    expect(renderedServiceDefinition).not.toContain('$HOME');
    expect(renderedEnvText).toContain('HAPPIER_SQLITE_MIGRATIONS_DIR=/home/remote-user/.happier/happier-server/current/prisma/sqlite/migrations');
  });

  it('does not pin PRISMA_QUERY_ENGINE_LIBRARY in remote relay env', async () => {
    let renderedEnvText = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'arm64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async ({ localPath }) => {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const envCandidate = await readFile(join(localPath, 'server.env'), 'utf8').catch(() => '');
        if (envCandidate) {
          renderedEnvText = envCandidate;
        }
      },
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    });

    expect(renderedEnvText).not.toContain('PRISMA_QUERY_ENGINE_LIBRARY=');
  });

  it('parses remote systemd service state without relying on show output ordering', async () => {
    let healthProbeCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('systemctl --user show')) {
          return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('/health')) {
          healthProbeCommand = command;
          return { status: 0, stdout: 'HAPPIER_RELAY_HEALTH_OK\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    const status = await engine.readStatus({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'preview',
      mode: 'user',
    });

    expect(status.service.enabled).toBe(true);
    expect(status.service.active).toBe(true);
    expect(status.healthy).toBe(true);
    expect(healthProbeCommand).toContain('http://127.0.0.1:3005/health');
  });

  it('reports a remote relay as unhealthy when the service is active but the health probe fails', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('systemctl --user show')) {
          return { status: 0, stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'preview',
      mode: 'user',
    });

    expect(status.service.enabled).toBe(true);
    expect(status.service.active).toBe(true);
    expect(status.healthy).toBe(false);
  });

  it('reports the remote relay as unhealthy when the service is active but the health probe fails', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return {
            status: 0,
            stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\n',
            stderr: '',
          };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(status.service).toEqual({ enabled: true, active: true });
    expect(status.healthy).toBe(false);
  });

  it('treats a failed systemctl status probe as unknown (null) instead of inactive', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes('show')) {
          return { status: 127, stdout: '', stderr: 'systemctl: command not found' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    const status = await engine.readStatus({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
    });

    expect(status.service).toEqual({ enabled: null, active: null });
  });

  it('uninstalls a remote relay runtime by disabling the service and removing installed paths', async () => {
    const commands: string[] = [];

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        commands.push(command);
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'publicdev-1' }),
    });

    await engine.control({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
      action: 'uninstall',
    });

    expect(commands.some((command) => command.includes('systemctl --user disable --now'))).toBe(true);
    expect(commands.some((command) => command.includes('rm -rf'))).toBe(true);
  });

  it('uses sudo when installing a system service over SSH (non-root friendly)', async () => {
    let setupCommand = '';
    let installCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('mkdir -p') && command.includes('server.env') && command.includes('self-host-state.json')) {
          setupCommand = command;
        }
        if (command.includes('systemctl') && command.includes('daemon-reload') && command.includes('restart')) {
          installCommand = command;
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'system',
    });

    expect(setupCommand).toContain('sudo -n');
    expect(setupCommand).toContain('${SUDO_PREFIX}mkdir -p');
    expect(setupCommand).toContain('${SUDO_PREFIX}cp');
    expect(installCommand).toContain('sudo -n');
    expect(installCommand).toContain('${SUDO_PREFIX}systemctl daemon-reload');
    expect(installCommand).toContain('${SUDO_PREFIX}systemctl enable');
    expect(installCommand).toContain('${SUDO_PREFIX}systemctl restart');
  });

  it('surfaces a clear error when systemd user services are unavailable (no bus)', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$PATH')) {
          return { status: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'no\n', stderr: '' };
        }
        if (command.includes('systemctl --user') && command.includes('restart')) {
          return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await expect(engine.installOrUpdate({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'user',
    })).rejects.toThrow(/systemd user service/i);
  });

  it('uninstalls a system-mode remote relay runtime using sudo when needed', async () => {
    let controlCommand = '';
    let cleanupCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('systemctl') && command.includes('disable --now')) {
          controlCommand = command;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('rm -rf') && command.includes('/opt/happier')) {
          cleanupCommand = command;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('echo yes')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '/opt/happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.control({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'system',
      action: 'uninstall',
    });

    expect(controlCommand).toContain('sudo -n');
    expect(cleanupCommand).toContain('sudo -n');
  });

  it('uninstalls a system-mode launchd service using sudo when needed', async () => {
    let controlCommand = '';
    let cleanupCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('launchctl') && command.includes('unload -w')) {
          controlCommand = command;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('rm -rf') && command.includes('/opt/happier')) {
          cleanupCommand = command;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/Users/remote-user\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '/opt/happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.control({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'system',
      action: 'uninstall',
    });

    expect(controlCommand).toContain('sudo -n');
    expect(controlCommand).toContain('launchctl unload -w');
    expect(cleanupCommand).toContain('sudo -n');
  });

  it('restarts a system-mode launchd service using bootstrap semantics when needed', async () => {
    let restartCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('launchctl') && command.includes('bootstrap') && command.includes('kickstart')) {
          restartCommand = command;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/Users/remote-user\n', stderr: '' };
        }
        return { status: 0, stdout: 'no\n', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async ({ componentId }) => {
        return {
          binaryPath: componentId === 'happier-cli'
            ? '$HOME/.happier/happier-cli/current/happier'
            : '$HOME/.happier/happier-server/current/happier-server',
          versionId: 'publicdev-1',
        };
      },
    });

    await engine.control({
      target: {
        kind: 'ssh',
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
      },
      channel: 'dev',
      mode: 'system',
      action: 'restart',
    });

    expect(restartCommand).toContain('sudo -n');
    expect(restartCommand).toContain('launchctl bootout -w');
    expect(restartCommand).toContain('launchctl bootstrap system');
    expect(restartCommand).toContain('/Library/LaunchDaemons/happier-server-dev.plist');
    expect(restartCommand).toContain('launchctl kickstart -k');
    expect(restartCommand).toContain('system/happier-server-dev');
    expect(restartCommand).not.toContain('launchctl load -w');
  });

  it('runs the remote relay health probe after start', async () => {
    let healthProbeCommand = '';

    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes(' start ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/health')) {
          healthProbeCommand = command;
          return { status: 0, stdout: 'HAPPIER_RELAY_HEALTH_OK\n', stderr: '' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'start',
    })).resolves.toBeUndefined();

    expect(healthProbeCommand).toContain('MAX=120');
    expect(healthProbeCommand).toContain('sleep 1');
    expect(healthProbeCommand).toContain('http://127.0.0.1:24851/health');
  });

  it('rejects remote restart when the relay never becomes healthy again', async () => {
    const engine = createRelayHostEngine({
      now: () => 123,
      resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
      runRemoteText: async ({ remoteCommand }) => {
        const command = String(remoteCommand ?? '');
        if (command.includes('printf') && command.includes('$HOME')) {
          return { status: 0, stdout: '/home/remote-user\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('self-host-state.json')) {
          return { status: 0, stdout: '{"version":"0.1.2"}\n', stderr: '' };
        }
        if (command.includes('cat') && command.includes('server.env')) {
          return { status: 0, stdout: 'PORT=24851\nHAPPIER_SERVER_HOST=127.0.0.1\n', stderr: '' };
        }
        if (command.includes('systemctl') && command.includes(' restart ')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command.includes('/health')) {
          return { status: 1, stdout: '', stderr: 'curl: (7) connection refused\n' };
        }
        if (command.includes('tail') && command.includes('server.err.log')) {
          return { status: 0, stdout: 'restart failed\n', stderr: '' };
        }
        if (command.includes('[ -f') && command.includes('happier-server')) {
          return { status: 0, stdout: 'yes\n', stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      copyLocalDirectoryToRemote: async () => {},
      installRemoteComponent: async () => ({
        binaryPath: '$HOME/.happier/happier-server/current/happier-server',
        versionId: 'publicdev-1',
      }),
    });

    await expect(engine.control({
      target: { kind: 'ssh', ssh: { target: 'dev@example.test', auth: 'agent' } },
      channel: 'dev',
      mode: 'user',
      action: 'restart',
    })).rejects.toThrow(/healthy/i);
  });
});
