import * as React from 'react';
import { EMPTY_MACHINE_PROCESSES_STATE, machineProcessesStore } from './machineProcessesStore';
import type { MachineProcessesKey } from './machineProcessesRpc';
import { useMachineDaemonReadTarget, useMachineDaemonRevisionObserver } from '../useMachineDaemonReadTarget';

export function useMachineProcesses(input: Omit<MachineProcessesKey, 'accountId'> & Readonly<{ enabled?: boolean; active?: boolean; online?: boolean | null }>) {
    const target = useMachineDaemonReadTarget({ ...input, observeDaemonStateVersion: false });
    const binding = target.accountBinding;
    const accountId = target.key.expectedAccountId ?? undefined;
    const active = target.enabled && input.active !== false;
    const key = React.useMemo(() => ({ machineId: input.machineId, serverId: target.key.serverId,
        scope: input.scope, view: input.view, accountId, ...(input.detailToken ? { detailToken: input.detailToken } : {}) }),
    [input.machineId, target.key.serverId, input.scope, input.view, input.detailToken, accountId]);
    const subscribe = React.useCallback((listener: () => void) => machineProcessesStore.observe(key, listener), [key]);
    const getSnapshot = React.useCallback(() => accountId ? machineProcessesStore.getState(key) : EMPTY_MACHINE_PROCESSES_STATE, [accountId, key]);
    const state = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useMachineDaemonRevisionObserver(target.key, React.useCallback(version => {
        machineProcessesStore.daemonStateChanged(key, version);
    }, [key]));
    React.useEffect(() => {
        if (!active || !binding) return;
        const release = machineProcessesStore.demand(key);
        const retirement = binding.onRetire(release);
        return () => { retirement.dispose(); release(); };
    }, [active, binding, key]);
    const retry = React.useCallback(() => { if (active) machineProcessesStore.retry(key); }, [active, key]);
    return React.useMemo(() => ({ ...state,
        status: target.offline && !state.answer ? 'unavailable' as const : state.status,
        active, paused: !active, retry, accountBinding: binding }), [active, retry, state, binding, target.offline]);
}
