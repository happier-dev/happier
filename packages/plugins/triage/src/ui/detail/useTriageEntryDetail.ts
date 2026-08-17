import { useEffect, useMemo, useRef, useState } from 'react';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
  TriageReadEntryDetailResultV1Schema,
} from '../../actions/entryDetailProtocol.js';
import type { TriageSurfaceSelectionV1 } from '../state/surface.js';
import { buildTriageDetailSurfaceInputV1 } from './input.js';

/**
 * The selected entry's mounted detail input.
 *
 * Two of the three members the strict boundary requires are Account Collection
 * state, and a mounted surface holds a Host API with no storage member — so
 * this hook is the transport, through the plugin's own Action, and nothing here
 * reaches a provider. The third member, the applied observation, is already in
 * the reader's device-local projection and is passed in.
 *
 * Every state it can be in is one a reader can be told truthfully, and the
 * unavailable ones are deliberately distinguishable: a connection that has been
 * removed is a different sentence from an Account this device cannot currently
 * reach, and both are different from a value the published contract refused.
 * Collapsing them would leave the detail region with one shrug for three causes.
 */

export type TriageEntryDetailStateV1 =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'ready'; input: TriageDetailSurfaceInputV1 }>
  /** The selected connection is retired, removed, or no longer this source's. */
  | Readonly<{ kind: 'unavailable' }>
  /** The Account could not be read at all; retrying is the reader's move. */
  | Readonly<{ kind: 'unreachable' }>
  /**
   * The durable facts read cleanly and still could not compose an admissible
   * detail input — an over-bound Session projection, or an observation that no
   * longer names the selected entry. It is not a source failure and is never
   * reported as one.
   */
  | Readonly<{ kind: 'refused'; reason: 'entryMismatch' | 'instanceMismatch' | 'invalidContractValue' }>;

const READING: TriageEntryDetailStateV1 = Object.freeze({ kind: 'reading' });
const UNAVAILABLE: TriageEntryDetailStateV1 = Object.freeze({ kind: 'unavailable' });
const UNREACHABLE: TriageEntryDetailStateV1 = Object.freeze({ kind: 'unreachable' });

/** What this read needs from a mount: the ability to invoke one own Action. */
type TriageDetailHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

export type TriageEntryDetailInputSourceV1 = Readonly<{
  selection: Pick<TriageSurfaceSelectionV1, 'entryRef' | 'sourceInstanceId'>;
  /** The host-applied present observation for the selected entry and connection. */
  observation: TriageDetailSurfaceInputV1['observation'];
}>;

export async function readTriageEntryDetailState(
  host: TriageDetailHostV1,
  source: TriageEntryDetailInputSourceV1,
  options?: PluginCancellationOptions,
): Promise<TriageEntryDetailStateV1> {
  let result: ReturnType<typeof TriageReadEntryDetailResultV1Schema.parse>;
  try {
    result = TriageReadEntryDetailResultV1Schema.parse(await host.executeAction(
      TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
      {
        v: 1,
        entryRef: source.selection.entryRef,
        sourceInstanceId: source.selection.sourceInstanceId,
      },
      options,
    ));
  } catch {
    return UNREACHABLE;
  }
  // `invalidCaller` cannot be caused by anything the reader did and cannot be
  // resolved by them either; it reads as the same unavailable detail rather
  // than as an accusation.
  if (result.kind !== 'read') return UNAVAILABLE;

  const built = buildTriageDetailSurfaceInputV1({
    selection: source.selection,
    instance: result.instance,
    observation: source.observation,
    linkedSessions: result.linkedSessions,
  });
  return built.kind === 'admitted'
    ? Object.freeze({ kind: 'ready', input: built.input })
    : Object.freeze({ kind: 'refused', reason: built.reason });
}

/**
 * Read the selected entry's detail input, once per selection.
 *
 * `null` means nothing is selected, which is not a state the detail region
 * renders — it is the list's own full-width composition.
 */
export function useTriageEntryDetail(
  source: TriageEntryDetailInputSourceV1 | null,
): TriageEntryDetailStateV1 | null {
  const hostApi = usePluginHostApi();
  const [state, setState] = useState<TriageEntryDetailStateV1 | null>(null);
  // Reads settle out of order across a fast selection change; only the newest
  // one may publish, or a reader can end up looking at the entry they left.
  const generation = useRef(0);

  const entryRef = source?.selection.entryRef;
  const sourceInstanceId = source?.selection.sourceInstanceId;
  const observation = source?.observation;

  useEffect(() => {
    if (entryRef === undefined || sourceInstanceId === undefined || observation === undefined) {
      generation.current += 1;
      setState(null);
      return undefined;
    }
    generation.current += 1;
    const current = generation.current;
    const controller = new AbortController();
    setState(READING);
    void (async () => {
      const next = await readTriageEntryDetailState(
        hostApi,
        { selection: { entryRef, sourceInstanceId }, observation },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || current !== generation.current) return;
      setState(next);
    })();
    return () => { controller.abort(); };
  }, [entryRef, hostApi, observation, sourceInstanceId]);

  return useMemo(() => state, [state]);
}
