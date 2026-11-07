import { useMemo, useRef } from 'react';

import { triageEntryRowKey, type TriageListWindowV1 } from '../../projection/listWindow.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';

/** Publish only the selected source facts the relationship reader consumes. */
export function useTriageListSessionActivitySourcesV1(window: TriageListWindowV1 | null): ReadonlyMap<string, string> {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  return useMemo(() => {
    const selectedSources = new Map((window?.rows ?? []).flatMap((row) => {
      const selected = readTriageSelectedObservationV1(row);
      return selected === null ? [] : [[triageEntryRowKey(row.entryRef), selected.sourceInstanceId] as const];
    }));
    const baseline = previous.current;
    if (selectedSources.size === baseline.size
      && Array.from(selectedSources).every(([key, instanceId]) => baseline.get(key) === instanceId)) return baseline;
    previous.current = selectedSources;
    return selectedSources;
  }, [window]);
}
