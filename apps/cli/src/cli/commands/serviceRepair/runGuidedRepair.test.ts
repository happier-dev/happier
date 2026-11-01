import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepairFinding, RunningDaemonCliMismatch } from '@/diagnostics/doctorRepair';

const {
  promptInputMock,
  spawnSyncMock,
} = vi.hoisted(() => ({
  promptInputMock: vi.fn(async () => ''),
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: spawnSyncMock,
}));

vi.mock('@/terminal/prompts/promptInput', () => ({
  promptInput: promptInputMock,
}));

function makeRunningDaemonCliMismatch(): RunningDaemonCliMismatch {
  return {
    kind: 'running_daemon_cli_mismatch',
    severity: 'warning',
    autoApplyWithoutPrompt: false,
    daemon: {
      serverId: 'default',
      pid: 4321,
      httpPort: 41234,
      startedBy: 'manual',
      startedWithReleaseChannel: 'dev',
      startedWithCliVersion: '0.11.9',
      matchesCurrentCli: false,
      staleStateFile: false,
    },
    currentCliReleaseChannel: 'dev',
    currentCliVersion: '0.12.0',
    driftKind: 'version-only',
    recoveryStrategy: 'daemon-takeover',
    serviceManagerName: null,
  };
}

describe('runGuidedRepair running daemon CLI mismatch repair', () => {
  afterEach(() => {
    promptInputMock.mockReset();
    promptInputMock.mockImplementation(async () => '');
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(() => ({ status: 0 }));
    vi.restoreAllMocks();
  });

  it('stops the stale repair walk after a successful self update', async () => {
    const { runGuidedRepair } = await import('./runGuidedRepair');
    const findings: RepairFinding[] = [{
      kind: 'cli_self_update_available', severity: 'info', autoApplyWithoutPrompt: false,
      releaseChannel: 'dev', currentVersion: '0.12.0', latestVersion: '0.12.1',
    }, makeRunningDaemonCliMismatch()];
    const applyOldPlan = await runGuidedRepair({
      findings, currentCli: { releaseChannel: 'dev', version: '0.12.0', invoker: 'hdev' },
    });
    expect(applyOldPlan).toBe(false);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['self', 'update', '--dev']), expect.any(Object));
  });

  it('keeps the default interactive answer on daemon restart only', async () => {
    const { runGuidedRepair } = await import('./runGuidedRepair');

    await runGuidedRepair({
      findings: [makeRunningDaemonCliMismatch()],
      currentCli: {
        releaseChannel: 'dev',
        version: '0.12.0',
        invoker: 'happier',
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      'daemon',
      'restart',
      '--takeover',
    ]), expect.any(Object));
    expect(spawnSyncMock).not.toHaveBeenCalledWith(
      expect.any(String), expect.arrayContaining(['--restart-session-runners']), expect.any(Object),
    );
  });

  it('can explicitly restart eligible session runners through the daemon restart command path', async () => {
    promptInputMock.mockResolvedValueOnce('r');
    const { runGuidedRepair } = await import('./runGuidedRepair');

    await runGuidedRepair({
      findings: [makeRunningDaemonCliMismatch()],
      currentCli: {
        releaseChannel: 'dev',
        version: '0.12.0',
        invoker: 'happier',
      },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      'daemon',
      'restart',
      '--takeover',
      '--restart-session-runners',
    ]), expect.any(Object));
  });
});
