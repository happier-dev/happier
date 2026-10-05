import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundary = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
// The external machine transport is the only substituted boundary.
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: boundary.callMachineRpc,
}));
import { createCliActionDeps } from './createCliActionDeps';

describe('CLI machine terminal Action', () => {
  beforeEach(() => boundary.callMachineRpc.mockReset());
  it('searches workspace content through the exact machine transport with cancellation', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    const signal = new AbortController().signal;
    const page = { ok: true, files: [], hasMore: false, coverage: 'complete' };
    boundary.callMachineRpc.mockResolvedValueOnce(page);
    expect(await executor.execute('workspace.files.search', { machineId: 'machine', rootPath: '/project', query: 'needle' },
      { surface: 'cli', serverId: 'home', signal })).toEqual({ ok: true, result: page });
    expect(boundary.callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({
      machineId: 'machine', method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
      request: { rootPath: '/project', query: 'needle' }, signal,
    }));
    expect(await executor.execute('workspace.files.search', { machineId: 'machine', rootPath: '/project', query: 'needle' },
      { surface: 'cli', serverId: 'other' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(boundary.callMachineRpc).toHaveBeenCalledTimes(1);
  });
  it('lists through the authenticated exact-machine transport and rejects unavailable credentials', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }));
    boundary.callMachineRpc.mockResolvedValueOnce({ ok: true, terminals: [] });
    expect(await executor.execute('machines.terminal.list', { machineId: 'machine' }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
      .toEqual({ ok: true, result: { ok: true, terminals: [] } });
    expect(boundary.callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine', method: 'daemon.terminal.list', request: {} }));
    const restricted = createActionExecutor(createCliActionDeps({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null }));
    expect(await restricted.execute('machines.terminal.list', { machineId: 'other' }, { surface: 'cli', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'terminal_transport_unavailable' });
  });
  it('opens the canonical PTY and preserves the exact Home and request', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const executor = createActionExecutor({ ...createCliActionDeps({ token: credentials.token, credentials,
      sessionId: 'session', serverId: 'home', serverHttpBaseUrl: 'https://home.invalid', mode: 'plain', ctx: null }) });
    boundary.callMachineRpc.mockResolvedValueOnce({ ok: true, terminalId: 'pty', reused: true });
    expect(await executor.execute('machines.terminal.open', { machineId: 'machine', terminalKey: 'shell', cwd: '/project' }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', presentUserConfirmation: { actionId: 'machines.terminal.open' },
    })).toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: true } });
    expect(boundary.callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_TERMINAL_ENSURE,
      machineId: 'machine', request: { terminalKey: 'shell', cwd: '/project' } }));
  });
  it('refuses another unauthenticated machine instead of borrowing a direct transport', async () => {
    const invoke = vi.fn(async () => ({ ok: true, terminalId: 'pty', reused: false }));
    const executor = createActionExecutor({ ...createCliActionDeps({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'exact', invoke } }) });
    expect(await executor.execute('machines.terminal.open', { machineId: 'other', terminalKey: 'shell' }, { surface: 'cli', authority: 'present_user', presentUserConfirmation: { actionId: 'machines.terminal.open' } }))
      .toMatchObject({ ok: false, errorCode: 'terminal_transport_unavailable' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
