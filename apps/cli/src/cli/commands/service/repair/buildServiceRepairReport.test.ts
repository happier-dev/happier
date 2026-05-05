import { describe, expect, it } from 'vitest';

import type { HappierRuntimeWarning } from '@happier-dev/cli-common/happierRuntime';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';

import { buildServiceRepairReport, defaultFollowingMatchesSelectedReleaseChannel } from './buildServiceRepairReport';

const runtime = {
  platform: 'linux',
  channel: 'stable',
  uid: 1000,
  userHomeDir: '/home/test',
  happierHomeDir: '/home/test/.happier',
  serverUrl: 'https://relay.example.test',
  publicServerUrl: 'https://relay.example.test',
  nodePath: '/usr/bin/node',
  entryPath: '/opt/happier/index.mjs',
} as const;

describe('buildServiceRepairReport', () => {
  it('projects warning-derived findings with warningCode and service targetMode', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [
          {
            name: 'Happier',
            label: 'happier-daemon.default',
            mode: 'user',
            releaseChannel: 'stable',
            targetMode: 'default-following',
            serverId: 'default',
            installed: true,
            path: '/home/test/.config/systemd/user/happier-daemon.default.service',
            platform: 'linux',
          },
        ] satisfies readonly DaemonServiceListEntry[],
        actions: [],
        manualWarnings: [],
      },
      warnings: [
        {
          code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
          severity: 'warning',
          message: 'Multiple verified default-following Happier background services were detected.',
          repairCommands: ['happier service repair --dry-run'],
        },
      ],
    });

    expect(defaultFollowingMatchesSelectedReleaseChannel(report)).toBe(true);
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'automatic_startup_duplicate_default_following',
        warningCode: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
        entry: expect.objectContaining({
          targetMode: 'default-following',
        }),
        targetMode: 'default-following',
      }),
    ]);
  });

  it('projects background-service actions as typed finding actions', () => {
    const action = {
      kind: 'install-default-following-service',
      releaseChannel: 'stable',
      mode: 'user',
    } as const;
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [action],
        manualWarnings: [],
      },
      warnings: [],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'automatic_startup_missing',
        warningCode: null,
        targetMode: 'default-following',
        actions: [
          {
            kind: 'background-service-plan',
            planAction: action,
          },
        ],
      }),
    ]);
  });

  it('classifies running daemon CLI mismatch strategy from daemon ownership and channel state', () => {
    const existingServices = [
      {
        name: 'Happier',
        label: 'happier-daemon.default',
        mode: 'user',
        releaseChannel: 'stable',
        targetMode: 'default-following',
        serverId: 'default',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
      },
    ] satisfies readonly DaemonServiceListEntry[];
    const warning: HappierRuntimeWarning = {
      code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
      severity: 'warning',
      message: 'The running background service was started with a different CLI version.',
      repairCommands: ['happier service repair --yes'],
    };

    const serviceManagedReport = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices,
        actions: [],
        manualWarnings: [],
      },
      warnings: [warning],
      daemonStatus: {
        daemon: {
          running: true,
          startedWithCliVersion: '1.0.0',
          startedWithPublicReleaseChannel: 'stable',
          serviceManaged: true,
          serviceLabel: 'happier-daemon.default',
        },
      },
    });
    expect(serviceManagedReport.currentlyRunning).toEqual([
      expect.objectContaining({
        releaseChannel: 'stable',
        version: '1.0.0',
        serviceManaged: true,
        managedByEntryId: '/home/test/.config/systemd/user/happier-daemon.default.service',
      }),
    ]);
    expect(serviceManagedReport.findings).toEqual([
      expect.objectContaining({
        kind: 'running_daemon_cli_mismatch',
        driftKind: 'version-only',
        recoveryStrategy: 'service-restart',
      }),
    ]);

    const manualOwnerReport = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices,
        actions: [],
        manualWarnings: [],
      },
      warnings: [warning],
      daemonStatus: {
        daemon: {
          running: true,
          startedWithCliVersion: '1.0.0',
          startedWithPublicReleaseChannel: 'stable',
          serviceManaged: false,
          serviceLabel: null,
        },
      },
    });
    expect(manualOwnerReport.findings).toEqual([
      expect.objectContaining({
        kind: 'running_daemon_cli_mismatch',
        driftKind: 'version-only',
        recoveryStrategy: 'daemon-takeover',
      }),
    ]);

    const crossChannelReport = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices,
        actions: [],
        manualWarnings: [],
      },
      warnings: [warning],
      daemonStatus: {
        daemon: {
          running: true,
          startedWithCliVersion: '1.0.0',
          startedWithPublicReleaseChannel: 'preview',
          serviceManaged: true,
          serviceLabel: 'happier-daemon.default',
        },
      },
    });
    expect(crossChannelReport.findings).toEqual([
      expect.objectContaining({
        kind: 'running_daemon_cli_mismatch',
        driftKind: 'cross-channel',
        recoveryStrategy: 'daemon-stop',
      }),
    ]);
  });

  it('dedupes stale automatic startup replacement when a daemon mismatch owns the same managed slot', () => {
    const existingService = {
      name: 'Happier',
      label: 'happier-daemon.default',
      mode: 'user',
      releaseChannel: 'stable',
      targetMode: 'default-following',
      serverId: 'default',
      installed: true,
      path: '/home/test/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux',
    } satisfies DaemonServiceListEntry;
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [existingService],
        actions: [
          {
            kind: 'remove-service',
            service: {
              label: existingService.label,
              mode: 'user',
              releaseChannel: 'stable',
              targetMode: 'default-following',
              instanceId: 'default',
              installedPath: existingService.path,
            },
          },
          {
            kind: 'install-default-following-service',
            releaseChannel: 'stable',
            mode: 'user',
          },
        ],
        manualWarnings: [],
      },
      warnings: [
        {
          code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
          severity: 'warning',
          message: 'The running background service was started with a different CLI version.',
          repairCommands: ['happier service repair --yes'],
        },
      ],
      daemonStatus: {
        daemon: {
          running: true,
          startedWithCliVersion: '1.0.0',
          startedWithPublicReleaseChannel: 'stable',
          serviceManaged: true,
          serviceLabel: 'happier-daemon.default',
        },
      },
    });

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      'running_daemon_cli_mismatch',
      'automatic_startup_missing',
    ]);
    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'automatic_startup_version_stale',
      }),
    ]));
  });

  it('dedupes stale startup replacement against the daemon-managed slot when multiple services exist', () => {
    const unrelatedService = {
      name: 'Happier',
      label: 'happier-daemon.alpha.default',
      mode: 'user',
      releaseChannel: 'stable',
      targetMode: 'default-following',
      serverId: 'alpha',
      installed: true,
      path: '/home/test/.config/systemd/user/happier-daemon.alpha.default.service',
      platform: 'linux',
    } satisfies DaemonServiceListEntry;
    const managedService = {
      name: 'Happier',
      label: 'happier-daemon.zeta.default',
      mode: 'user',
      releaseChannel: 'stable',
      targetMode: 'default-following',
      serverId: 'zeta',
      installed: true,
      path: '/home/test/.config/systemd/user/happier-daemon.zeta.default.service',
      platform: 'linux',
    } satisfies DaemonServiceListEntry;
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [unrelatedService, managedService],
        actions: [
          {
            kind: 'remove-service',
            service: {
              label: managedService.label,
              mode: 'user',
              releaseChannel: 'stable',
              targetMode: 'default-following',
              instanceId: 'zeta',
              installedPath: managedService.path,
            },
          },
          {
            kind: 'install-default-following-service',
            releaseChannel: 'stable',
            mode: 'user',
          },
        ],
        manualWarnings: [],
      },
      warnings: [
        {
          code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
          severity: 'warning',
          message: 'The running background service was started with a different CLI version.',
          repairCommands: ['happier service repair --yes'],
        },
      ],
      daemonStatus: {
        daemon: {
          running: true,
          startedWithCliVersion: '1.0.0',
          startedWithPublicReleaseChannel: 'stable',
          serviceManaged: true,
          serviceLabel: managedService.label,
        },
      },
    });

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      'running_daemon_cli_mismatch',
      'automatic_startup_missing',
    ]);
    expect(report.findings.find((finding) => finding.kind === 'running_daemon_cli_mismatch')).toEqual(
      expect.objectContaining({
        entry: expect.objectContaining({
          label: managedService.label,
        }),
        recoveryStrategy: 'service-restart',
      }),
    );
  });

  it('represents a default automatic startup replacement as version stale when no running mismatch owns it', () => {
    const existingService = {
      name: 'Happier',
      label: 'happier-daemon.default',
      mode: 'user',
      releaseChannel: 'stable',
      targetMode: 'default-following',
      serverId: 'default',
      installed: true,
      path: '/home/test/.config/systemd/user/happier-daemon.default.service',
      platform: 'linux',
    } satisfies DaemonServiceListEntry;
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [existingService],
        actions: [
          {
            kind: 'remove-service',
            service: {
              label: existingService.label,
              mode: 'user',
              releaseChannel: 'stable',
              targetMode: 'default-following',
              instanceId: 'default',
              installedPath: existingService.path,
            },
          },
        ],
        manualWarnings: [],
      },
      warnings: [],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'automatic_startup_version_stale',
        entry: expect.objectContaining({
          targetMode: 'default-following',
        }),
      }),
    ]);
  });

  it('reports channel switch recommendation from the active stack', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      stacks: [
        {
          id: 'preview-stack',
          releaseChannel: 'preview',
          active: true,
        },
      ],
    });

    expect(report.stacks).toEqual([
      expect.objectContaining({
        id: 'preview-stack',
        active: true,
      }),
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'channel_switch_recommended',
        warningCode: null,
        actions: [
          {
            kind: 'switch-release-channel',
            releaseChannel: 'preview',
            command: 'happier self release-channel use preview',
          },
        ],
      }),
    ]);
  });

  it('renders dev channel switch guidance without exposing publicdev', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      stacks: [
        {
          id: 'dev-stack',
          releaseChannel: 'publicdev',
          active: true,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'channel_switch_recommended',
        title: 'Switch the CLI release channel to dev.',
        actions: [
          {
            kind: 'switch-release-channel',
            releaseChannel: 'publicdev',
            command: 'happier self release-channel use dev',
          },
        ],
      }),
    ]);
  });

  it('does not recommend a channel switch when dev labels use different forms', () => {
    const report = buildServiceRepairReport({
      runtime: {
        ...runtime,
        channel: 'publicdev',
      },
      plan: {
        currentReleaseChannel: 'publicdev',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      stacks: [
        {
          id: 'dev-stack',
          releaseChannel: 'dev',
          active: true,
        },
      ],
    });

    expect(report.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'channel_switch_recommended',
      }),
    ]));
  });

  it('reports auth missing for the active profile before service findings', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [
          {
            name: 'Happier',
            label: 'happier-daemon.default',
            mode: 'user',
            releaseChannel: 'stable',
            targetMode: 'default-following',
            serverId: 'default',
            installed: true,
            path: '/home/test/.config/systemd/user/happier-daemon.default.service',
            platform: 'linux',
          },
        ] satisfies readonly DaemonServiceListEntry[],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      authProfiles: [
        {
          id: 'default',
          active: true,
          authenticated: false,
          authState: 'missing',
          machineRegistered: false,
        },
      ],
      daemonStatus: {
        daemon: {
          running: false,
        },
        service: {
          installed: true,
          running: false,
        },
      },
    });

    expect(report.authProfiles).toEqual([
      expect.objectContaining({
        id: 'default',
        authenticated: false,
      }),
    ]);
    expect(report.findings.map((finding) => finding.kind)).toEqual([
      'auth_missing_for_profile',
      'background_service_not_running',
    ]);
    expect(report.findings[0]).toEqual(expect.objectContaining({
      actions: [
        {
          kind: 'run-auth-login',
          profileId: 'default',
          command: 'happier auth login',
        },
      ],
    }));
  });

  it('reports machine registration missing for an authenticated active profile', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      authProfiles: [
        {
          id: 'default',
          active: true,
          authenticated: true,
          authState: 'authenticated',
          machineRegistered: false,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'machine_not_registered_for_profile',
        actions: [
          {
            kind: 'register-machine',
            profileId: 'default',
            command: 'happier setup',
          },
        ],
      }),
    ]);
  });

  it('reports expired auth for the active profile', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      authProfiles: [
        {
          id: 'default',
          active: true,
          authenticated: null,
          authState: 'expired',
          machineRegistered: true,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'auth_expired_for_active_profile',
        actions: [
          {
            kind: 'run-auth-login',
            profileId: 'default',
            command: 'happier auth login',
          },
        ],
      }),
    ]);
  });

  it('reports crash-looping background service instead of generic not running', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [
          {
            name: 'Happier',
            label: 'happier-daemon.default',
            mode: 'user',
            releaseChannel: 'stable',
            targetMode: 'default-following',
            serverId: 'default',
            installed: true,
            path: '/home/test/.config/systemd/user/happier-daemon.default.service',
            platform: 'linux',
          },
        ] satisfies readonly DaemonServiceListEntry[],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      daemonStatus: {
        daemon: {
          running: false,
        },
        service: {
          installed: true,
          running: false,
        },
      },
      backgroundServiceHealth: {
        status: 'crash_looping',
        details: {
          state: 'exited',
          restartCount: 6,
          lastExitStatus: 1,
        },
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'background_service_crash_looping',
        diagnostic: expect.stringContaining('restartCount=6'),
        actions: [],
      }),
    ]);
  });

  it('reports duplicate running daemons for the same profile', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      runningDaemons: [
        {
          label: 'daemon-a',
          releaseChannel: 'stable',
          version: '1.0.0',
          serviceManaged: true,
          managedByEntryId: null,
          profileId: 'default',
        },
        {
          label: 'daemon-b',
          releaseChannel: 'stable',
          version: '1.0.1',
          serviceManaged: false,
          managedByEntryId: null,
          profileId: 'default',
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'running_daemon_duplicate_profile',
        warningCode: null,
        recoveryStrategy: 'daemon-stop',
      }),
    ]);
  });

  it('reports off-channel local relay leftovers only when the current-channel local relay exists', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      localRelays: [
        {
          id: 'stable-local',
          releaseChannel: 'stable',
          url: 'http://127.0.0.1:3005',
          active: true,
        },
        {
          id: 'preview-local',
          releaseChannel: 'preview',
          url: 'http://127.0.0.1:3006',
          active: false,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'local_relay_off_channel_leftovers',
        warningCode: null,
        severity: 'info',
      }),
    ]);

    expect(buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      localRelays: [
        {
          id: 'preview-local',
          releaseChannel: 'preview',
          url: 'http://127.0.0.1:3006',
          active: false,
        },
      ],
    }).findings).toEqual([
      expect.objectContaining({
        kind: 'local_relay_lane_missing',
        actions: [],
        diagnostic: expect.stringContaining('preview'),
      }),
    ]);
  });

  it('treats dev local relay entries as current-channel for publicdev runtimes', () => {
    const report = buildServiceRepairReport({
      runtime: {
        ...runtime,
        channel: 'publicdev',
      },
      plan: {
        currentReleaseChannel: 'publicdev',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      localRelays: [
        {
          id: 'dev-local',
          releaseChannel: 'dev',
          url: 'http://127.0.0.1:3005',
          active: true,
        },
      ],
    });

    expect(report.findings).toEqual([]);
  });

  it('reports current-channel local relay version stale as guidance only', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      localRelays: [
        {
          id: 'stable-local',
          releaseChannel: 'stable',
          url: 'http://127.0.0.1:3005',
          active: true,
          installed: true,
          version: '1.0.0',
          expectedVersion: '1.1.0',
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'local_relay_version_stale',
        actions: [],
        diagnostic: expect.stringContaining('1.0.0'),
      }),
    ]);
  });

  it('reports running other-channel automatic startup as informational', () => {
    const report = buildServiceRepairReport({
      runtime,
      plan: {
        currentReleaseChannel: 'stable',
        existingServices: [],
        actions: [],
        manualWarnings: [],
      },
      warnings: [],
      discoveredServices: [
        {
          id: 'systemd-user:happier-daemon.preview.default',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.preview.default',
          targetMode: 'default-following',
          verification: 'verified',
          ring: 'preview',
          instanceId: 'default',
          scope: 'user',
          definitionPath: '/home/test/.config/systemd/user/happier-daemon.preview.default.service',
          executablePath: '/home/test/.happier/preview/happier',
          installed: true,
          running: true,
        },
      ],
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        kind: 'orphan_daemon_on_other_channel',
        warningCode: null,
        severity: 'info',
        targetMode: 'default-following',
        entry: expect.objectContaining({
          releaseChannel: 'preview',
          targetMode: 'default-following',
        }),
      }),
    ]);
  });
});
