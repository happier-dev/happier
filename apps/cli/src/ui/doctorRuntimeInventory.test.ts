import { describe, expect, it } from 'vitest';

import type { DoctorSnapshot } from '@/ui/doctorSnapshot';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('renderDoctorHappierRuntimeInventory', () => {
  it('renders active runtime, installations, services, and repair guidance', async () => {
    const { renderDoctorHappierRuntimeInventory } = await import('./doctorRuntimeInventory');

    const snapshot: DoctorSnapshot = {
      capturedAt: '2026-04-07T10:11:12.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: 'acct_1',
      settings: {
        activeServerId: 'cloud',
        servers: [],
        knownAccountIds: ['acct_1'],
      },
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev',
          localServerUrl: 'http://127.0.0.1:3005',
          publicServerUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
          comparableKey: 'https://api.happier.dev',
        },
        daemon: {
          running: true,
          pid: 1234,
          httpPort: 3005,
          startedWithCliVersion: '1.2.0',
          startedWithPublicReleaseChannel: 'stable',
        },
        service: { installed: true, running: true },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine_1',
          needsAuth: false,
          accountId: 'acct_1',
        },
      },
      installations: {
        happier: {
          activeInvocation: {
            path: '/opt/happier/bin/happier',
            realPath: '/opt/happier/bin/happier',
            invokerName: 'happier',
            ring: 'preview',
            version: '1.2.3',
            installationId: 'managed:preview:/opt/happier/cli-preview/current',
          },
          installations: [
            {
              id: 'managed:preview:/opt/happier/cli-preview/current',
              source: 'firstPartyManaged',
              components: ['happier-cli', 'happier-daemon'],
              ring: 'preview',
              version: '1.2.3',
              path: '/opt/happier/cli-preview/current',
              realPath: '/opt/happier/cli-preview/current',
              shimName: 'hprev',
              onPath: true,
              managedRoot: '/opt/happier/cli-preview',
            },
            {
              id: 'pathBinary:/usr/local/bin/happier',
              source: 'pathBinary',
              components: ['happier-cli', 'happier-daemon'],
              ring: 'stable',
              version: '1.0.0',
              path: '/usr/local/bin/happier',
              realPath: '/usr/local/bin/happier',
              shimName: 'happier',
              onPath: true,
              managedRoot: null,
            },
          ],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'daemon:com.happier.cli.daemon.preview.cloud',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.cli.daemon.preview.cloud',
              verification: 'verified',
              ring: 'preview',
              instanceId: 'cloud',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
              executablePath: '/opt/happier/cli-preview/current/happier',
              installed: true,
              running: true,
            },
            {
              id: 'stack-service:dev.happier.stack.dev-built',
              serviceType: 'stack-service',
              platform: 'darwin',
              backend: 'launchd',
              label: 'dev.happier.stack.dev-built',
              verification: 'verified',
              ring: null,
              instanceId: 'dev-built',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/dev.happier.stack.dev-built.plist',
              executablePath: '/opt/happier-stack/bin/hstack',
              installed: true,
              running: false,
            },
          ],
        },
      },
      warnings: [
        {
          code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
          severity: 'warning',
          message: 'Multiple Happier CLI installations were detected on PATH.',
          repairCommands: ['happier doctor --json', 'happier daemon service install --replace-existing=ring --yes'],
        },
      ],
    };

    const rendered = stripAnsi(renderDoctorHappierRuntimeInventory(snapshot));

    expect(rendered).toContain('Happier runtime');
    expect(rendered).toContain('Invoked CLI:');
    expect(rendered).toContain('1.2.3');
    expect(rendered).toContain('preview');
    expect(rendered).toContain('/opt/happier/bin/happier');
    expect(rendered).toContain('Detected installations');
    expect(rendered).toContain('hprev');
    expect(rendered).toContain('/usr/local/bin/happier');
    expect(rendered).toContain('Detected services');
    expect(rendered).toContain('com.happier.cli.daemon.preview.cloud');
    expect(rendered).toContain('dev.happier.stack.dev-built');
    expect(rendered).toContain('Warnings');
    expect(rendered).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    expect(rendered).toContain('happier daemon service install --replace-existing=ring --yes');
  });
});
