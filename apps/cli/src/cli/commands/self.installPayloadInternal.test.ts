import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

const {
  installVersionedPayloadMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
} = vi.hoisted(() => ({
  installVersionedPayloadMock: vi.fn(async () => ({
    currentVersionId: '1.2.3' as string,
    previousVersionId: null as string | null,
    hadLegacyCurrentInstallWithoutVersionMarkers: false,
  })),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn<(params: unknown) => Promise<void>>(async () => undefined),
}));
const { maybeRunVersionGatedRuntimeMigrationMock } = vi.hoisted(() => ({
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn<(params: unknown) => Promise<boolean>>(async () => false),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    installVersionedPayload: installVersionedPayloadMock,
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
    vi.restoreAllMocks();
    vi.resetModules();
    maybeRunVersionGatedRuntimeMigrationMock.mockReset();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockReset();
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
        payloadRootAlreadyFiltered: true,
        processEnv: process.env,
        versionId: '1.2.3',
      });
      expect(quiesceInstalledCliWindowsPayloadOwnersMock).toHaveBeenCalledWith({
        channel: 'stable',
        processEnv: process.env,
      });
      expect(quiesceInstalledCliWindowsPayloadOwnersMock.mock.invocationCallOrder[0]).toBeLessThan(
        installVersionedPayloadMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
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
        payloadRootAlreadyFiltered: true,
        processEnv: process.env,
        versionId: '1.2.3-dev.4',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('triggers the version-gated runtime migration hook after promoting the managed CLI payload across the 0.2.3 boundary', async () => {
    installVersionedPayloadMock.mockResolvedValueOnce({
      currentVersionId: '0.2.3',
      previousVersionId: '0.2.2',
      hadLegacyCurrentInstallWithoutVersionMarkers: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '0.2.3'],
        rawArgv: ['happier', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '0.2.3'],
        terminalRuntime: null,
      });

      const installedPaths = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli',
        channel: 'stable',
        processEnv: process.env,
      });

      expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
        fromVersion: '0.2.2',
        hadLegacyCurrentInstallWithoutVersionMarkers: false,
        installedRuntimeNodePath: installedPaths.binaryPath,
        toVersion: '0.2.3',
        argv: ['repair'],
        commandPath: 'happier self migrate',
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('skips post-promotion runtime migration when the installer owns repair', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousSkipMigration = process.env.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION;
    process.env.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION = '1';

    try {
      const { handleSelfCliCommand } = await import('./self');
      await handleSelfCliCommand({
        args: ['self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-preview.4', '--channel', 'preview'],
        rawArgv: ['hprev', 'self', '__install-payload', '--component', 'happier-cli', '--payload-root', '/tmp/payload', '--version', '1.2.3-preview.4', '--channel', 'preview'],
        terminalRuntime: null,
      });

      expect(installVersionedPayloadMock).toHaveBeenCalledWith({
        channel: 'preview',
        componentId: 'happier-cli',
        payloadRoot: '/tmp/payload',
        payloadRootAlreadyFiltered: true,
        processEnv: process.env,
        versionId: '1.2.3-preview.4',
      });
      expect(maybeRunVersionGatedRuntimeMigrationMock).not.toHaveBeenCalled();
    } finally {
      if (previousSkipMigration === undefined) {
        delete process.env.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION;
      } else {
        process.env.HAPPIER_CLI_SKIP_INSTALL_PAYLOAD_MIGRATION = previousSkipMigration;
      }
      logSpy.mockRestore();
    }
  });
});
