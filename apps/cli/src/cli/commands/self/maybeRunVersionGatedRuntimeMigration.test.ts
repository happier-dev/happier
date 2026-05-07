import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockDaemonServiceListEntry = {
  serverId: string;
  name: string;
  installed: boolean;
  path: string;
  platform: string;
  mode: 'user' | 'system';
  releaseChannel: string;
  label: string;
  targetMode: string;
};

const {
  handleServiceRepairCliCommandMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
  resolveDaemonServiceListEntriesMock,
} = vi.hoisted(() => ({
  handleServiceRepairCliCommandMock: vi.fn(async (_params: unknown) => undefined),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn((_params?: unknown) => ({
    platform: 'linux',
    mode: 'user',
    systemUser: '',
    channel: 'preview',
    targetMode: 'default-following',
    instanceId: 'default',
    uid: 1000,
    userHomeDir: '/tmp/user',
    happierHomeDir: '/tmp/user/.happier',
    serverUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
  })),
  resolveDaemonServiceListEntriesMock: vi.fn<(_runtime: unknown, _options?: unknown) => Promise<MockDaemonServiceListEntry[]>>(async (_runtime: unknown, _options?: unknown) => []),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
  resolveDaemonServiceListEntries: (runtime: unknown, options?: unknown) => resolveDaemonServiceListEntriesMock(runtime, options),
}));

vi.mock('../serviceRepair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: (params: unknown) => handleServiceRepairCliCommandMock(params),
}));

