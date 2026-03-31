import { describe, expect, it } from 'vitest';

import { createRelayHostEngine } from './relayHostEngine.js';

describe('RelayHostEngine (remote SSH)', () => {
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

  it('parses remote systemd service state without relying on show output ordering', async () => {
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
        if (command.includes('systemctl') && command.includes('daemon-reload') && command.includes('enable --now')) {
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

    expect(installCommand).toContain('sudo -n systemctl daemon-reload');
    expect(installCommand).toContain('sudo -n systemctl enable --now');
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
        if (command.includes('systemctl --user') && command.includes('enable --now')) {
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
});
