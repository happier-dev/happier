import * as React from 'react';
import { useMachineDaemonReadTarget } from '../useMachineDaemonReadTarget';
import {
  EMPTY_MACHINE_RESOURCE_HISTORY_STATE,
  machineResourceStore,
} from './machineResourceStore';
import type { MachineVitalsRange } from './machineRpc';

type MachineDaemonReadTarget = ReturnType<typeof useMachineDaemonReadTarget>;

/**
 * One range of the daemon's vitals history, demanded only while `enabled` (the reader is presented and its
 * Machine answers). A `serviceId` reads that service's CPU and memory history beside the Machine's; the store
 * keeps one subscription per Machine, service and range, so a page and a widget never read it twice.
 */
export function useMachineVitalsHistory(
  target: MachineDaemonReadTarget,
  input: Readonly<{ range: MachineVitalsRange; serviceId?: string }>,
  enabled: boolean,
) {
  const historyKey = React.useMemo(
    () => ({
      ...target.key,
      range: input.range,
      ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
    }),
    [input.range, input.serviceId, target.key],
  );
  const subscribe = React.useCallback(
    (listener: () => void) =>
      machineResourceStore.observeHistory(historyKey, listener),
    [historyKey],
  );
  const getHistory = React.useCallback(
    () =>
      target.accountMatches
        ? machineResourceStore.getHistory(historyKey)
        : EMPTY_MACHINE_RESOURCE_HISTORY_STATE,
    [historyKey, target.accountMatches],
  );
  const state = React.useSyncExternalStore(subscribe, getHistory, getHistory);
  React.useEffect(() => {
    if (!enabled || !target.accountBinding) return;
    const release = machineResourceStore.demandHistory(historyKey);
    const retirement = target.accountBinding.onRetire(release);
    return () => {
      retirement.dispose();
      release();
    };
  }, [enabled, historyKey, target.accountBinding]);
  const retry = React.useCallback(() => {
    if (enabled) machineResourceStore.retryHistory(historyKey);
  }, [enabled, historyKey]);
  return { state, retry };
}

/**
 * A service's CPU and memory history on its Machine (service page), for the chosen range. It reads only while the
 * page is presented and the Machine answers; it starts no live vitals watch of its own.
 */
export function useMachineServiceUsageHistory(
  input: Readonly<{
    serverId: string;
    machineId: string;
    serviceId: string;
    range: MachineVitalsRange;
    enabled: boolean;
  }>,
) {
  const target = useMachineDaemonReadTarget({
    serverId: input.serverId,
    machineId: input.machineId,
    enabled: input.enabled,
  });
  const { state, retry } = useMachineVitalsHistory(
    target,
    { range: input.range, serviceId: input.serviceId },
    target.enabled,
  );
  return React.useMemo(
    () => ({ history: state.history, status: state.status, retry }),
    [retry, state],
  );
}
