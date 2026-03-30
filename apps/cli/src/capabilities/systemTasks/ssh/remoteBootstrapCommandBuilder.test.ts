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
      publicServerUrl: 'https://public.example.test',
    })).toContain("server set --server-url 'https://relay.example.test' --webapp-url 'https://app.example.test' --public-server-url 'https://public.example.test' --json");
  });

  it('pins daemon service lifecycle commands to the selected relay urls', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'daemon.service.install',
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://public.example.test',
      daemonServiceMode: 'user',
    });

    expect(command).toContain("HAPPIER_DAEMON_SERVICE_SERVER_URL='https://relay.example.test'");
    expect(command).toContain("HAPPIER_DAEMON_SERVICE_WEBAPP_URL='https://app.example.test'");
    expect(command).toContain("HAPPIER_DAEMON_SERVICE_PUBLIC_SERVER_URL='https://public.example.test'");
    expect(command).toContain('daemon service install --mode=user --json');
  });

  it('normalizes relay runtime install channel and mode before composing shell commands', () => {
    const command = buildRemoteBootstrapCommand({
      label: 'relay.runtime.install',
      serverUrl: 'https://relay.example.test',
      data: {
        channel: 'preview; touch /tmp/pwned',
        mode: 'system; touch /tmp/pwned',
      },
    });

    expect(command).toContain('--channel=stable');
    expect(command).toContain('--mode=user');
    expect(command).not.toContain('touch /tmp/pwned');
  });
});
