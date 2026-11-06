import * as React from 'react';
import { machineAgentSignInTerminalKey, type AgentSignInStatusResponse, type MachinesAgentsSignInStartOutput, type MachinesAgentsSignInCancelOutput } from '@happier-dev/protocol/daemon/agentSignIn';
import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol/daemon/terminal';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { replaceTerminalSurfaceState, createEmptyTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { refreshMachineAgents } from '../useMachineAgents';
import type { MachineAgentSignInSession } from '../machineAgentTypes';
import { startAgentSignInRpc, checkAgentSignInRpc, cancelAgentSignInRpc } from './api';

// A progress cadence, not a deadline. Stop with no observers, on success or exit.
const SIGN_IN_POLL_INTERVAL_MS = 2_000;
const IDLE: MachineAgentSignInSession = Object.freeze({ phase: 'idle', terminalKey: null, authUrl: null, startedAtMs: null, failure: null });
type BoundTarget = Readonly<{ serverId: string; machineId: string; agentId: string; lifetime: ServerAccountScopeLifetime }>;
type Entry = {
  state: MachineAgentSignInSession; accountLabel: string | null;
  targets: Set<BoundTarget>; listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  opening: Promise<MachinesAgentsSignInStartOutput | undefined> | null; checking: Promise<AgentSignInStatusResponse | null> | null;
  openAbort: AbortController | null; probeAbort: AbortController | null;
  terminalExited: boolean;
  terminalId: string | null;
};
const entries = new Map<string, Entry>();
function getEntry(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { state: IDLE, accountLabel: null, targets: new Set(), listeners: new Set(), timer: null,
      opening: null, checking: null, openAbort: null, probeAbort: null, terminalExited: false, terminalId: null };
    entries.set(key, entry);
  }
  return entry;
}
function currentTarget(entry: Entry): BoundTarget | null {
  return [...entry.targets].find((target) => target.lifetime.isCurrent()) ?? null;
}
function publish(entry: Entry, patch: Partial<MachineAgentSignInSession>) {
  entry.state = { ...entry.state, ...patch };
  for (const listener of entry.listeners) listener();
}
function stopPolling(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null; entry.probeAbort?.abort();
}
function schedulePoll(entry: Entry) {
  if (entry.timer || entry.state.phase !== 'waiting' || !currentTarget(entry)) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    fireAndForget(checkAgain(entry).finally(() => schedulePoll(entry)), { tag: 'AgentSignIn.poll' });
  }, SIGN_IN_POLL_INTERVAL_MS);
}
function checkAgain(entry: Entry, requestedTarget?: BoundTarget, signal?: AbortSignal): Promise<AgentSignInStatusResponse | null> {
  if (entry.checking) return entry.checking;
  const target = requestedTarget ?? currentTarget(entry);
  if (!target) return Promise.resolve(null);
  const abort = new AbortController(); entry.probeAbort = abort;
  const retire = target.lifetime.onRetire(() => abort.abort());
  const abortFromSignal = () => abort.abort();
  signal?.addEventListener('abort', abortFromSignal, { once: true });
  if (signal?.aborted) abort.abort();
  const checking = (async () => {
    try {
      const result = await checkAgentSignInRpc({ ...target, signal: abort.signal }, target.agentId);
      if (abort.signal.aborted || !target.lifetime.isCurrent()) return null;
      entry.accountLabel = result.accountLabel ?? null;
      if (result.status === 'signedIn') {
        const wasSignedIn = entry.state.phase === 'signedIn';
        publish(entry, { phase: 'signedIn', failure: null }); stopPolling(entry);
        if (!wasSignedIn) fireAndForget(refreshMachineAgents({ serverId: target.serverId,
          machineId: target.machineId, accountLifetime: target.lifetime, force: true }), { tag: 'AgentSignIn.refreshInventory' });
      } else if (entry.state.terminalKey && !entry.terminalExited) {
        publish(entry, { phase: 'waiting', failure: null });
      }
      return result;
    } catch (error) {
      if (!abort.signal.aborted && target.lifetime.isCurrent()) {
        publish(entry, { phase: 'failed', failure: error instanceof Error ? error.message : 'sign_in_status_unavailable' }); stopPolling(entry);
      }
      return null;
    } finally {
      retire.dispose(); signal?.removeEventListener('abort', abortFromSignal);
      if (entry.probeAbort === abort) entry.probeAbort = null;
      entry.checking = null;
    }
  })();
  entry.checking = checking; return checking;
}
async function start(entry: Entry, requestedTarget?: BoundTarget, signal?: AbortSignal) {
  if (entry.opening) return await entry.opening;
  if (entry.state.phase === 'waiting' && entry.terminalId && entry.state.terminalKey) return { terminalKey: entry.state.terminalKey, terminalId: entry.terminalId };
  const target = requestedTarget ?? currentTarget(entry); if (!target?.lifetime.isCurrent()) return;
  const abort = new AbortController(); entry.openAbort = abort;
  // A presenter unmount is non-owning; only an Action's request lifetime aborts its acquisition.
  const retire = requestedTarget?.lifetime.onRetire(() => abort.abort());
  const abortFromSignal = () => abort.abort();
  signal?.addEventListener('abort', abortFromSignal, { once: true });
  if (signal?.aborted) abort.abort();
  entry.terminalExited = false; entry.accountLabel = null;
  publish(entry, { phase: 'opening', terminalKey: machineAgentSignInTerminalKey(target.machineId, target.agentId),
    authUrl: null, startedAtMs: Date.now(), failure: null });
  const opening = (async () => {
    try {
      const result = await startAgentSignInRpc({ ...target, signal: abort.signal }, { agentId: target.agentId, method: 'native' }, (terminalId) => {
        entry.terminalId = terminalId;
      });
      if (abort.signal.aborted) {
        if (entry.terminalId && 'errorCode' in result) throw new Error(result.errorCode);
        if (target.lifetime.isCurrent()) publish(entry, IDLE);
        return result;
      }
      if (!target.lifetime.isCurrent()) return;
      if ('terminalKey' in result) {
        publish(entry, { phase: 'waiting', terminalKey: result.terminalKey }); schedulePoll(entry);
      } else publish(entry, { phase: 'failed', failure: 'errorCode' in result ? result.errorCode : 'agent_login_unsupported' });
      return result;
    } catch (error) {
      if (abort.signal.aborted && entry.terminalId) throw error;
      if (!abort.signal.aborted && target.lifetime.isCurrent()) publish(entry, {
        phase: 'failed', failure: error instanceof Error ? error.message : 'sign_in_unavailable',
      });
    } finally { retire?.dispose(); signal?.removeEventListener('abort', abortFromSignal); entry.opening = null; if (entry.openAbort === abort) entry.openAbort = null; }
  })();
  entry.opening = opening; return await opening;
}
async function cancel(entry: Entry, requestedTarget?: BoundTarget, acquiredTerminalId?: string, signal?: AbortSignal) {
  const target = requestedTarget ?? currentTarget(entry);
  if (!target?.lifetime.isCurrent()) return { ok: false as const, errorCode: 'sign_in_unavailable', error: 'Sign-in Account is unavailable.' };
  if (acquiredTerminalId && entry.terminalId && acquiredTerminalId !== entry.terminalId) {
    return { ok: false as const, errorCode: 'sign_in_terminal_changed', error: 'The acquired sign-in terminal is no longer current.' };
  }
  entry.openAbort?.abort(); stopPolling(entry);
  const key = entry.state.terminalKey;
  publish(entry, IDLE); entry.accountLabel = null; entry.terminalExited = false;
  try {
    await entry.opening;
    const terminalId = entry.terminalId ?? acquiredTerminalId;
    if (terminalId && target.lifetime.isCurrent()) {
      const abort = new AbortController();
      const retire = target.lifetime.onRetire(() => abort.abort());
      const abortFromSignal = () => abort.abort();
      signal?.addEventListener('abort', abortFromSignal, { once: true });
      if (signal?.aborted) abort.abort();
      const closed = await cancelAgentSignInRpc({ ...target, signal: abort.signal }, target.agentId, terminalId)
        .finally(() => { retire.dispose(); signal?.removeEventListener('abort', abortFromSignal); });
      if (!closed.ok) {
        if (target.lifetime.isCurrent()) publish(entry, { phase: 'failed', terminalKey: key ?? machineAgentSignInTerminalKey(target.machineId, target.agentId), failure: closed.error ?? closed.errorCode });
        return closed;
      }
      if (key) replaceTerminalSurfaceState(key, createEmptyTerminalSurfaceState());
    }
    entry.terminalId = null;
    return { ok: true as const };
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'sign_in_unavailable';
    if (target.lifetime.isCurrent() && entry.terminalId) publish(entry, {
      phase: 'failed', terminalKey: key ?? machineAgentSignInTerminalKey(target.machineId, target.agentId), failure,
    });
    return { ok: false as const, errorCode: 'sign_in_unavailable', error: failure };
  }
}

