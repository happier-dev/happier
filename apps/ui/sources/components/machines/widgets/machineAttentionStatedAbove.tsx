import * as React from 'react';

import { selectAttentionSubjects } from '@/components/machines/summary/machineResourceSentences';
import type { MachineAttentionEntry } from '@/components/machines/attention/collectMachineAttention';

const NONE: ReadonlySet<string> = new Set();
const StatedAboveContext = React.createContext<ReadonlySet<string>>(NONE);

const keyOf = (target: Readonly<{ serverId: string; machineId: string }>) => `${target.serverId}\u0000${target.machineId}`;

/**
 * A page that already states a machine's reason (the All machines "Needs you" list or grid cards) tells the
 * widgets below it, so a widget on one of those machines does not say the same sentence and offer the same
 * button again. Its entries come from that presentation's owner. Outside it (Home, a Board, a machine
 * page) nothing is stated above, and a widget carries its full attention block.
 */
export function MachineAttentionStatedAbove(props: Readonly<{ entries: readonly MachineAttentionEntry[]; children: React.ReactNode }>) {
  const stated = React.useMemo(
    () => new Set(selectAttentionSubjects(props.entries).map(keyOf)),
    [props.entries],
  );
  return <StatedAboveContext.Provider value={stated}>{props.children}</StatedAboveContext.Provider>;
}

export function useMachineAttentionStatedAbove(target: Readonly<{ serverId: string; machineId: string }>): boolean {
  return React.useContext(StatedAboveContext).has(keyOf(target));
}
