import * as React from 'react';
import { useWindowDimensions, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { MMKV } from 'react-native-mmkv';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

/**
 * The height each Usage widget body last drew its facts at on this device, per occurrence and layout class, so a cold
 * first paint holds the room the body will fill instead of a generic skeleton that grows by hundreds of pixels when
 * the facts land (sweep 1110: Sources +992/+1669, Plan fit +722, Used first +631, How you work +715). Observed geometry
 * only: device-local, never synced, harmless when stale (the body takes its drawn height once its reads settle).
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

/**
 * The layout class is known on the very first render (the window and the body's declared footprint), never from a
 * measured box, so the remembered room applies in the first frame instead of one layout later (N3b).
 */
function useLayoutClass(): string {
  const windowWidth = useWindowDimensions().width;
  const footprint = useWidgetPresentation()?.footprint;
  return `${Math.round(windowWidth / WIDTH_STEP_PX)}:${footprint ? `${footprint.columnSpan}/${footprint.columns}` : '-'}`;
}

function useHeightKey(occurrence: string): string {
  return `h:${encodeURIComponent(occurrence)}:${useLayoutClass()}`;
}

/** One Usage body occurrence: the body and the web host's loading fallback name it the same way. */
export function usageBodyOccurrence(serverId: string, testID: string): string {
  return `${serverId}:${testID}`;
}

/**
 * The room a body last drew, for the web host's fallback while the body's code loads: without it the frame drew a
 * generic loader and grew once the body mounted inside its remembered room (#6: 223 → 2048 px at 390).
 */
export function useUsageBodyRememberedHeight(occurrence: string): number | null {
  const key = useHeightKey(occurrence);
  return React.useMemo(() => readHeight(key), [key]);
}

function readHeight(key: string): number | null {
  const value = store()?.getNumber(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * - `facts`: the body draws admitted facts (not a reading placeholder). Only such a drawn height is remembered, and it
 *   is remembered whether or not every read settles: bodies whose pull-request or branch reads never finish still
 *   keep their room (N3a).
 * - `settled`: every read the body waits on has answered; it then takes its own drawn height.
 *
 * Before facts, the body holds exactly the remembered room (a taller placeholder never pushes the page, a shorter one
 * never lets it collapse); with facts but reads outstanding, the room is a floor. `onLayout` belongs on the view that
 * carries the style.
 */
export function useUsageBodyHeightMemory(occurrence: string, state: Readonly<{ facts: boolean; settled: boolean }>): Readonly<{
  style: ViewStyle | undefined;
  onLayout: (event: LayoutChangeEvent) => void;
}> {
  const key = useHeightKey(occurrence);
  const remembered = React.useMemo(() => readHeight(key), [key]);
  const written = React.useRef<Readonly<{ key: string; height: number | null }>>({ key, height: remembered });
  const { facts, settled } = state;
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    if (!facts) return;
    const height = Math.ceil(event.nativeEvent.layout.height);
    if (!(height > 0) || written.current.key === key && written.current.height === height) return;
    written.current = { key, height };
    store()?.set(key, height);
  }, [facts, key]);
  const style = React.useMemo((): ViewStyle | undefined => remembered === null || settled ? undefined
    : facts ? { minHeight: remembered } : { height: remembered, overflow: 'hidden' }, [remembered, settled, facts]);
  return { style, onLayout };
}

/**
 * How a body that owns its own reads (Sources' machines) tells the dispatch what it shows. The dispatch decides it for
 * query bodies from their slice; a body that never reports keeps the remembered room until unmount.
 */
export type UsageBodyReadState = Readonly<{ facts: boolean; settled: boolean }>;
export const UsageBodySettledReportContext = React.createContext<((state: UsageBodyReadState) => void) | null>(null);

/**
 * What a query body shows, for the memory.
 * - Settled: facts are shown and no source the body's query waits on is still being read (the slice's own `pending`,
 *   which ignores sources the query never asked for), or the body ended in a terminal state.
 * - Facts: the body draws admitted facts, so its height is worth remembering even while a read stays outstanding.
 */
export function readUsageQueryBodyReadState(query: UsageQuery | null,
    model: Pick<UsageWidgetBodyModel, 'slice' | 'error' | 'pending' | 'requestedQuery'>): UsageBodyReadState {
  const slice = model.slice;
  const settled = !query || (slice !== null
    ? !slice.pending
    : !!model.error && !model.pending || !model.requestedQuery && !model.pending);
  return { facts: settled || slice !== null, settled };
}

export function useReportUsageBodySettled(settled: boolean, facts: boolean = settled): void {
  const report = React.useContext(UsageBodySettledReportContext);
  React.useEffect(() => { report?.({ facts, settled }); }, [report, facts, settled]);
}

/**
 * A body whose own reads are still outstanding draws the shared reading placeholder (`UsageBodyReading`), even when
 * its slice is present (Coach's evidence, a plan's allowance reads). While one is mounted the body has no facts to
 * show, so the dispatch holds exactly the remembered room rather than a placeholder's taller or shorter guess
 * (sweep 1110 #3: Coach 380 → 192). Registered before paint, so the first frame already holds it.
 */
export const UsageBodyReadingPlaceholderContext = React.createContext<(() => () => void) | null>(null);

export function useRegisterUsageBodyReadingPlaceholder(): void {
  const register = React.useContext(UsageBodyReadingPlaceholderContext);
  React.useLayoutEffect(() => register?.(), [register]);
}
