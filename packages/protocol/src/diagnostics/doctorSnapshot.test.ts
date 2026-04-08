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
});
