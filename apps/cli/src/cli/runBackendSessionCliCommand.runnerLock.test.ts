import { describe, expect, it, vi } from 'vitest';

const acquireSessionRunnerLock = vi.fn(async () => ({ ok: false as const, reason: 'already_running' as const, heldByPid: 999 }));
const runSessionCommandSpy = vi.fn();

vi.mock('@/daemon/sessionRunnerLock', () => ({
  acquireSessionRunnerLock,
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(async () => ({ credentials: { token: 'x' } })),
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => ({ token: 'x' })),
  readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));

vi.mock('@/settings/accountSettings/bootstrapAccountSettingsContext', () => ({
  bootstrapAccountSettingsContext: vi.fn(async () => ({
    source: 'none',
    settings: {},
    settingsVersion: 0,
    loadedAtMs: Date.now(),
    whenRefreshed: null,
  })),
}));

describe('runBackendSessionCliCommand (session runner lock)', () => {
  it('exits when --existing-session is already running on this machine', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as any);

    const { runBackendSessionCliCommand } = await import('./runBackendSessionCliCommand');

    await expect(
      runBackendSessionCliCommand({
        context: { args: ['codex', '--existing-session', 'sess_1'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
        agentIdForAccountSettings: 'codex' as any,
      }),
    ).rejects.toThrow('exit:1');

    expect(acquireSessionRunnerLock).toHaveBeenCalledTimes(1);
    expect(runSessionCommandSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
