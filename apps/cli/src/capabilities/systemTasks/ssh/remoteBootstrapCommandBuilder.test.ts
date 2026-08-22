import { describe, expect, it } from 'vitest';

import {
  buildRemoteBootstrapCommand,
} from './remoteBootstrapCommandBuilder';

describe('buildRemoteBootstrapCommand', () => {
  it('targets the channel-specific managed CLI binary instead of the mutable bin shim', () => {
    expect(buildRemoteBootstrapCommand({
      label: 'auth.status',
      serverUrl: 'https://relay.example.test',
    })).toContain('$HOME/.happier/cli/current/happier auth status --json');

    expect(buildRemoteBootstrapCommand({
      label: 'auth.status',
      serverUrl: 'https://relay.example.test',
    })).not.toContain('$HOME/.happier/bin/happier');
  });

  it('uses a real auth-status preflight and configures the selected relay before pairing', () => {
    expect(buildRemoteBootstrapCommand({
      label: 'auth.status',
      serverUrl: 'https://relay.example.test',
    })).toContain('auth status --json');

    expect(buildRemoteBootstrapCommand({
      label: 'server.configure',
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
    })).toContain("server set --server-url 'https://relay.example.test' --webapp-url 'https://app.example.test' --json");
    expect(buildRemoteBootstrapCommand({
      label: 'server.configure',
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
    })).not.toContain('--public-server-url');
  });

  it('pins daemon service lifecycle commands to the selected relay urls', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'daemon.service.install',
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      daemonServiceMode: 'user',
    });

    expect(command).toContain("HAPPIER_DAEMON_SERVICE_SERVER_URL='https://relay.example.test'");
    expect(command).toContain("HAPPIER_DAEMON_SERVICE_WEBAPP_URL='https://app.example.test'");
    expect(command).toContain('service install --mode=user --json');
  });

  it('supports remote background service inventory and full replacement commands', () => {
    expect(buildRemoteBootstrapCommand({
      label: 'daemon.service.list',
      serverUrl: 'https://relay.example.test',
    })).toContain('service list --json');

    expect(buildRemoteBootstrapCommand({
      label: 'daemon.service.uninstallAll',
      serverUrl: 'https://relay.example.test',
    })).toContain('service uninstall --all --yes --json');
  });

  it('uses the canonical background-service surface for restart lifecycle commands', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'daemon.service.restart',
      serverUrl: 'https://relay.example.test',
      daemonServiceMode: 'user',
    });

    expect(command).toContain('service restart --mode=user --json');
    expect(command).not.toContain('daemon service restart');
  });

  it('supports localServerUrl so remote API calls + daemon service prefer a locally hosted relay runtime while preserving the public URL', () => {
    const serverConfigure = buildRemoteBootstrapCommand({
      label: 'server.configure',
      serverUrl: 'https://relay.example.test',
      localServerUrl: 'http://127.0.0.1:3005',
      webappUrl: 'https://app.example.test',
    });
    expect(serverConfigure).toContain("--server-url 'https://relay.example.test'");
    expect(serverConfigure).toContain("--local-server-url 'http://127.0.0.1:3005'");
    expect(serverConfigure).toContain("--webapp-url 'https://app.example.test'");

    const authRequest = buildRemoteBootstrapCommand({
      label: 'auth.request',
      serverUrl: 'https://relay.example.test',
      localServerUrl: 'http://127.0.0.1:3005',
      webappUrl: 'https://app.example.test',
    });
    expect(authRequest).toContain("--server-url 'https://relay.example.test'");
    expect(authRequest).not.toContain("--local-server-url 'http://127.0.0.1:3005'");

    const daemonInstall = buildRemoteBootstrapCommand({
      label: 'daemon.service.install',
      serverUrl: 'https://relay.example.test',
      localServerUrl: 'http://127.0.0.1:3005',
      webappUrl: 'https://app.example.test',
      daemonServiceMode: 'user',
    });
    expect(daemonInstall).toContain("HAPPIER_DAEMON_SERVICE_SERVER_URL='http://127.0.0.1:3005'");
    expect(daemonInstall).toContain("HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL='https://relay.example.test'");
    expect(daemonInstall).toContain("HAPPIER_DAEMON_SERVICE_WEBAPP_URL='https://app.example.test'");
  });

  it('targets Happier Cloud by profile id when bootstrapping against https://api.happier.dev (avoid ad-hoc persisted profiles)', () => {
    const serverConfigure = buildRemoteBootstrapCommand({
      label: 'server.configure',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    });
    expect(serverConfigure).toContain('server use cloud --json');
    expect(serverConfigure).not.toContain("server set --server-url 'https://api.happier.dev'");

    const authRequest = buildRemoteBootstrapCommand({
      label: 'auth.request',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
    });
    expect(authRequest).toContain('auth request --json --persist --server cloud');
    expect(authRequest).not.toContain("--server-url 'https://api.happier.dev'");

    const authWait = buildRemoteBootstrapCommand({
      label: 'auth.wait',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      data: { publicKey: 'abc' },
    });
    expect(authWait).toContain('auth wait --public-key');
    expect(authWait).toContain('--json --persist --server cloud');
    expect(authWait).not.toContain("--server-url 'https://api.happier.dev'");
  });

  it('never emits hstack self-host install shells (relay runtime is handled out-of-band)', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'auth.status',
      serverUrl: 'https://relay.example.test',
    });

    expect(command).not.toContain('hstack');
    expect(command).not.toContain('self-host');
  });

  it('installs the relay runtime by asking the remote CLI to host locally', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'relay.runtime.install',
      serverUrl: 'https://relay.example.test',
      channel: 'preview',
      daemonServiceMode: 'user',
      data: {
        relayRuntimeMode: 'system',
        relayRuntimeEnv: {
          HAPPIER_SERVER_HOST: '127.0.0.1',
        },
      },
    });

    expect(command).toContain('$HOME/.happier/cli-preview/current/happier relay host install');
    expect(command).toContain("--channel 'preview'");
    expect(command).toContain('--mode system');
    expect(command).toContain("--env 'HAPPIER_SERVER_HOST=127.0.0.1'");
    expect(command).toContain('--preserve-active-server');
    expect(command).toContain('--yes');
    expect(command).toContain('--json');
    expect(command).not.toContain('--ssh');
    expect(command).not.toContain('scp');
  });

  it('passes an already uploaded server payload to the canonical remote installer', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'relay.runtime.install',
      serverUrl: 'https://relay.example.test',
      channel: 'dev',
      data: {
        relayRuntimeMode: 'user',
        relayRuntimeServerBinaryPath: '$HOME/.happier/happier-server/publicdev/current/bin/happier-server',
      },
    });

    expect(command).toContain('--server-binary');
    expect(command).toContain(`--server-binary "$HOME"/'.happier/happier-server/publicdev/current/bin/happier-server'`);
    expect(command).not.toContain(`--server-binary '$HOME/`);
  });
});
