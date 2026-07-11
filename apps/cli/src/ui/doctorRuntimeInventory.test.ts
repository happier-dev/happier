import { describe, expect, it } from 'vitest';

import type { DoctorSnapshot } from '@/ui/doctorSnapshot';

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('renderDoctorHappierRuntimeInventory', () => {
  it('redacts URLs rendered by runtime inventory sections', async () => {
    const { renderDoctorHappierRuntimeInventory } = await import('./doctorRuntimeInventory');
    const secretUrl = (label: string) =>
      `https://doctor-${label}-user:doctor-${label}-password-123456@relay.example.test/api?mode=dev&profile=sk-doctor-${label}-profile-secret-123456&token=doctor-${label}-token-123456#doctor-${label}-fragment-secret-123456`;

    const snapshot: DoctorSnapshot = {
      capturedAt: '2026-04-07T10:11:12.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: secretUrl('server'),
        publicServerUrl: secretUrl('public'),
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: {
        activeServerId: 'cloud',
        servers: [],
        knownAccountIds: [],
      },
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: secretUrl('daemon'),
          localServerUrl: secretUrl('local'),
          publicServerUrl: secretUrl('daemon-public'),
          webappUrl: 'https://app.happier.dev',
          comparableKey: 'relay.example.test',
        },
        daemon: {
          running: true,
          pid: 1234,
          httpPort: 3005,
          startedWithCliVersion: '1.2.0',
          startedWithPublicReleaseChannel: 'preview',
          serviceManaged: true,
          serviceLabel: 'com.happier.test',
        },
        service: { installed: true, running: true },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine_1',
          needsAuth: false,
          accountId: null,
        },
      },
      installations: {
        happier: {
          activeInvocation: null,
          installations: [],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'daemon:secret',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.secret',
              verification: 'verified',
              targetMode: 'default-following',
              ring: 'preview',
              instanceId: 'cloud',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.secret.plist',
              executablePath: '/opt/happier/bin/happier',
              serverUrl: secretUrl('service'),
              publicServerUrl: secretUrl('service-public'),
              installed: true,
              running: true,
            },
          ],
        },
      },
      localRelays: {
        relays: [
          {
            id: 'local-secret',
            releaseChannel: 'preview',
            relayUrl: secretUrl('relay'),
            version: null,
            installed: true,
            healthy: true,
            running: true,
          },
        ],
      },
      automaticStartup: {
        entries: [
          {
            id: 'startup-secret',
            label: 'Startup secret',
            scope: 'user',
            installed: true,
            releaseChannel: 'preview',
            targetMode: 'default-following',
            relayUrl: secretUrl('startup'),
            running: true,
          },
        ],
      },
    } as DoctorSnapshot;

    const rendered = stripAnsi(renderDoctorHappierRuntimeInventory(snapshot));

    expect(rendered).toContain('mode=dev');
    expect(rendered).toMatch(/redacted/i);
    expect(rendered).not.toContain('doctor-local-user');
    expect(rendered).not.toContain('doctor-service-password-123456');
    expect(rendered).not.toContain('sk-doctor-relay-profile-secret-123456');
    expect(rendered).not.toContain('doctor-startup-token-123456');
    expect(rendered).not.toContain('doctor-daemon-fragment-secret-123456');
  });

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
          startupSource: 'background-service',
          serviceManaged: true,
          serviceLabel: 'com.happier.cli.daemon.default',
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
              targetMode: 'default-following',
              ring: 'preview',
              instanceId: 'cloud',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
              executablePath: '/opt/happier/cli-preview/current/happier',
              serverUrl: 'https://relay.preview.example.test',
              publicServerUrl: 'https://relay.preview.example.test',
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
            {
              id: 'self-host-service:happier-server-preview',
              serviceType: 'self-host-service',
              platform: 'darwin',
              backend: 'launchd',
              label: 'happier-server-preview',
              verification: 'verified',
              ring: 'preview',
              instanceId: null,
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/happier-server-preview.plist',
              executablePath: '/opt/happier-server/bin/happier-server',
              installed: true,
              running: true,
            },
          ],
        },
      },
      repairSummary: {
        schemaVersion: 1,
        status: 'needs_attention',
        findingCounts: {
          total: 2,
          warning: 1,
          error: 1,
          actionable: 1,
        },
        findingKinds: ['background_service_not_running'],
      },
      localRelays: {
        relays: [
          {
            id: 'local-relay-preview',
            releaseChannel: 'preview',
            relayUrl: 'http://127.0.0.1:3025',
            version: '1.2.3-preview.1',
            installed: true,
            running: true,
            healthy: true,
            serviceEnabled: true,
            port: 3025,
            installRoot: '/opt/happier/relay-preview',
          },
        ],
      },
      automaticStartup: {
        entries: [
          {
            id: 'daemon:com.happier.cli.daemon.preview.cloud',
            label: 'com.happier.cli.daemon.preview.cloud',
            releaseChannel: 'preview',
            targetMode: 'default-following',
            scope: 'user',
            installed: true,
            running: true,
            definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
            relayUrl: 'https://relay.preview.example.test',
          },
        ],
        defaultFollowingCount: 1,
        pinnedCount: 0,
      },
      activeStack: {
        activeServerId: 'cloud',
        releaseChannel: 'preview',
        relayUrl: 'https://relay.preview.example.test',
        localRelayUrl: 'http://127.0.0.1:3025',
        source: 'settings',
      },
      serviceHealth: {
        backgroundService: {
          installed: true,
          running: true,
          healthy: true,
          serviceLabel: 'com.happier.cli.daemon.preview.cloud',
          releaseChannel: 'preview',
          relayUrl: 'https://relay.preview.example.test',
        },
      },
      warnings: [
        {
          code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
          severity: 'warning',
          message: 'Multiple Happier CLI installations were detected on PATH.',
          repairCommands: ['happier doctor --json', 'happier service install --replace-existing=ring --yes'],
        },
      ],
    };

    const rendered = stripAnsi(renderDoctorHappierRuntimeInventory(snapshot));

    expect(rendered).toContain('Happier runtime');
    expect(rendered).toContain('Invoked CLI:');
    expect(rendered).toContain('Current owner:');
    expect(rendered).toContain('background service');
    expect(rendered).toContain('com.happier.cli.daemon.default');
    expect(rendered).toContain('Current CLI differs from the running relay owner.');
    expect(rendered).toContain('happier service restart');
    expect(rendered).toContain('1.2.3');
    expect(rendered).toContain('preview');
    expect(rendered).toContain('/opt/happier/bin/happier');
    expect(rendered).toContain('Detected installations');
    expect(rendered).toContain('hprev');
    expect(rendered).toContain('/usr/local/bin/happier');
    expect(rendered).toContain('Detected services');
    expect(rendered).toContain('Background service');
    expect(rendered).toContain('com.happier.cli.daemon.preview.cloud');
    expect(rendered).toContain('default background service');
    expect(rendered).toContain('https://relay.preview.example.test');
    expect(rendered).toContain('dev.happier.stack.dev-built');
    expect(rendered).toContain('Self-host service');
    expect(rendered).toContain('happier-server-preview');
    expect(rendered).toContain('Doctor snapshot diagnostics');
    expect(rendered).toContain('Repair status:');
    expect(rendered).toContain('needs_attention');
    expect(rendered).toContain('Findings:');
    expect(rendered).toContain('total 2');
    expect(rendered).toContain('Active stack');
    expect(rendered).toContain('Local relays');
    expect(rendered).toContain('local-relay-preview');
    expect(rendered).toContain('Automatic startup');
    expect(rendered).toContain('Background service health');
    expect(rendered).toContain('Warnings');
    expect(rendered).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    expect(rendered).toContain('happier service install --replace-existing=ring --yes');
  });

  it('keeps legacy relay owner source wording neutral when startup metadata is missing', async () => {
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
          serviceManaged: null,
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
          installations: [],
        },
      },
      services: {
        happier: {
          services: [],
        },
      },
      warnings: [],
    };

    const rendered = stripAnsi(renderDoctorHappierRuntimeInventory(snapshot));

    expect(rendered).toContain('Current owner:');
    expect(rendered).toContain('relay owner');
    expect(rendered).not.toContain('manual relay runtime');
    expect(rendered).toContain('happier daemon restart');
  });
});
