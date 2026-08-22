import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const sideEffectMock = vi.hoisted(() => vi.fn((name: string) => {
  throw new Error(`unexpected side effect: ${name}`);
}));

vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: vi.fn(async () => sideEffectMock('checkIfDaemonRunningAndCleanupStaleState')),
  inspectDaemonRunningStateAndCleanupStaleState: vi.fn(async () => sideEffectMock('inspectDaemonRunningStateAndCleanupStaleState')),
  listDaemonSessions: vi.fn(async () => sideEffectMock('listDaemonSessions')),
  stopDaemon: vi.fn(async () => sideEffectMock('stopDaemon')),
  stopDaemonSession: vi.fn(async () => sideEffectMock('stopDaemonSession')),
}));

vi.mock('@/daemon/startDaemon', () => ({
  startDaemon: vi.fn(async () => sideEffectMock('startDaemon')),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: vi.fn(() => ({
    platform: 'darwin',
    channel: 'stable',
    targetMode: 'pinned',
    instanceId: 'cloud',
  })),
  resolveDaemonServiceInstallationSnapshotFromEnv: vi.fn(async () => sideEffectMock('resolveDaemonServiceInstallationSnapshotFromEnv')),
  runDaemonServiceCliCommand: vi.fn(async () => sideEffectMock('runDaemonServiceCliCommand')),
}));

vi.mock('@/ui/logger', () => ({
  getLatestDaemonLog: vi.fn(async () => sideEffectMock('getLatestDaemonLog')),
}));

vi.mock('@/ui/doctor', () => ({
  runDoctorCommand: vi.fn(async () => sideEffectMock('runDoctorCommand')),
}));

vi.mock('@/daemon/multiDaemon', () => ({
  listDaemonStatusesForAllKnownServers: vi.fn(async () => sideEffectMock('listDaemonStatusesForAllKnownServers')),
  stopAllDaemonsBestEffort: vi.fn(async () => sideEffectMock('stopAllDaemonsBestEffort')),
}));

vi.mock('@/daemon/runtime/spawnDetachedDaemonStartSync', () => ({
  spawnDetachedDaemonStartSync: vi.fn(async () => sideEffectMock('spawnDetachedDaemonStartSync')),
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: vi.fn(async () => sideEffectMock('readStoredCredentials')),
  readSettings: vi.fn(async () => sideEffectMock('readSettings')),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://api.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    activeServerId: 'cloud',
  },
}));

vi.mock('@/cloud/decodeJwtPayload', () => ({
  decodeJwtPayload: vi.fn(() => sideEffectMock('decodeJwtPayload')),
}));

vi.mock('@/utils/readPositiveIntEnv', () => ({
  readPositiveIntEnv: vi.fn(() => sideEffectMock('readPositiveIntEnv')),
}));

vi.mock('@/daemon/waitForDaemonRunningWithinBudget', () => ({
  waitForDaemonRunningWithinBudget: vi.fn(async () => sideEffectMock('waitForDaemonRunningWithinBudget')),
}));

vi.mock('@/daemon/statusSnapshot', () => ({
  readDaemonStatusSnapshot: vi.fn(async () => sideEffectMock('readDaemonStatusSnapshot')),
}));

vi.mock('@/daemon/restartDaemonAndWait', () => ({
  restartDaemonAndWait: vi.fn(async () => sideEffectMock('restartDaemonAndWait')),
}));

vi.mock('./service/repair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: vi.fn(async () => sideEffectMock('handleServiceRepairCliCommand')),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
  evaluateCurrentDaemonOwner: vi.fn(async () => sideEffectMock('evaluateCurrentDaemonOwner')),
}));

vi.mock('@/daemon/ownership/renderDaemonOwnerConflict', () => ({
  renderDaemonOwnerConflict: vi.fn(() => ({ title: 'Conflict', lines: [] })),
}));

vi.mock('@/daemon/ownership/resolveDaemonTakeoverDecision', () => ({
  buildDaemonTakeoverNotice: vi.fn(() => ({ title: 'Takeover', lines: [] })),
  resolveDaemonTakeoverDecision: vi.fn(() => ({ kind: 'start' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
  evaluateDaemonStartupServiceConflict: vi.fn(async () => sideEffectMock('evaluateDaemonStartupServiceConflict')),
  renderDaemonInstalledServiceConflict: vi.fn(() => ({ title: 'Service conflict', lines: [] })),
}));

vi.mock('@/daemon/ownership/daemonOwnershipMetadata', () => ({
  isDaemonStartupSourceServiceManaged: vi.fn(() => false),
  resolveDaemonStartupSourceFromEnv: vi.fn(() => 'manual'),
}));

import { handleDaemonCliCommand } from './daemon';

describe('handleDaemonCliCommand help safety', () => {
  let consoleLogSpy: MockInstance<typeof console.log>;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    sideEffectMock.mockClear();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it.each([
    'start',
    'start-sync',
    'stop',
    'restart',
    'status',
    'list',
    'logs',
    'stop-session',
  ])('prints daemon %s help before command side effects', async (subcommand) => {
    await expect(handleDaemonCliCommand({
      args: ['daemon', subcommand, '--help'],
      rawArgv: [],
      terminalRuntime: null,
    })).resolves.toBeUndefined();

    expect(sideEffectMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
