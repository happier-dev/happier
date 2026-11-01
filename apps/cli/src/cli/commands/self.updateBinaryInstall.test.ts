import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS } from '@happier-dev/cli-common/firstPartyRuntime';
import type { ManagedCliUpdateParams, ManagedCliUpdateResult } from '@happier-dev/cli-common/firstPartyRuntime';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdout } from '@/testkit/logger/captureOutput';

/**
 * `self update` wires the CLI's own owners into the one update transaction (`runManagedCliUpdate`,
 * proven at its owner in cli-common): the channel, the smoke's version reader, the Windows
 * quiesce and the service restart planned from the daemon owner observed before the update. The
 * transaction is replaced here by a stand-in that exercises the hooks it is handed.
 */
const {
  maybeRunDoctorRepairMock,
  maybeRunVersionGatedRuntimeMigrationMock,
  quiesceInstalledCliWindowsPayloadOwnersMock,
  runManagedCliUpdateMock,
  resolveFirstPartyComponentReleaseMock,
} = vi.hoisted(() => ({
  maybeRunDoctorRepairMock: vi.fn(async (_params: unknown) => false),
  maybeRunVersionGatedRuntimeMigrationMock: vi.fn(async (_params: unknown) => false),
  quiesceInstalledCliWindowsPayloadOwnersMock: vi.fn(async (_params: unknown) => undefined),
  runManagedCliUpdateMock: vi.fn(async (params: ManagedCliUpdateParams): Promise<ManagedCliUpdateResult> => {
    params.onAdmitted?.();
    await params.beforeActivate?.();
    await params.restartServiceDaemon?.({ expectedVersion: '9.9.10', phase: 'activated' });
    return { outcome: 'succeeded', previousVersion: '9.9.9', targetVersion: '9.9.10', restarted: params.restartServiceDaemon !== null, changed: true };
  }),
  resolveFirstPartyComponentReleaseMock: vi.fn(async () => ({ versionId: '9.9.10' })),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>();
  return {
    ...actual,
    runManagedCliUpdate: (params: ManagedCliUpdateParams) => runManagedCliUpdateMock(params),
    resolveFirstPartyComponentRelease: resolveFirstPartyComponentReleaseMock,
  };
});

vi.mock('./self/maybeRunVersionGatedRuntimeMigration', () => ({
  maybeRunVersionGatedRuntimeMigration: (params: unknown) => maybeRunVersionGatedRuntimeMigrationMock(params),
}));

vi.mock('./self/maybeRunDoctorRepair', () => ({
  maybeRunDoctorRepair: (params: unknown) => maybeRunDoctorRepairMock(params),
}));

vi.mock('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners')>(),
  quiesceInstalledCliWindowsPayloadOwners: (params: unknown) => quiesceInstalledCliWindowsPayloadOwnersMock(params),
}));

async function runSelfUpdate(params: Readonly<{ invokedPath: string; rawArgv: string[] }>): Promise<Readonly<{ logs: string }>> {
  const originalArgv = [...process.argv];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.argv[1] = params.invokedPath;
    const { handleSelfCliCommand } = await import('./self');
    await handleSelfCliCommand({
      args: ['self', 'update', ...params.rawArgv.slice(3)],
      rawArgv: params.rawArgv,
      terminalRuntime: null,
    });
    return { logs: logSpy.mock.calls.flat().join('\n') };
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
  }
}

