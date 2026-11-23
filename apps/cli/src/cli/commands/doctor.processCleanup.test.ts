import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type { DaemonRunningInspection } from '@/daemon/controlClient';

const { inspect, execute, confirm } = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<DaemonRunningInspection>>(),
  execute: vi.fn(),
  confirm: vi.fn(async () => true),
}));
// Real process/HTTP control and terminal input are the boundaries. The doctor,
// canonical result schemas, and Action result handling stay real.
vi.mock('@/daemon/controlClient', () => ({
  inspectDaemonRunningStateAndCleanupStaleState: inspect,
  requestDaemonSignedRootActionExecution: execute,
  forceStopKnownDaemonPid: vi.fn(),
}));
vi.mock('@/terminal/prompts/promptConfirmYesNo', () => ({ promptConfirmYesNo: confirm }));
vi.mock('@/terminal/prompts/promptInput', () => ({ isInteractiveTerminal: () => true }));

import { handleDoctorCliCommand } from './doctor';

const answer = {
  v: 1, machineId: 'machine-1', capturedAtMs: 1, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [],
  leftBehind: [{ rowId: 'left', ref: 'echoed-ref', name: 'sleep', pid: 321, startedAtMs: 1, memoryBytes: 1024,
    memoryKind: 'rss', level: 'left_behind', owner: { kind: 'session', sessionId: 'ended-session' }, confirmedAtMs: 60001 }],
  totals: { happier: { memoryBytes: 1024, processCount: 1 }, leftBehind: { memoryBytes: 1024, processCount: 1 } },
} satisfies MachineProcessesAnswerV1;

describe('doctor confirmed process cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execute.mockReset(); confirm.mockReset(); inspect.mockReset();
    process.exitCode = 0;
  });

  it('echoes only the daemon-confirmed set through the normal Action after terminal confirmation', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    inspect.mockResolvedValue({ status: 'running', state: { pid: 123, httpPort: 4321, startedAt: 1, startedWithCliVersion: 'test' } });
    confirm.mockResolvedValue(true);
    execute.mockResolvedValueOnce({ ok: true, result: answer }).mockResolvedValueOnce({
      ok: true, result: { ended: [], skipped: [{ ref: 'echoed-ref', reason: 'identity_changed' }] },
    });

    await handleDoctorCliCommand({ args: ['doctor', 'clean'], rawArgv: [], terminalRuntime: null });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('1'), expect.objectContaining({ default: 'no' }));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      actionId: 'machines.processes.leftBehind.cleanUp', input: { machineId: 'machine-1', refs: ['echoed-ref'] }, surface: 'cli',
    }), expect.anything());
    expect(log.mock.calls.flat().join('\n')).toContain('1 skipped');
    expect(log.mock.calls.flat().join('\n')).toContain('identity_changed');
  });

  it('keeps an approval request distinct from a completed cleanup', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    inspect.mockResolvedValue({ status: 'running', state: { pid: 123, httpPort: 4321, startedAt: 1, startedWithCliVersion: 'test' } });
    confirm.mockResolvedValue(true);
    execute.mockResolvedValueOnce({ ok: true, result: answer }).mockResolvedValueOnce({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1' },
    });

    await handleDoctorCliCommand({ args: ['doctor', 'clean'], rawArgv: [], terminalRuntime: null });

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('approval requested: approval-1');
    expect(output).not.toContain('Cleaned up');
  });
});
