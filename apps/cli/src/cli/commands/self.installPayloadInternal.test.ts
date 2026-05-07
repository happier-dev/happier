import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  installVersionedPayloadMock,
  maybeRunVersionGatedRuntimeMigrationMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
  resolveInstalledFirstPartyComponentPathsMock,
  migrationEnvSnapshots,
} = vi.hoisted(() => ({
  installVersionedPayloadMock: vi.fn(async () => ({
    currentVersionId: '1.2.3',
    previousVersionId: null,
    hadLegacyCurrentInstallWithoutVersionMarkers: false,
  })),
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn(async (_params: unknown) => {
    migrationEnvSnapshots.push({
      HAPPIER_DAEMON_SERVICE_CHANNEL: process.env.HAPPIER_DAEMON_SERVICE_CHANNEL,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL,
      HAPPIER_DAEMON_SERVICE_NODE_PATH: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH,
      HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH,
    });
    return false;
  }),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn(async (_params: unknown) => undefined),
  resolveInstalledFirstPartyComponentPathsMock: vi.fn(() => ({
    installRoot: '/home/test/.happier/cli-preview',
    currentPath: '/home/test/.happier/cli-preview/current',
    previousPath: '/home/test/.happier/cli-preview/previous',
    versionsDir: '/home/test/.happier/cli-preview/versions',
    binaryPath: '/home/test/.happier/cli-preview/current/happier',
    nodeEntrypointPath: '/home/test/.happier/cli-preview/current/package-dist/index.mjs',
    shimPaths: ['/home/test/.happier/bin/hprev'],
  })),
  migrationEnvSnapshots: [] as Array<Record<string, string | undefined>>,
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    installVersionedPayload: installVersionedPayloadMock,
    resolveInstalledFirstPartyComponentPaths: resolveInstalledFirstPartyComponentPathsMock,
  };
});

vi.mock('./self/maybeRunVersionGatedRuntimeMigration', () => ({
  maybeRunVersionGatedRuntimeMigration: (params: unknown) => maybeRunVersionGatedRuntimeMigrationMock(params),
}));

vi.mock('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners', () => ({
  quiesceInstalledCliWindowsPayloadOwners: (params: unknown) => quiesceInstalledCliWindowsPayloadOwnersMock(params),
}));

describe('happier self __install-payload', () => {
  afterEach(() => {
    maybeRunVersionGatedRuntimeMigrationMock.mockReset();
    maybeRunVersionGatedRuntimeMigrationMock.mockImplementation(async (_params: unknown) => {
      migrationEnvSnapshots.push({
        HAPPIER_DAEMON_SERVICE_CHANNEL: process.env.HAPPIER_DAEMON_SERVICE_CHANNEL,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL,
        HAPPIER_DAEMON_SERVICE_NODE_PATH: process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH,
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH,
      });
      return false;
    });
    quiesceInstalledCliWindowsPayloadOwnersMock.mockReset();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockImplementation(async (_params: unknown) => undefined);
    resolveInstalledFirstPartyComponentPathsMock.mockReset();
    resolveInstalledFirstPartyComponentPathsMock.mockReturnValue({
      installRoot: '/home/test/.happier/cli-preview',
      currentPath: '/home/test/.happier/cli-preview/current',
      previousPath: '/home/test/.happier/cli-preview/previous',
      versionsDir: '/home/test/.happier/cli-preview/versions',
      binaryPath: '/home/test/.happier/cli-preview/current/happier',
      nodeEntrypointPath: '/home/test/.happier/cli-preview/current/package-dist/index.mjs',
      shimPaths: ['/home/test/.happier/bin/hprev'],
    });
    migrationEnvSnapshots.length = 0;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('promotes an extracted first-party payload through the shared runtime installer', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3'],
        rawArgv: ['happier', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3'],
        terminalRuntime: null,
      });

      expect(installVersionedPayloadMock).toHaveBeenCalledWith({
        channel: 'stable',
        componentId: 'happier-cli',
        payloadRoot: '/tmp/payload',
        processEnv: process.env,
        versionId: '1.2.3',
      });
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'stable',
        processEnv: process.env,
      });
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
        fromVersion: null,
        toVersion: '1.2.3',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        argv: ['repair'],
        commandPath: 'happier doctor',
        forceNonInteractive: true,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('forwards the publicdev release ring when payload promotion is scoped to the dev lane', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-dev.4', '--channel', 'publicdev'],
        rawArgv: ['hdev', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-dev.4', '--channel', 'publicdev'],
        terminalRuntime: null,
      });

      expect(installVersionedPayloadMock).toHaveBeenCalledWith({
        channel: 'publicdev',
        componentId: 'happier-cli',
        payloadRoot: '/tmp/payload',
        processEnv: process.env,
        versionId: '1.2.3-dev.4',
      });
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'publicdev',
        processEnv: process.env,
      });
      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('runs migration against the installed preview runtime instead of the staged payload context', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousChannel = process.env.HAPPIER_DAEMON_SERVICE_CHANNEL;
    const previousPublicReleaseChannel = process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
    const previousNodePath = process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH;
    const previousEntryPath = process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH;
    process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = 'stable';
    process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = 'stable';
    process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = '/old/runtime';
    process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH = '/old/entry';

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-preview.4', '--channel', 'preview'],
        rawArgv: ['hprev', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-preview.4', '--channel', 'preview'],
        terminalRuntime: null,
      });

      expect(migrationEnvSnapshots).toContainEqual({
        HAPPIER_DAEMON_SERVICE_CHANNEL: 'preview',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
        HAPPIER_DAEMON_SERVICE_NODE_PATH: '/home/test/.happier/cli-preview/current/happier',
        HAPPIER_DAEMON_SERVICE_ENTRY_PATH: '',
      });
      expect(process.env.HAPPIER_DAEMON_SERVICE_CHANNEL).toBe('stable');
      expect(process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('stable');
      expect(process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH).toBe('/old/runtime');
      expect(process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH).toBe('/old/entry');
    } finally {
      if (previousChannel === undefined) {
        delete process.env.HAPPIER_DAEMON_SERVICE_CHANNEL;
      } else {
        process.env.HAPPIER_DAEMON_SERVICE_CHANNEL = previousChannel;
      }
      if (previousPublicReleaseChannel === undefined) {
        delete process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL;
      } else {
        process.env.HAPPIER_PUBLIC_RELEASE_CHANNEL = previousPublicReleaseChannel;
      }
      if (previousNodePath === undefined) {
        delete process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH;
      } else {
        process.env.HAPPIER_DAEMON_SERVICE_NODE_PATH = previousNodePath;
      }
      if (previousEntryPath === undefined) {
        delete process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH;
      } else {
        process.env.HAPPIER_DAEMON_SERVICE_ENTRY_PATH = previousEntryPath;
      }
      logSpy.mockRestore();
    }
  });
});