describe('happier self update for binary installs', () => {
  const envScope = createEnvKeyScope([...STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS, 'HAPPIER_HOME_DIR']);
  let homeDir = '';

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'happier-self-update-'));
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
      HAPPIER_RELEASE_RING: undefined,
      HAPPIER_RELEASE_CHANNEL: undefined,
    });
  });

  afterEach(() => {
    maybeRunDoctorRepairMock.mockClear();
    maybeRunVersionGatedRuntimeMigrationMock.mockClear();
    quiesceInstalledCliWindowsPayloadOwnersMock.mockClear();
    runManagedCliUpdateMock.mockClear();
    envScope.restore();
    rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('runs the one update transaction for the channel, with no restart when no service daemon runs', async () => {
    const { logs } = await runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });

    expect(runManagedCliUpdateMock).toHaveBeenCalledTimes(1);
    const params = runManagedCliUpdateMock.mock.calls[0]![0];
    expect(params).toMatchObject({ channel: 'stable', targetVersion: undefined, restartServiceDaemon: null });
    expect(params.processEnv?.HAPPIER_HOME_DIR).toBe(homeDir);
    // The Windows quiesce is a pre-activation step only on Windows.
    expect(params.beforeActivate === undefined).toBe(process.platform !== 'win32');
    expect(logs).toContain('Updated happier to 9.9.10');
    expect(maybeRunVersionGatedRuntimeMigrationMock).toHaveBeenCalledWith({
      fromVersion: '9.9.9',
      toVersion: '9.9.10',
      argv: ['repair'],
      commandPath: 'happier doctor',
    });
    expect(maybeRunDoctorRepairMock).toHaveBeenCalledWith({ migrationRan: false, channel: 'stable' });
  });

  it('binds an exact --to version to the transaction', async () => {
    await runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update', '--to', 'v0.2.12'] });
    expect(runManagedCliUpdateMock.mock.calls[0]![0]).toMatchObject({ channel: 'stable', targetVersion: '0.2.12' });
  });

  it('defaults binary self update to the publicdev ring when invoked through hdev', async () => {
    await runSelfUpdate({ invokedPath: '/opt/happier/bin/hdev', rawArgv: ['hdev', 'self', 'update'] });
    expect(runManagedCliUpdateMock.mock.calls[0]![0]).toMatchObject({ channel: 'publicdev' });
  });

  it('uses the raw hdev invoker when the packaged process argv path is generic', async () => {
    const { logs } = await runSelfUpdate({ invokedPath: 'self', rawArgv: ['hdev', 'self', 'update'] });
    expect(runManagedCliUpdateMock.mock.calls[0]![0]).toMatchObject({ channel: 'publicdev' });
    expect(logs).toContain('Updated hdev to');
  });

  it('uses the persisted default channel for the unsuffixed happier invoker', async () => {
    writeFileSync(join(homeDir, 'default-cli-release-channel.json'), `${JSON.stringify({ releaseChannel: 'publicdev' })}\n`, 'utf8');
    const { logs } = await runSelfUpdate({ invokedPath: 'self', rawArgv: ['happier', 'self', 'update'] });
    expect(runManagedCliUpdateMock.mock.calls[0]![0]).toMatchObject({ channel: 'publicdev' });
    expect(logs).toContain('Updated hdev to');
  });

  it('defaults binary self update to the publicdev ring when invoked from the managed cli-dev current path', async () => {
    await runSelfUpdate({ invokedPath: '/Users/test/.happier/cli-dev/current/happier', rawArgv: ['hdev', 'self', 'update'] });
    expect(runManagedCliUpdateMock.mock.calls[0]![0]).toMatchObject({ channel: 'publicdev' });
  });

  it('prints the update steps', async () => {
    const stdout = captureStdout();
    try {
      await runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });
      expect(stdout.text()).toContain('Downloading, verifying and installing');
      expect(stdout.text()).toContain('Refreshing update cache');
    } finally {
      stdout.restore();
    }
  });

  it('fails with the transaction\'s message when the update was rolled back', async () => {
    runManagedCliUpdateMock.mockImplementationOnce(async () => ({
      outcome: 'rolledBack',
      previousVersion: '9.9.9',
      targetVersion: '9.9.10',
      message: 'Happier CLI 9.9.10 did not start on this machine (boom); 9.9.9 was restored.',
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] })).rejects.toThrow('exit 1');
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('9.9.9 was restored');
    expect(maybeRunVersionGatedRuntimeMigrationMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('leaves a Homebrew install to Homebrew and names its update command', async () => {
    const { logs } = await runSelfUpdate({
      invokedPath: '/opt/homebrew/Cellar/happier/0.2.12/bin/happier',
      rawArgv: ['happier', 'self', 'update'],
    });
    expect(runManagedCliUpdateMock).not.toHaveBeenCalled();
    expect(logs).toContain('brew upgrade happier');
  });

  it('recognises the Homebrew keg from the compiled binary path when argv only names the embedded bundle', async () => {
    // Load the runtime asset owner before replacing the executable boundary with a nonexistent keg.
    await import('./self');
    // A Bun-compiled `happier` reports `argv[1]` as `/$bunfs/root/happier`; only `execPath` (the
    // resolved executable) says where the payload was installed.
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', {
      value: '/opt/homebrew/Cellar/happier/0.2.12/libexec/happier',
      configurable: true,
      writable: true,
    });
    try {
      const { logs } = await runSelfUpdate({
        invokedPath: '/$bunfs/root/happier',
        rawArgv: ['happier', 'self', 'update'],
      });
      expect(runManagedCliUpdateMock).not.toHaveBeenCalled();
      expect(logs).toContain('brew upgrade happier');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true });
    }
  });

  it('reports admission — or the refusal — to the daemon that started it on the admission pipe', async () => {
    const { FirstPartyPayloadMutationLockError } = await import('@happier-dev/cli-common/firstPartyRuntime');
    const { UPDATER_ADMISSION_FD_ENV } = await import('@/cli/runtime/update/updaterAdmission');
    const reportPath = join(homeDir, 'admission');

    process.env[UPDATER_ADMISSION_FD_ENV] = String(openSync(reportPath, 'w'));
    await runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] });
    expect(readFileSync(reportPath, 'utf8')).toBe('{"admitted":true}\n');

    runManagedCliUpdateMock.mockImplementationOnce(async () => {
      throw new FirstPartyPayloadMutationLockError({ subject: 'x', holderPid: 42, lockfilePath: '/x.lock' });
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[UPDATER_ADMISSION_FD_ENV] = String(openSync(reportPath, 'w'));
    await expect(runSelfUpdate({ invokedPath: '/opt/happier/bin/happier', rawArgv: ['happier', 'self', 'update'] })).rejects.toThrow('exit 1');
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ admitted: false, code: 'cli_update_in_progress' });
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
