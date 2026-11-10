import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

/**
 * The height each Usage widget body last settled at on this device, per occurrence and width, so a cold
 * first paint holds the room the body will fill instead of a generic skeleton that grows by hundreds of
 * pixels when the facts land (sweep 1110: Sources +992/+1669, Plan fit +722, Used first +631, Projections
 * +406). Observed geometry only: device-local, never synced, harmless when stale (the body follows its
 * drawn height once its reads settle).
 */
let storage: MMKV | null = null;
function store(): MMKV | null {
  if (storage) return storage;
  try {
    storage = new MMKV({ id: scopedStorageId('usage-body-heights', readStorageScopeFromEnv()) });
  } catch {
    storage = null;
  }
  return storage;
}

/** A width class rather than the exact width: a few pixels of resize keep the same remembered room. */
const WIDTH_STEP_PX = 40;

function heightKey(occurrence: string, width: number): string {
  // MMKV web rejects backslashes; occurrence ids are test ids and server ids.
  return `h:${encodeURIComponent(occurrence)}:${Math.round(width / WIDTH_STEP_PX)}`;
}

function readHeight(key: string): number | null {
  const value = store()?.getNumber(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * While the body's reads are outstanding it keeps at least the height it last settled at here; once they
 * settle it takes its drawn height (up or down, once) and that height is remembered for the next visit.
 * `onLayout` belongs on the view that carries `minHeight`: a settled body has no floor, so it measures its content.
 */
export function useUsageBodyHeightMemory(occurrence: string, width: number | undefined, settled: boolean): Readonly<{
  minHeight: number | undefined;
  onLayout: (event: LayoutChangeEvent) => void;
}> {
  const key = width === undefined || width <= 0 ? null : heightKey(occurrence, width);
  const remembered = React.useMemo(() => key === null ? null : readHeight(key), [key]);
  // The latest settled height this mount drew (else the remembered one); a later re-read holds this, not an older visit's.
  const written = React.useRef<Readonly<{ key: string | null; height: number | null }>>({ key, height: remembered });
  if (written.current.key !== key) written.current = { key, height: remembered };
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    if (!settled || key === null) return;
    const height = Math.ceil(event.nativeEvent.layout.height);
    if (!(height > 0) || written.current.key === key && written.current.height === height) return;
    written.current = { key, height };
    store()?.set(key, height);
  }, [settled, key]);
  const floor = written.current.height;
  return { minHeight: settled || floor === null ? undefined : floor, onLayout };
}

/**
 * How a body that owns its own reads (Sources' machines) tells the dispatch it has settled. The dispatch
 * decides it for query bodies from their slice; a body that never reports keeps its floor only until unmount.
 */
export const UsageBodySettledReportContext = React.createContext<((settled: boolean) => void) | null>(null);

export function useReportUsageBodySettled(settled: boolean): void {
  const report = React.useContext(UsageBodySettledReportContext);
  React.useEffect(() => { report?.(settled); }, [report, settled]);
}
