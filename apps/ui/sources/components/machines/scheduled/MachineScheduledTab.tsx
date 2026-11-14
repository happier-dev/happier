import * as React from 'react';

import type { MachinePageTabBodyProps } from '@/components/machines/page/machinePageTabQuery';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
  machineScheduledStore,
  type MachineScheduledKey,
  type MachineScheduledState,
} from '@/sync/domains/machines/scheduled/machineScheduledStore';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { MachineScheduledList } from './MachineScheduledList';

/** The visible row demand per step: the page chooses it (no daemon ceiling); Show more asks for the next step. */
const PAGE_ROWS = 40;
const LOADING: MachineScheduledState = Object.freeze({
  status: 'loading',
  snapshot: null,
});
const NO_SUBSCRIPTION = () => () => {};

/**
 * Machine → Scheduled: the Scheduled store's read for this Machine (machines.scheduled.list/watch), demanded only
 * while the tab is presented; file events push cron/launchd changes, Read again re-reads on demand. No polling.
 */
export function MachineScheduledTab(props: MachinePageTabBodyProps) {
  const serverId = resolveMachineDaemonReadServerId(props.serverId);
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const presented = useLayoutPresentationActive();
  const [pageSize, setPageSize] = React.useState(PAGE_ROWS);
  const key = React.useMemo<MachineScheduledKey | null>(
    () =>
      binding
        ? {
            serverId,
            machineId: props.machineId,
            pageSize,
            accountId: binding.accountId,
            credentialKey: binding.credentialKey,
          }
        : null,
    [binding, pageSize, props.machineId, serverId],
  );
  const observe = React.useMemo(
    () =>
      key
        ? (listener: () => void) => machineScheduledStore.observe(key, listener)
        : NO_SUBSCRIPTION,
    [key],
  );
  const state = React.useSyncExternalStore(observe, () =>
    key ? machineScheduledStore.getState(key) : LOADING,
  );
  React.useEffect(() => {
    if (!key || !presented) return;
    return machineScheduledStore.subscribe(key, () => {});
  }, [key, presented]);
  const refresh = React.useCallback(() => {
    if (key) void machineScheduledStore.refresh(key);
  }, [key]);
  const more = React.useCallback(
    () => setPageSize((rows) => rows + PAGE_ROWS),
    [],
  );
  return (
    <MachineScheduledList
      machineName={props.machineName}
      state={state}
      onRefresh={refresh}
      onMore={more}
    />
  );
}
