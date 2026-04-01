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
    expect(command).toContain('daemon service install --mode=user --json');
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
    expect(authRequest).toContain("--local-server-url 'http://127.0.0.1:3005'");

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

  it('never emits hstack self-host install shells (relay runtime is handled out-of-band)', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'auth.status',
      serverUrl: 'https://relay.example.test',
    });

    expect(command).not.toContain('hstack');
    expect(command).not.toContain('self-host');
  });
});