/** Admitted Actions and passive presenters consume the same Account-scoped process custody and state. */
type LifecycleTarget = Readonly<{ serverId: string; machineId: string; agentId: string; lifetime: ServerAccountScopeLifetime; signal?: AbortSignal }>;
export function executeAgentSignInLifecycle(target: LifecycleTarget, operation: 'cancel', terminalId: string): Promise<MachinesAgentsSignInCancelOutput>;
export function executeAgentSignInLifecycle(target: LifecycleTarget, operation: 'start' | 'restart', terminalId?: string): Promise<MachinesAgentsSignInStartOutput>;
export function executeAgentSignInLifecycle(target: LifecycleTarget, operation: 'status'): Promise<AgentSignInStatusResponse>;
export async function executeAgentSignInLifecycle(
  target: LifecycleTarget,
  operation: 'start' | 'cancel' | 'restart' | 'status',
  terminalId?: string,
): Promise<MachinesAgentsSignInStartOutput | MachinesAgentsSignInCancelOutput | AgentSignInStatusResponse> {
  if (!target.lifetime.isCurrent() || target.lifetime.scope.serverId !== target.serverId) {
    if (operation === 'status') throw new Error('sign_in_unavailable');
    return { ok: false, errorCode: 'sign_in_unavailable', error: 'Sign-in Account is unavailable.' };
  }
  const entry = getEntry(serverAccountScopedResourceKey(target.lifetime.scope, 'agent-sign-in', target.machineId, target.agentId));
  entry.targets.add(target);
  try {
    if (operation === 'status') {
      const result = await checkAgain(entry, target, target.signal);
      if (!result) throw new Error(entry.state.failure ?? 'sign_in_status_unavailable');
      schedulePoll(entry);
      return result;
    }
    if (operation !== 'start') {
      const closed = await cancel(entry, target, terminalId, target.signal);
      if (!closed.ok || operation === 'cancel') return closed;
    }
    return await start(entry, target, target.signal) ?? { ok: false, errorCode: 'sign_in_unavailable', error: 'Sign-in did not start.' };
  } finally {
    entry.targets.delete(target);
    if (!currentTarget(entry)) stopPolling(entry);
  }
}

