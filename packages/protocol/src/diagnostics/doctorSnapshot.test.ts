import { describe, expect, it } from 'vitest';

import { DoctorSnapshotSchema, parseDoctorSnapshotSafe } from './doctorSnapshot.js';

describe('DoctorSnapshotSchema', () => {
  it('accepts a valid snapshot and parseDoctorSnapshotSafe redacts userinfo/query/hash', () => {
    const raw = JSON.stringify({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
        publicServerUrl: 'https://api.happier.dev/path?token=abc',
        webappUrl: 'https://app.happier.dev/?token=abc',
      },
      accountId: 'acct_123',
      settings: {
        activeServerId: 'cloud',
        servers: [
          {
            id: 'cloud',
            name: 'Happier Cloud',
            serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc',
            webappUrl: 'https://app.happier.dev/?token=abc',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        ],
        knownAccountIds: ['acct_123'],
      },
      daemonStatus: {
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
          localServerUrl: 'http://127.0.0.1:3005/?token=abc',
          publicServerUrl: 'https://api.happier.dev/path?token=abc',
          webappUrl: 'https://app.happier.dev/?token=abc',
          comparableKey: 'https://api.happier.dev',
        },
        daemon: {
          running: true,
          pid: 4321,
          httpPort: null,
          startedWithCliVersion: '1.2.3',
          startedWithPublicReleaseChannel: 'preview',
          startupSource: 'background-service',
          serviceManaged: true,
          serviceLabel: 'com.happier.cli.daemon.default',
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: false,
          machineId: null,
          needsAuth: true,
          accountId: 'acct_123',
        },
      },
      installations: {
        happier: {
          activeInvocation: {
            path: '/Users/tester/.happier/bin/hprev',
            realPath: '/Users/tester/.happier/cli-preview/current/happier',
            invokerName: 'hprev',
            ring: 'preview',
            version: '1.2.3-preview.4',
            installationId: 'managed:preview:/Users/tester/.happier/cli-preview/current',
          },
          installations: [
            {
              id: 'managed:preview:/Users/tester/.happier/cli-preview/current',
              source: 'firstPartyManaged',
              components: ['happier-cli', 'happier-daemon'],
              ring: 'preview',
              version: '1.2.3-preview.4',
              path: '/Users/tester/.happier/cli-preview/current',
              realPath: '/Users/tester/.happier/cli-preview/current',
              shimName: 'hprev',
              onPath: true,
              managedRoot: '/Users/tester/.happier/cli-preview',
            },
          ],
        },
      },
      services: {
        happier: {
          services: [
            {
              id: 'launchd:preview:cloud',
              serviceType: 'daemon',
              platform: 'darwin',
              backend: 'launchd',
              label: 'com.happier.cli.daemon.preview.cloud',
              verification: 'verified',
              ring: 'preview',
              instanceId: 'cloud',
              scope: 'user',
              definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
              executablePath: '/Users/tester/.happier/cli-preview/current/happier',
              serverUrl: 'https://admin:secret@api.happier.dev/path?token=abc#frag',
              publicServerUrl: 'https://api.happier.dev/path?token=abc',
              installed: true,
              running: true,
            },
          ],
        },
      },
      warnings: [
        {
          code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
          severity: 'warning',
          message: 'Multiple Happier CLI installations were detected on PATH.',
          repairCommands: ['happier doctor --json'],
        },
      ],
    });

    const parsed = parseDoctorSnapshotSafe(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');

    expect(DoctorSnapshotSchema.safeParse(parsed.snapshot).success).toBe(true);
    const serialized = JSON.stringify(parsed.snapshot);
    expect(serialized).not.toContain('admin:secret');
    expect(serialized).not.toContain('?token=');
    expect(serialized).not.toContain('#frag');
    expect(parsed.snapshot.daemonStatus?.server.localServerUrl).toBe('http://127.0.0.1:3005');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithCliVersion).toBe('1.2.3');
    expect(parsed.snapshot.daemonStatus?.daemon.startedWithPublicReleaseChannel).toBe('preview');
    expect(parsed.snapshot.daemonStatus?.daemon.startupSource).toBe('background-service');
    expect(parsed.snapshot.daemonStatus?.daemon.serviceManaged).toBe(true);
    expect(parsed.snapshot.daemonStatus?.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
    expect(parsed.snapshot.installations?.happier.installations[0]?.ring).toBe('preview');
    expect(parsed.snapshot.services?.happier.services[0]?.label).toContain('com.happier.cli.daemon.preview.cloud');
    expect(parsed.snapshot.services?.happier.services[0]?.serverUrl).toBe('https://api.happier.dev/path');
    expect(parsed.snapshot.services?.happier.services[0]?.publicServerUrl).toBe('https://api.happier.dev/path');
    expect(parsed.snapshot.warnings?.[0]?.code).toBe('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
  });

  it('returns a stable error for invalid JSON', () => {
    const parsed = parseDoctorSnapshotSafe('{not json}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected error');
    expect(parsed.error).toMatch(/invalid json/i);
  });

  it('accepts partial installations and services containers for forward compatibility', () => {
    const result = DoctorSnapshotSchema.safeParse({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: {
        activeServerId: null,
        servers: [],
        knownAccountIds: [],
      },
      installations: {},
      services: {},
    });

    expect(result.success).toBe(true);
  });

  // `healthy` answers "does this daemon work", separately from `running`, which only answers
  // "does a process exist". The daemon snapshot is validated through this schema before it is
  // written, so an undeclared field would be stripped in silence and `happier doctor` would go
  // on reporting a PID probe as health.
  it('carries the daemon service-health verdict and its explicit unknown', () => {
    const parseDaemonHealth = (healthy: boolean | null | undefined) => {
      const result = DoctorSnapshotSchema.safeParse({
        capturedAt: '2026-02-23T00:00:00.000Z',
        server: {
          activeServerId: 'cloud',
          serverUrl: 'https://api.happier.dev',
          publicServerUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        accountId: null,
        settings: { activeServerId: null, servers: [], knownAccountIds: [] },
        daemonStatus: {
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            localServerUrl: null,
            publicServerUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            comparableKey: 'https://api.happier.dev',
          },
          daemon: {
            running: true,
            ...(healthy === undefined ? {} : { healthy }),
            pid: 4321,
            httpPort: null,
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
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected a valid snapshot');
      return result.data.daemonStatus?.daemon;
    };

    // A live process whose machine-control registration never completed.
    expect(parseDaemonHealth(false)).toMatchObject({ running: true, healthy: false });
    expect(parseDaemonHealth(true)).toMatchObject({ running: true, healthy: true });
    // Explicitly inconclusive, and distinct from unhealthy.
    expect(parseDaemonHealth(null)).toMatchObject({ running: true, healthy: null });
    // A snapshot from a CLI that predates the field still parses, and reads as unknown.
    const older = parseDaemonHealth(undefined);
    expect(older).toMatchObject({ running: true });
    expect(older?.healthy ?? null).toBeNull();
  });

  it('preserves optional repair and local runtime diagnostic sections', () => {
    const result = DoctorSnapshotSchema.safeParse({
      capturedAt: '2026-02-23T00:00:00.000Z',
      server: {
        activeServerId: 'cloud',
        serverUrl: 'https://api.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
      },
      accountId: null,
      settings: {
        activeServerId: null,
        servers: [],
        knownAccountIds: [],
      },
      repairSummary: {
        schemaVersion: 1,
        status: 'needs_attention',
        findingCounts: {
          total: 3,
          warning: 2,
          error: 1,
          actionable: 2,
        },
        findingKinds: ['background_service_not_running', 'local_relay_stale'],
      },
      localRelays: {
        relays: [
          {
            id: 'local-relay-preview',
            releaseChannel: 'preview',
            relayUrl: 'http://127.0.0.1:3025/?token=secret#frag',
            version: '1.2.3-preview.1',
            installed: true,
            running: true,
            healthy: true,
            serviceEnabled: true,
            port: 3025,
            installRoot: '/Users/tester/.happier/relay-preview',
          },
        ],
      },
      automaticStartup: {
        entries: [
          {
            id: 'launchd:preview:default',
            label: 'com.happier.cli.daemon.preview.default',
            releaseChannel: 'preview',
            targetMode: 'default-following',
            scope: 'user',
            installed: true,
            running: false,
            definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.default.plist',
            relayUrl: 'https://admin:secret@relay.example.test/path?token=abc#frag',
          },
        ],
        defaultFollowingCount: 1,
        pinnedCount: 0,
      },
      activeStack: {
        activeServerId: 'cloud',
        releaseChannel: 'preview',
        relayUrl: 'https://relay.example.test/path?token=abc',
        localRelayUrl: 'http://127.0.0.1:3025/?token=abc',
        source: 'settings',
      },
      serviceHealth: {
        backgroundService: {
          installed: true,
          running: false,
          healthy: false,
          serviceLabel: 'com.happier.cli.daemon.preview.default',
          releaseChannel: 'preview',
          relayUrl: 'https://relay.example.test/path?token=abc',
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected optional diagnostic sections to parse');

    const parsed = parseDoctorSnapshotSafe(JSON.stringify(result.data));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected parsed optional diagnostic sections');

    expect(parsed.snapshot).toMatchObject({
      repairSummary: {
        status: 'needs_attention',
        findingCounts: {
          total: 3,
          warning: 2,
          error: 1,
          actionable: 2,
        },
        findingKinds: ['background_service_not_running', 'local_relay_stale'],
      },
      localRelays: {
        relays: [
          expect.objectContaining({
            releaseChannel: 'preview',
            relayUrl: 'http://127.0.0.1:3025',
            healthy: true,
          }),
        ],
      },
      automaticStartup: {
        entries: [
          expect.objectContaining({
            targetMode: 'default-following',
            relayUrl: 'https://relay.example.test/path',
          }),
        ],
      },
      activeStack: {
        relayUrl: 'https://relay.example.test/path',
        localRelayUrl: 'http://127.0.0.1:3025',
      },
      serviceHealth: {
        backgroundService: expect.objectContaining({
          running: false,
          relayUrl: 'https://relay.example.test/path',
        }),
      },
    });
  });
});