describe('maybeRunVersionGatedRuntimeMigration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('treats legacy installs without version markers as crossing the 0.2.3 migration boundary', async () => {
    const { hasCrossedBackgroundServiceMigrationBoundary } = await import('./maybeRunVersionGatedRuntimeMigration');

    expect(hasCrossedBackgroundServiceMigrationBoundary({
      fromVersion: null,
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: true,
    })).toBe(true);

    expect(hasCrossedBackgroundServiceMigrationBoundary({
      fromVersion: null,
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
    })).toBe(false);
  });

  it('treats 0.2.3 prerelease builds as crossing the 0.2.3 migration boundary', async () => {
    const { hasCrossedBackgroundServiceMigrationBoundary } = await import('./maybeRunVersionGatedRuntimeMigration');

    expect(hasCrossedBackgroundServiceMigrationBoundary({
      fromVersion: '0.2.2',
      toVersion: '0.2.3-preview.1',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
    })).toBe(true);

    expect(hasCrossedBackgroundServiceMigrationBoundary({
      fromVersion: '0.2.2',
      toVersion: '0.2.3-dev.34.1',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
    })).toBe(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handleServiceRepairCliCommandMock.mockClear();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockClear();
    resolveDaemonServiceListEntriesMock.mockClear();
  });

  it('delegates to one aggregated repair pass when an update crosses the 0.2.3 migration boundary and repair work exists', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 1000,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'user') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/tmp/user/.config/systemd/user/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'user',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
      argv: ['repair'],
      commandPath: 'happier doctor',
    })).resolves.toBe(true);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).toHaveBeenCalled();
    expect(resolveDaemonServiceListEntriesMock).toHaveBeenCalled();
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--yes', '--mode', 'user'],
      commandPath: 'happier doctor',
    });
  });

  it('skips repair when the version change did not cross the migration boundary', async () => {
    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.3',
      toVersion: '0.2.4',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
      argv: ['repair'],
      commandPath: 'happier doctor',
    })).resolves.toBe(false);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).not.toHaveBeenCalled();
    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });

  it('skips automatic migration when aggregated repair would require system-mode actions without root', async () => {
    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
      argv: ['repair'],
      commandPath: 'happier doctor',
    })).resolves.toBe(false);

    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });

  it('aggregates user and system services into one repair invocation when root is available', async () => {
    const previousSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = 'developer';
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'default',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'default',
          name: 'Default background service',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.default.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'preview',
          label: 'happier-daemon.default',
          targetMode: 'default-following',
        }];
      }
      return [{
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/home/test/.config/systemd/user/happier-daemon.default.service',
        platform: 'linux',
        mode: 'user',
        releaseChannel: 'preview',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
        }];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
      })).resolves.toBe(true);
    } finally {
      if (previousSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = previousSudoUser;
      }
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledTimes(1);
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--yes', '--mode', 'system', '--system-user', 'developer'],
      commandPath: 'happier doctor',
    });
  });

  it('keeps system mode when the only migratable legacy service for the active server is system-scoped', async () => {
    const previousSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = 'developer';
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'stable',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
      })).resolves.toBe(true);
    } finally {
      if (previousSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = previousSudoUser;
      }
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--yes', '--mode', 'system', '--system-user', 'developer'],
      commandPath: 'happier doctor',
    });
  });

  it('adds --system-user when automatic system migration rewrites an existing --mode flag', async () => {
    const previousSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = 'developer';
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'stable',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair', '--mode', 'user'],
        commandPath: 'happier doctor',
      })).resolves.toBe(true);
    } finally {
      if (previousSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = previousSudoUser;
      }
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--mode', 'system', '--migrate', '--yes', '--system-user', 'developer'],
      commandPath: 'happier doctor',
    });
  });

  it('updates --system-user when automatic system migration rewrites an existing --mode= flag', async () => {
    const previousSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = 'developer';
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 0,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'stable',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair', '--mode=user', '--system-user=stale-user'],
        commandPath: 'happier doctor',
      })).resolves.toBe(true);
    } finally {
      if (previousSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = previousSudoUser;
      }
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--mode=system', '--system-user=developer', '--migrate', '--yes'],
      commandPath: 'happier doctor',
    });
  });

  it('skips automatic system migration when no system user can be resolved', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 0,
        userHomeDir: '/root',
        happierHomeDir: '/root/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'system') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/etc/systemd/system/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'system',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
      argv: ['repair'],
      commandPath: 'happier doctor',
    })).resolves.toBe(false);

    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      'Skipping automatic system background service migration because no system user could be resolved. Re-run manually with: sudo happier doctor repair --yes --mode system --system-user <user>',
    );
  });

  it('skips unsupported system-scoped migration passes on non-linux platforms', async () => {
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'darwin',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 501,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      return normalizedOptions?.mode === 'user'
        ? [{
            serverId: 'company',
            name: 'Company',
            installed: true,
            path: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.preview.company.plist',
            platform: 'darwin',
            mode: 'user',
            releaseChannel: 'preview',
            label: 'com.happier.cli.daemon.preview.company',
            targetMode: 'pinned',
          }]
        : [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    await expect(maybeRunVersionGatedRuntimeMigration({
      fromVersion: '0.2.2',
      toVersion: '0.2.3',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
      argv: ['repair'],
      commandPath: 'happier doctor',
    })).resolves.toBe(true);

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledTimes(1);
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--yes', '--mode', 'user'],
      commandPath: 'happier doctor',
    });
  });

  it('drops --yes and keeps --migrate when running in an interactive TTY', async () => {
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 1000,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'user') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/tmp/user/.config/systemd/user/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'user',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
      })).resolves.toBe(true);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
      (process.stdout as { isTTY?: boolean }).isTTY = originalStdoutIsTTY;
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--mode', 'user'],
      commandPath: 'happier doctor',
    });
  });

  it('forces --yes when forceNonInteractive is set even in a TTY', async () => {
    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((params?: unknown) => {
      const normalizedParams = params as { mode?: 'user' | 'system' } | undefined;
      return {
        platform: 'linux',
        mode: normalizedParams?.mode ?? 'user',
        systemUser: '',
        channel: 'preview',
        targetMode: 'default-following',
        instanceId: 'company',
        uid: 1000,
        userHomeDir: '/tmp/user',
        happierHomeDir: '/tmp/user/.happier',
        serverUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
      };
    });

    resolveDaemonServiceListEntriesMock.mockImplementation(async (_runtime: unknown, options?: unknown) => {
      const normalizedOptions = options as { mode?: 'user' | 'system' } | undefined;
      if (normalizedOptions?.mode === 'user') {
        return [{
          serverId: 'company',
          name: 'Company',
          installed: true,
          path: '/tmp/user/.config/systemd/user/happier-daemon.preview.company.service',
          platform: 'linux',
          mode: 'user',
          releaseChannel: 'preview',
          label: 'happier-daemon.preview.company',
          targetMode: 'pinned',
        }];
      }
      return [];
    });

    const { maybeRunVersionGatedRuntimeMigration } = await import('./maybeRunVersionGatedRuntimeMigration');

    try {
      await expect(maybeRunVersionGatedRuntimeMigration({
        fromVersion: '0.2.2',
        toVersion: '0.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
        forceNonInteractive: true,
      })).resolves.toBe(true);
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = originalStdinIsTTY;
      (process.stdout as { isTTY?: boolean }).isTTY = originalStdoutIsTTY;
    }

    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair', '--migrate', '--yes', '--mode', 'user'],
      commandPath: 'happier doctor',
    });
  });
});