export function useAgentSignIn(target: Readonly<{ serverId?: string | null; machineId: string | null; agentId: string }>) {
  const activeServer = useActiveServerSnapshot(!target.serverId);
  const serverId = target.serverId?.trim() || activeServer.serverId;
  const { binding, execute } = useMountedActionExecution(serverId);
  const boundTarget = React.useMemo<BoundTarget | null>(() => binding?.isCurrent() && target.machineId
    ? { serverId: binding.scope.serverId, machineId: target.machineId, agentId: target.agentId, lifetime: binding } : null,
  [binding, serverId, target.machineId, target.agentId]);
  const key = boundTarget ? serverAccountScopedResourceKey(boundTarget.lifetime.scope, 'agent-sign-in', boundTarget.machineId, boundTarget.agentId) : null;
  const entry = React.useMemo(() => key ? getEntry(key) : null, [key]);
  const subscribe = React.useCallback((listener: () => void) => {
    if (!entry || !boundTarget) return () => {};
    entry.listeners.add(listener); entry.targets.add(boundTarget);
    const retirement = boundTarget.lifetime.onRetire(() => { if (!currentTarget(entry)) stopPolling(entry); listener(); });
    schedulePoll(entry);
    return () => {
      retirement.dispose(); entry.listeners.delete(listener); entry.targets.delete(boundTarget);
      if (!currentTarget(entry)) stopPolling(entry);
    };
  }, [boundTarget, entry]);
  const read = React.useCallback(() => entry && boundTarget?.lifetime.isCurrent() ? entry.state : IDLE, [boundTarget, entry]);
  const state: MachineAgentSignInSession = React.useSyncExternalStore(subscribe, read, read);
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (state.phase !== 'waiting' && state.phase !== 'opening') return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state.phase, state.startedAtMs]);
  const executeIntent = React.useCallback(async (operation: 'start' | 'status' | 'cancel' | 'restart') => {
    if (!entry || !boundTarget?.lifetime.isCurrent()) return;
    // Cancel/restart address the daemon's acquired process, never a made-up terminal id.
    if ((operation === 'cancel' || operation === 'restart') && !entry.terminalId && entry.opening) await entry.opening;
    const terminalId = entry.terminalId;
    if (operation === 'cancel' && !terminalId) return;
    const actionOperation = operation === 'restart' && !terminalId ? 'start' : operation;
    if (!boundTarget.lifetime.isCurrent()) return;
    return await execute(`machines.agents.signIn.${actionOperation}`, {
      machineId: boundTarget.machineId, agentId: boundTarget.agentId,
      ...(actionOperation === 'start' ? { method: 'native' } : {}),
      ...((actionOperation === 'cancel' || actionOperation === 'restart') ? { terminalId } : {}),
    });
  }, [boundTarget, entry, execute]);
  const actions = React.useMemo(() => ({
    start: () => executeIntent('start'),
    checkAgain: () => executeIntent('status'),
    cancel: () => executeIntent('cancel'),
    restart: () => executeIntent('restart'),
    reportTerminalUrl: (event: Pick<DaemonTerminalStreamEventUrl, 'kind' | 'url'> | null) => {
      if (entry && boundTarget?.lifetime.isCurrent() && event?.kind === 'auth' && entry.state.terminalKey) publish(entry, { authUrl: event.url });
    },
    reportTerminalExit: async (terminalId: string) => {
      if (!entry || !boundTarget?.lifetime.isCurrent() || !entry.state.terminalKey || entry.terminalId !== terminalId) return;
      entry.terminalExited = true; stopPolling(entry); await entry.checking;
      if (!entry.state.terminalKey || !boundTarget.lifetime.isCurrent() || entry.terminalId !== terminalId) return;
      const result = await checkAgain(entry);
      if (boundTarget.lifetime.isCurrent() && entry.state.terminalKey && entry.terminalId === terminalId && result?.status !== 'signedIn') {
        publish(entry, { phase: 'failed', failure: entry.state.failure ?? 'agent_login_not_confirmed' });
      }
    },
    reportTerminalFailure: (failure: string) => {
      if (entry && boundTarget?.lifetime.isCurrent() && entry.state.terminalKey) { stopPolling(entry); publish(entry, { phase: 'failed', failure }); }
    },
  }), [boundTarget, entry, executeIntent]);
  return { ...state, state, terminalId: state.terminalKey ? entry?.terminalId ?? null : null,
    available: Boolean(boundTarget?.lifetime.isCurrent()), elapsedMs: state.startedAtMs === null ? 0 : Math.max(0, now - state.startedAtMs),
    accountLabel: entry?.accountLabel ?? null, ...actions };
}
