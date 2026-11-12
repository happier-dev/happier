import * as React from 'react';
import { getStorage } from '@/sync/domains/state/storageStore';
import { readMachineField, type MachineFieldContent } from './machineFieldRead';
import { subscribeMachineFields } from './machineFieldSubscription';

const EMPTY_PAGE: readonly never[] = Object.freeze([]);
const readEmptyPage = () => EMPTY_PAGE;
const noSubscription = () => () => {};

/** Caller supplies its visible page; no inventory walk or per-row subscription. */
export function useMachineFieldPage<Section extends keyof MachineFieldContent, Field extends keyof MachineFieldContent[Section]>(
  machineIds: readonly string[], section: Section, field: Field,
  options: Readonly<{ serverId: string; enabled: boolean }>,
): readonly (MachineFieldContent[Section][Field] | null)[] {
  const store = getStorage();
  const ids = React.useMemo(() => machineIds.map(id => id.trim()), [machineIds]);
  const serverId = options.serverId.trim();
  const snapshot = React.useMemo(() => {
    let previous: readonly (MachineFieldContent[Section][Field] | null)[] = EMPTY_PAGE;
    return () => {
      const state = store.getState();
      const next = ids.map(id => readMachineField(state, id, section, field, serverId));
      if (next.length === previous.length && next.every((value, index) => value === previous[index])) return previous;
      previous = next;
      return previous;
    };
  }, [store, ids, section, field, serverId]);
  const subscribe = React.useCallback((listener: () => void) => subscribeMachineFields(store, {
    machineIds: ids, serverId, fields: [{ section, field }],
  }, listener), [store, ids, serverId, section, field]);
  return React.useSyncExternalStore(options.enabled ? subscribe : noSubscription,
    options.enabled ? snapshot : readEmptyPage, options.enabled ? snapshot : readEmptyPage);
}
