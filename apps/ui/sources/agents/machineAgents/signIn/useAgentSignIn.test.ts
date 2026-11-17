import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { DaemonTerminalEnsureResponse } from '@happier-dev/protocol/daemon/terminal';
import { createServerScopedMachineRpcBoundaryMock } from '@/dev/testkit/mocks/serverScopedRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), confirm: vi.fn(), signedIn: false, cursor: 0 }));
// Instrument React's subscription entry point; every call still uses the real hook.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useSyncExternalStore: vi.fn(actual.useSyncExternalStore) };
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ spies: { confirm: boundary.confirm } }).module;
});
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
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () =>
  createServerScopedMachineRpcBoundaryMock(boundary.rpc));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const actualReact = await vi.importActual<typeof import('react')>('react');
const { useAgentSignIn, executeAgentSignInLifecycle } = await import('./useAgentSignIn');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
let serverId: string;

describe('shared Agent sign-in', () => {
  beforeEach(async () => {
    await home.reset();
    boundary.confirm.mockReset(); boundary.confirm.mockResolvedValue(true);
    serverId = await home.addHome({ name: 'Sign-in', serverUrl: 'https://fixture.invalid', accountId: 'fixture-account' });
  });
  afterEach(() => {
    standardCleanup(); vi.useRealTimers(); boundary.rpc.mockReset(); vi.restoreAllMocks();
    vi.mocked(React.useSyncExternalStore).mockImplementation(actualReact.useSyncExternalStore);
  });
  it('lists qualified Machine CLIs with daemon sign-in state only while presented and keeps connected choice in its owner', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    clearDaemonMergedProjectionCacheForTests();
    const { PLUGIN_MANIFEST: github } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
    const { PLUGIN_MANIFEST: onepassword } = await import('../../../../../../packages/plugins/onepassword/src/manifest');
    const tools = [github, onepassword].flatMap(manifest => manifest.contributes?.systemTools?.map(definition => ({
      id: `${manifest.id}/${definition.id}`, pluginId: manifest.id, pluginVersion: manifest.version, definition,
    })) ?? []);
    const toolId = 'happier.scm.forge.github/gh';
    const command = { operation: 'beginConnect', service: { pluginId: github.id, localId: 'github-account' }, modeId: 'token' };
    boundary.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: { agentId?: string; method?: string } }) => {
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
        protocolVersion: 1, projection: { v: 2, generation: 1,
          installedPackagesById: Object.fromEntries([github, onepassword].map(manifest => [manifest.id, {
            id: manifest.id, displayName: manifest.displayName, version: manifest.version, enabled: true,
            source: { kind: 'path', locator: `/plugins/${manifest.id}` }, occurrenceId: manifest.id,
          }])),
          agentsById: { 'acme/helper': { id: 'helper', title: 'Helper' } },
          familiesById: { systemTools: { family: 'systemTools', entriesById: Object.fromEntries(tools.map(tool => [tool.id, tool])) } },
        },
      };
      if (method === 'daemon.agents.signIn.status') return { status: payload.agentId === toolId ? 'signedIn' : 'signedOut',
        accountLabel: payload.agentId === toolId ? 'GitHub work' : null, checkedAt: Date.now(), nativeLogin: 'login_terminal',
        connectedServices: payload.agentId === toolId ? [{ serviceId: `${github.id}/github-account`, title: 'GitHub' }] : [] };
      if (method === 'daemon.agents.signIn.prepare') return payload.method === 'connected' ? { method: 'connected', command }
        : { method: 'native', launch: { kind: 'agent_login', agentId: payload.agentId } };
      if (method === 'daemon.connectedAccounts.authentication.command') return { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'machine-cli-login', reused: false };
      throw new Error(method);
    });
    // Known-good status control uses the same Home, RPC and daemon status body.
    const { checkAgentSignInRpc } = await import('./api');
    expect(await checkAgentSignInRpc({ serverId, machineId: 'cli-list' }, toolId)).toMatchObject({ status: 'signedIn' });
    boundary.rpc.mockClear();
    const { useMachineCliSignIns } = await import('./useAgentSignIn');
    const { flushHookEffects } = await import('@/dev/testkit');
    const mounted = await renderHook((props: { presented: boolean }) => useMachineCliSignIns({
      serverId, machineId: 'cli-list', presented: props.presented,
    }), { initialProps: { presented: false } });
    try {
      expect(boundary.rpc).not.toHaveBeenCalled();
      await mounted.rerender({ presented: true });
      for (let attempt = 0; attempt < 50 && mounted.getCurrent().phase !== 'ready'; attempt++) await flushHookEffects();
      expect(mounted.getCurrent()).toMatchObject({ phase: 'ready', items: expect.arrayContaining([
        expect.objectContaining({ id: 'acme/helper', kind: 'agent', authentication: expect.objectContaining({ status: 'signedOut' }) }),
        expect.objectContaining({ id: toolId, kind: 'systemTool', authentication: expect.objectContaining({ status: 'signedIn', accountLabel: 'GitHub work' }) }),
        expect.objectContaining({ id: 'happier.secret-source.onepassword/op', kind: 'systemTool', authentication: expect.objectContaining({ status: 'signedOut' }) }),
      ]) });
      expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toHaveLength(1);
      expect(boundary.rpc.mock.calls.filter(([request]) => request.method === 'daemon.agents.signIn.status')).toHaveLength(3);
      await act(async () => { await mounted.getCurrent().start(toolId, { method: 'connected', serviceId: `${github.id}/github-account` }); });
      expect(boundary.rpc.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
        method: 'daemon.agents.signIn.prepare', payload: { agentId: toolId, method: 'connected', serviceId: `${github.id}/github-account` },
      }));
      const beforeHide = boundary.rpc.mock.calls.length;
      await mounted.rerender({ presented: false });
      await flushHookEffects();
      expect(boundary.rpc.mock.calls).toHaveLength(beforeHide);
    } finally { await mounted.unmount(); clearDaemonMergedProjectionCacheForTests(); }
  });
  it('publishes no notifications for thirty equal waiting polls and publishes a real sign-in change', async () => {
    vi.useFakeTimers();
    let signedIn = false;
    let accountLabel: string | null = null;
    let statusReads = 0;
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'equal-polls-login', reused: false };
      if (method === 'daemon.agents.signIn.status') {
        statusReads++;
        return { status: signedIn ? 'signedIn' : 'signedOut', accountLabel,
          checkedAt: Date.now(), nativeLogin: 'login_terminal', connectedServices: [] };
      }
      throw new Error(`Unexpected fixture RPC ${method}`);
    });
    let notifications = 0;
    type Subscribe = (listener: () => void) => () => void;
    const observedSubscriptions = new WeakMap<Subscribe, Subscribe>();
    // Observe the real sign-in subscription without replacing its store or snapshot logic.
    vi.mocked(React.useSyncExternalStore).mockImplementation(function observeSignInSubscriptions<T>(
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => T,
      getServerSnapshot?: () => T,
    ): T {
      const snapshot = getSnapshot();
      const signInSnapshot = typeof snapshot === 'object' && snapshot !== null && 'terminalKey' in snapshot && 'phase' in snapshot;
      let observedSubscribe = observedSubscriptions.get(subscribe);
      if (signInSnapshot && !observedSubscribe) {
        observedSubscribe = (listener) => subscribe(() => { notifications++; listener(); });
        observedSubscriptions.set(subscribe, observedSubscribe);
      }
      return actualReact.useSyncExternalStore(observedSubscribe ?? subscribe, getSnapshot, getServerSnapshot);
    });
    const presenter = await renderHook(() => useAgentSignIn({ serverId, machineId: 'equal-polls', agentId: 'codex' }));
    await act(async () => { await presenter.getCurrent().start(); });
    const waiting = presenter.getCurrent().state;
    expect(notifications).toBeGreaterThan(0);
    notifications = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(statusReads).toBe(30);
    expect(notifications).toBe(0);
    expect(presenter.getCurrent().state).toBe(waiting);
    accountLabel = 'Work account';
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(notifications).toBe(1);
    expect(presenter.getCurrent().accountLabel).toBe('Work account');
    await act(async () => { presenter.getCurrent().reportTerminalUrl({ kind: 'auth', url: 'https://provider.example/first' }); });
    expect(notifications).toBe(2);
    expect(presenter.getCurrent().authUrl).toBe('https://provider.example/first');
    await act(async () => { presenter.getCurrent().reportTerminalUrl({ kind: 'auth', url: 'https://provider.example/first' }); });
    expect(notifications).toBe(2);
    await act(async () => { presenter.getCurrent().reportTerminalUrl({ kind: 'auth', url: 'https://provider.example/second' }); });
    expect(notifications).toBe(3);
    expect(presenter.getCurrent().authUrl).toBe('https://provider.example/second');
    signedIn = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(notifications).toBe(4);
    expect(presenter.getCurrent().state.phase).toBe('signedIn');
    await act(async () => { presenter.getCurrent().reportTerminalFailure('terminal_stream_unavailable'); });
    expect(notifications).toBe(5);
    expect(presenter.getCurrent().failure).toBe('terminal_stream_unavailable');
    await act(async () => { presenter.getCurrent().reportTerminalFailure('terminal_stream_closed'); });
    expect(notifications).toBe(6);
    expect(presenter.getCurrent().failure).toBe('terminal_stream_closed');
    await presenter.unmount();
  });
  it('requires verified sign-in after a terminal exits and keeps the terminal available to restart', async () => {
    vi.useFakeTimers();
    boundary.rpc.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
      if (method === 'daemon.terminal.ensure') return { ok: true, terminalId: 'unverified-login', reused: false };
      if (method === 'daemon.agents.signIn.status') return { status: 'signedOut', accountLabel: null,
        checkedAt: Date.now(), nativeLogin: 'login_terminal', connectedServices: [] };
      throw new Error(`Unexpected fixture RPC ${method}`);
    });
    const presenter = await renderHook(() => useAgentSignIn({ serverId, machineId: 'unverified-login', agentId: 'codex' }));
    await act(async () => { await presenter.getCurrent().start(); });
    await act(async () => { await presenter.getCurrent().reportTerminalExit('unverified-login'); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'failed', failure: 'agent_login_not_confirmed', terminalId: 'unverified-login' });
    await act(async () => { presenter.getCurrent().reportTerminalFailure('terminal_stream_unavailable'); });
    expect(presenter.getCurrent()).toMatchObject({ phase: 'failed', failure: 'terminal_stream_unavailable', terminalId: 'unverified-login' });
    const statusReads = boundary.rpc.mock.calls.filter(([request]) => request.method === 'daemon.agents.signIn.status').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(boundary.rpc.mock.calls.filter(([request]) => request.method === 'daemon.agents.signIn.status')).toHaveLength(statusReads);
    await presenter.unmount();
  });
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
    const target = { serverId, machineId: 'fixture-machine', agentId: 'codex' };
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
    const target = { serverId, machineId: 'action-lifecycle', agentId: 'codex' };
    const presenter = await renderHook(() => useAgentSignIn(target));
    await act(async () => { await presenter.getCurrent().start(); });
    const account = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
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
    const presenter = await renderHook(() => useAgentSignIn({ serverId, machineId: 'cleanup-retry', agentId: 'codex' }));
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
    const presenter = await renderHook(() => useAgentSignIn({ serverId, machineId: 'late-cleanup-retry', agentId: 'codex' }));
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
