import * as React from 'react';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readPublishedDaemonProjectionFamily } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
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
  authentication: Omit<AgentSignInStatusResponse, 'checkedAt'> | null;
  authenticationListeners: Set<() => void>;
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
    entry = { state: IDLE, accountLabel: null, authentication: null, authenticationListeners: new Set(), targets: new Set(), listeners: new Set(), timer: null,
      opening: null, checking: null, openAbort: null, probeAbort: null, terminalExited: false, terminalId: null };
    entries.set(key, entry);
  }
  return entry;
}
function currentTarget(entry: Entry): BoundTarget | null {
  return [...entry.targets].find((target) => target.lifetime.isCurrent()) ?? null;
}
function publish(entry: Entry, patch: Partial<MachineAgentSignInSession>, accountLabel = entry.accountLabel) {
  if (entry.accountLabel === accountLabel && Object.entries(patch).every(([key, value]) =>
    entry.state[key as keyof MachineAgentSignInSession] === value)) return;
  entry.accountLabel = accountLabel;
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
      const { checkedAt: _checkedAt, ...authentication } = result;
      const retained = retainDeep(entry.authentication, authentication);
      if (retained !== entry.authentication) {
        entry.authentication = retained;
        for (const listener of entry.authenticationListeners) listener();
      }
      const accountLabel = result.accountLabel ?? null;
      if (result.status === 'signedIn') {
        const wasSignedIn = entry.state.phase === 'signedIn';
        publish(entry, { phase: 'signedIn', failure: null }, accountLabel); stopPolling(entry);
        if (!wasSignedIn) fireAndForget(refreshMachineAgents({ serverId: target.serverId,
          machineId: target.machineId, accountLifetime: target.lifetime, force: true }), { tag: 'AgentSignIn.refreshInventory' });
      } else if (entry.state.terminalKey && !entry.terminalExited) {
        publish(entry, { phase: 'waiting', failure: null }, accountLabel);
      } else publish(entry, {}, accountLabel);
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
  entry.terminalExited = false;
  publish(entry, { phase: 'opening', terminalKey: machineAgentSignInTerminalKey(target.machineId, target.agentId),
    authUrl: null, startedAtMs: Date.now(), failure: null }, null);
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
  publish(entry, IDLE, null); entry.terminalExited = false;
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
  const subscribeScope = React.useCallback((listener: () => void) => {
    if (!entry || !boundTarget) return () => {};
    entry.authenticationListeners.add(listener);
    const retirement = boundTarget.lifetime.onRetire(listener);
    return () => { retirement.dispose(); entry.authenticationListeners.delete(listener); };
  }, [boundTarget, entry]);
  const readScope = React.useCallback(() => entry && boundTarget?.lifetime.isCurrent()
    ? entry.authentication?.signInScope ?? null : null, [boundTarget, entry]);
  const signInScope = React.useSyncExternalStore(subscribeScope, readScope, readScope);
  const executeIntent = React.useCallback(async (operation: 'start' | 'status' | 'cancel' | 'restart') => {
    if (!entry || !boundTarget?.lifetime.isCurrent()) return;
    // Cancel/restart address the daemon's acquired process, never a made-up terminal id.
    if ((operation === 'cancel' || operation === 'restart') && !entry.terminalId && entry.opening) await entry.opening;
    const terminalId = entry.terminalId;
    if (operation === 'cancel' && !terminalId) return;
    const actionOperation = !terminalId && (operation === 'restart' || operation === 'status' && entry.state.phase === 'failed') ? 'start' : operation;
    if (!boundTarget.lifetime.isCurrent()) return;
    const result = await execute(`machines.agents.signIn.${actionOperation}`, {
      machineId: boundTarget.machineId, agentId: boundTarget.agentId,
      ...(actionOperation === 'start' ? { method: 'native' } : {}),
      ...((actionOperation === 'cancel' || actionOperation === 'restart') ? { terminalId } : {}),
    });
    if (!result.ok && actionOperation === 'start' && boundTarget.lifetime.isCurrent() && !entry.terminalId) {
      stopPolling(entry);
      publish(entry, { phase: 'failed', failure: result.errorCode });
    }
    return result;
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
    available: Boolean(boundTarget?.lifetime.isCurrent()),
    accountLabel: entry?.accountLabel ?? null, signInScope, ...actions };
}

export type MachineCliSignInAuthentication = Omit<AgentSignInStatusResponse, 'checkedAt'>;

/** A CLI's declared connected-account launch (plan E U4): the qualified purpose its Account default is keyed by. */
export type MachineCliConnectedLaunch = Readonly<{
  purpose: Readonly<{ consumer: Readonly<{ pluginId: string; localId: string }>; purpose: string }>;
  service: Readonly<{ pluginId: string; localId: string }>;
}>;

export type MachineCliSignInRow = Readonly<{
  id: string;
  title: string;
  kind: 'agent' | 'systemTool';
  connectedLaunch?: MachineCliConnectedLaunch;
  authentication: MachineCliSignInAuthentication | null;
  signIn: MachineAgentSignInSession;
}>;
const EMPTY_CLI_SIGN_INS: readonly MachineCliSignInRow[] = Object.freeze([]);
type CliSignInsSnapshot = Readonly<{ items: readonly MachineCliSignInRow[]; pending: boolean }>;
const EMPTY_CLI_SIGN_INS_SNAPSHOT: CliSignInsSnapshot = Object.freeze({ items: EMPTY_CLI_SIGN_INS, pending: false });
const CLI_SIGN_IN_SECTIONS = ['agentsById', 'familiesById.systemTools'] as const;

/** A demanded Machine catalog, with state produced by the existing sign-in Actions and shared process owner. */
export function useMachineCliSignIns(target: Readonly<{
  serverId?: string | null; machineId: string | null; presented: boolean;
}>) {
  const activeServer = useActiveServerSnapshot(!target.serverId);
  const serverId = target.serverId?.trim() || activeServer.serverId;
  const { binding, execute } = useMountedActionExecution(serverId);
  const projection = useDaemonMergedProjectionInputs({ accountLifetime: binding, serverId, machineId: target.machineId,
    enabled: target.presented, sections: CLI_SIGN_IN_SECTIONS });
  const rows = React.useMemo(() => {
    const inputs = projection.inputs;
    if (!binding || !target.machineId || !inputs) return [];
    const agents = Object.entries(inputs.pluginProjectionV2?.agentsById ?? {}).map(([id, agent]) => ({
      id, title: agent.title ?? id, kind: 'agent' as const,
    }));
    const tools = Object.values(readPublishedDaemonProjectionFamily(inputs, 'systemTools')?.entriesById ?? {})
      .filter(tool => tool.definition.authentication)
      .map(tool => {
        const launch = tool.definition.connectedAccountLaunch;
        const service = !launch ? null : typeof launch.service === 'string'
          ? { pluginId: tool.pluginId, localId: launch.service } : launch.service;
        return { id: tool.id, title: resolvePluginLocalizedStringV2Text(tool.definition.title), kind: 'systemTool' as const,
          ...(launch && service ? { connectedLaunch: { service,
            purpose: { consumer: { pluginId: tool.pluginId, localId: tool.definition.id }, purpose: launch.purpose } } } : {}) };
      });
    return [...agents, ...tools].map(row => ({ ...row,
      entry: getEntry(serverAccountScopedResourceKey(binding.scope, 'agent-sign-in', target.machineId!, row.id)),
      boundTarget: { serverId, machineId: target.machineId!, agentId: row.id, lifetime: binding },
    }));
  }, [binding, projection.inputs, serverId, target.machineId]);
  const held = React.useRef<CliSignInsSnapshot>(EMPTY_CLI_SIGN_INS_SNAPSHOT);
  const subscribe = React.useCallback((listener: () => void) => {
    if (!target.presented || !binding) return () => {};
    for (const row of rows) {
      row.entry.targets.add(row.boundTarget);
      row.entry.listeners.add(listener); row.entry.authenticationListeners.add(listener);
      schedulePoll(row.entry);
    }
    const retirement = binding.onRetire(listener);
    return () => {
      retirement.dispose();
      for (const row of rows) {
        row.entry.targets.delete(row.boundTarget);
        row.entry.listeners.delete(listener); row.entry.authenticationListeners.delete(listener);
        if (!currentTarget(row.entry)) stopPolling(row.entry);
      }
    };
  }, [binding, rows, target.presented]);
  const read = React.useCallback(() => {
    if (!binding?.isCurrent()) return EMPTY_CLI_SIGN_INS_SNAPSHOT;
    const items = rows.map(({ entry, boundTarget: _boundTarget, ...row }) => ({ ...row,
      authentication: entry.authentication, signIn: entry.state,
    })).filter(row => row.authentication?.installed === true
      && (row.authentication.nativeLogin !== 'unsupported' || row.authentication.connectedServices.length > 0));
    // Settling an entirely absent catalog must still publish ready with no rows.
    const pending = rows.some(row => row.entry.authentication === null && row.entry.state.phase !== 'failed');
    return held.current = retainDeep(held.current, { items, pending });
  }, [binding, rows]);
  const snapshot = React.useSyncExternalStore(subscribe, read, read);
  const refresh = React.useCallback(async () => {
    if (!target.presented || !target.machineId || projection.phase !== 'ready') return;
    await Promise.all(rows.map(row => execute('machines.agents.signIn.status', { machineId: target.machineId, agentId: row.id })));
  }, [execute, projection.phase, rows, target.machineId, target.presented]);
  React.useEffect(() => { fireAndForget(refresh(), { tag: 'MachineCliSignIns.refresh' }); }, [refresh]);
  const startSignIn = React.useCallback((id: string, choice: Readonly<{ method: 'native' | 'connected'; serviceId?: string }>) =>
    execute('machines.agents.signIn.start', { machineId: target.machineId, agentId: id, ...choice }), [execute, target.machineId]);
  const phase = projection.phase === 'ready' && snapshot.pending ? 'loading' : projection.phase;
  return { phase, items: snapshot.items, refresh, start: startSignIn };
}
