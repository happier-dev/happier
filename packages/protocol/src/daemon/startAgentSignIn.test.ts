import { describe, expect, it, vi } from 'vitest';
import { startMachineAgentSignIn } from './startAgentSignIn.js';
import type { DaemonTerminalEnsureResponse } from './terminal.js';

describe('native machine Agent sign-in execution', () => {
  function boundary() {
    return {
      prepare: vi.fn(async () => ({ method: 'native', launch: { kind: 'agent_login', agentId: 'fixture/agent' } })),
      beginConnect: vi.fn(async () => ({ status: 'unavailable' as const, code: 'connected_account_daemon_runtime_unavailable' as const })),
      ensureTerminal: vi.fn(async (): Promise<DaemonTerminalEnsureResponse> => ({ ok: true, terminalId: 'terminal', reused: false })),
      closeTerminal: vi.fn(async () => ({ ok: true as const })),
    };
  }

  it('launches or reuses the daemon terminal before returning success without a renderer', async () => {
    const operations = boundary();
    expect(await startMachineAgentSignIn({ machineId: 'machine', agentId: 'fixture/agent' }, operations))
      .toEqual({ terminalKey: 'provider-login:machine:fixture/agent', terminalId: 'terminal' });
    expect(operations.ensureTerminal).toHaveBeenCalledWith({
      terminalKey: 'provider-login:machine:fixture/agent', launch: { kind: 'agent_login', agentId: 'fixture/agent' },
    });
    operations.ensureTerminal.mockResolvedValueOnce({ ok: true, terminalId: 'terminal', reused: true });
    expect(await startMachineAgentSignIn({ machineId: 'machine', agentId: 'fixture/agent' }, operations))
      .toEqual({ terminalKey: 'provider-login:machine:fixture/agent', terminalId: 'terminal' });
    expect(operations.closeTerminal).not.toHaveBeenCalled();
  });

  it('returns terminal launch failure instead of a prepared key', async () => {
    const operations = boundary();
    const failure = { ok: false as const, errorCode: 'terminal_spawn_failed' as const, error: 'Fixture spawn failed' };
    operations.ensureTerminal.mockResolvedValueOnce(failure);
    expect(await startMachineAgentSignIn({ machineId: 'machine', agentId: 'fixture/agent' }, operations)).toEqual(failure);
  });

  it('retains a late terminal result until explicit cancellation closes it', async () => {
    const operations = boundary();
    const abort = new AbortController();
    let finishEnsure!: (result: DaemonTerminalEnsureResponse) => void;
    operations.ensureTerminal.mockImplementationOnce(() => new Promise((resolve) => { finishEnsure = resolve; }));
    const opening = startMachineAgentSignIn({ machineId: 'machine', agentId: 'fixture/agent' }, { ...operations, signal: abort.signal });
    await vi.waitFor(() => expect(operations.ensureTerminal).toHaveBeenCalled());
    abort.abort();
    finishEnsure({ ok: true, terminalId: 'late-terminal', reused: false });
    expect(await opening).toMatchObject({ ok: false, errorCode: 'sign_in_cancelled' });
    expect(operations.closeTerminal).toHaveBeenCalledWith('late-terminal');
  });
});
