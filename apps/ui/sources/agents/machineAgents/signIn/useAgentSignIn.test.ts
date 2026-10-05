import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { DaemonTerminalEnsureResponse } from '@happier-dev/protocol';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), signedIn: false, cursor: 0 }));
// Unused HTTP boundary: fail loudly if sign-in ever invokes recipient-envelope work.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
  const unused = () => { throw new Error('Sign-in unexpectedly reached the recipient-envelope API'); };
  return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
    prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/sync/domains/server/serverProfiles', async (original) => {
  const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
  return createPartialServerProfilesModuleMock(original, { profiles: [{ id: 'fixture-server', serverUrl: 'https://fixture.invalid' }] });
});
vi.mock('@/auth/storage/tokenStorage', async (original) => {
  const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
  return createTokenStorageModuleMock({ importOriginal: original, tokenStorage: {
    getCredentialsForServerUrl: async () => ({ token: `header.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64')}.signature`,
      encryption: { type: 'legacy', secret: new Uint8Array(32) } }),
  } });
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () =>
  createServerScopedMachineRpcBoundaryMock(boundary.rpc));
vi.mock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false }));
import { useAgentSignIn, executeAgentSignInLifecycle } from './useAgentSignIn';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

describe('shared Agent sign-in', () => {
  afterEach(() => { standardCleanup(); vi.useRealTimers(); boundary.rpc.mockReset(); });
  it('uses the daemon terminal on web, shares auth URLs across presenters and keeps state across remounts', async () => {
    vi.useFakeTimers(); boundary.signedIn = false; boundary.cursor = 0;
    boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { cursor?: number } }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.agents.signIn.status') return { status: boundary.signedIn ? 'signedIn' : 'signedOut',
        accountLabel: null, checkedAt: Date.now(), nativeLogin: 'login_terminal', connectedServices: [] };
      if (method === 'daemon.terminal.close') return { ok: true };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'fixture-terminal', reused: false };
      if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId: 'fixture-terminal', terminalKey: 'provider-login:fixture-machine:codex', cwd: '/fixture', ended: false, exit: null }] };
      throw new Error(`Unexpected fixture RPC ${method}`);
    });
    const target = { serverId: 'fixture-server', machineId: 'fixture-machine', agentId: 'codex' };
    const first = await renderHook(() => useAgentSignIn(target));
    const second = await renderHook(() => useAgentSignIn(target));
    await act(async () => { await first.getCurrent().start(); });
    expect(first.getCurrent().state.phase).toBe('waiting');
    await act(async () => {
      first.getCurrent().reportTerminalUrl({ kind: 'generic', url: 'https://example.invalid/not-auth' });
      first.getCurrent().reportTerminalUrl({ kind: 'auth', url: 'https://example.invalid/auth' });
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(second.getCurrent().authUrl).toBe('https://example.invalid/auth');
    const startedAt = first.getCurrent().startedAtMs;
    await first.unmount(); await second.unmount();
    const remounted = await renderHook(() => useAgentSignIn(target));
    expect(remounted.getCurrent().startedAtMs).toBe(startedAt);
    expect(remounted.getCurrent().state.phase).toBe('waiting');
    boundary.signedIn = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(remounted.getCurrent().phase).toBe('signedIn');
    expect(remounted.getCurrent().terminalId).toBe('fixture-terminal');
    expect(boundary.rpc.mock.calls.map(([request]) => request.method)).not.toContain('daemon.terminal.streamRead');
    await act(async () => { await remounted.getCurrent().cancel(); });
    expect(remounted.getCurrent().phase).toBe('idle');
    await remounted.unmount();
  });

  it('shares Action restart and cancel with mounted custody and refuses a stale acquired identity', async () => {
    vi.useFakeTimers();
    let process = 'first-login';
    const closed: string[] = [];
    boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { terminalId?: string } }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: process, reused: false };
      if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId: process, terminalKey: 'provider-login:action-lifecycle:codex', cwd: '/fixture', ended: false, exit: null }] };
      if (method === 'daemon.terminal.close') { closed.push(payload.terminalId!); process = 'second-login'; return { ok: true }; }
      throw new Error(method);
    });
    const target = { serverId: 'fixture-server', machineId: 'action-lifecycle', agentId: 'codex' };
    const presenter = await renderHook(() => useAgentSignIn(target));
    await act(async () => { await presenter.getCurrent().start(); });
    const account = await renderHook(() => useServerCredentialAccountScopeBinding('fixture-server'));
    const lifetime = account.getCurrent().binding!;
    await act(async () => { expect(await executeAgentSignInLifecycle({ ...target, lifetime }, 'restart', 'first-login')).toMatchObject({ terminalId: 'second-login' }); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'waiting', terminalId: 'second-login' });
    await act(async () => { expect(await executeAgentSignInLifecycle({ ...target, lifetime }, 'cancel', 'first-login')).toMatchObject({ ok: false, errorCode: 'sign_in_terminal_changed' }); });
    expect(presenter.getCurrent().phase).toBe('waiting');
    expect(closed).toEqual(['first-login']);
    await act(async () => { expect(await executeAgentSignInLifecycle({ ...target, lifetime }, 'cancel', 'second-login')).toEqual({ ok: true }); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'idle', terminalId: null });
    await account.unmount();
    expect(await executeAgentSignInLifecycle({ ...target, lifetime }, 'restart', 'second-login')).toMatchObject({ ok: false });
    expect(closed).toEqual(['first-login', 'second-login']);
    await presenter.unmount();
  });

  it('keeps acquired custody visible after cleanup transport fails and lets Cancel retry', async () => {
    vi.useFakeTimers();
    let disconnected = true;
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'retained-login', reused: false };
      if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId: 'retained-login', terminalKey: 'provider-login:cleanup-retry:codex', cwd: '/fixture', ended: false, exit: null }] };
      if (method === 'daemon.terminal.close') { if (disconnected) throw new Error('transport_disconnected'); return { ok: true }; }
      throw new Error(method);
    });
    const presenter = await renderHook(() => useAgentSignIn({ serverId: 'fixture-server', machineId: 'cleanup-retry', agentId: 'codex' }));
    await act(async () => { await presenter.getCurrent().start(); });
    await act(async () => { await expect(presenter.getCurrent().cancel()).resolves.toMatchObject({ ok: false }); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'failed', terminalId: 'retained-login', failure: 'transport_disconnected' });
    disconnected = false;
    await act(async () => { await presenter.getCurrent().cancel(); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'idle', terminalId: null });
    await presenter.unmount();
  });

  it('retains a late acquisition when Cancel cleanup fails and retries its exact process', async () => {
    vi.useFakeTimers();
    const ensure = createDeferred<DaemonTerminalEnsureResponse>();
    let disconnected = true;
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return ensure.promise;
      if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId: 'late-retained-login', terminalKey: 'provider-login:late-cleanup-retry:codex', cwd: '/fixture', ended: false, exit: null }] };
      if (method === 'daemon.terminal.close') { if (disconnected) throw new Error('late_cleanup_disconnected'); return { ok: true }; }
      throw new Error(method);
    });
    const presenter = await renderHook(() => useAgentSignIn({ serverId: 'fixture-server', machineId: 'late-cleanup-retry', agentId: 'codex' }));
    let started!: Promise<unknown>;
    await act(async () => { started = presenter.getCurrent().start().catch((error: unknown) => error); });
    await act(async () => {
      const cancelled = presenter.getCurrent().cancel();
      ensure.resolve({ ok: true, terminalId: 'late-retained-login', reused: false });
      await expect(cancelled).resolves.toMatchObject({ ok: false });
      await started;
    });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'failed', terminalId: 'late-retained-login', failure: 'late_cleanup_disconnected' });
    disconnected = false;
    await act(async () => { await presenter.getCurrent().cancel(); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'idle', terminalId: null });
    await presenter.unmount();
  });
});
