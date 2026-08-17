import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesResultV1Schema,
  TriageSetEntryPinnedResultV1Schema,
  type TriageListPinnedEntriesResultV1,
  type TriageSetEntryPinnedResultV1,
} from '../../actions/userMarksProtocol.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../../projection/listWindow.js';

/**
 * The surface's one path to the canonical `user-marks` owner.
 *
 * A mounted surface holds a Host API, not a Collection, so every Pin, Unpin and
 * pinned-section read leaves through here. The module owns no state: there is
 * no local pinned set, no optimistic commitment and no queue, because a pin is
 * durable user intent with no upstream owner to reconstruct it from — the only
 * honest thing to show is what the Account says.
 *
 * The entry reference is passed through exactly as the projection produced it.
 * Nothing here rebuilds, normalizes, sorts or re-encodes it: the mark's address
 * is derived from that reference alone, so a reference this module reshaped
 * could address a second row for one entry, and the reader would see a
 * duplicate pin appear after a refresh on another device.
 */

/**
 * What a mark command needs from a mounted surface: the ability to invoke this
 * plugin's own mark Actions. Deliberately the narrowest capability rather than
 * a whole Host API — nothing else about a mount takes part in pinning.
 */
export type TriageMarkHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

export type TriagePinnedEntryV1 = TriageListPinnedEntriesResultV1['pins'][number];

/**
 * Pin names what it pinned; Unpin names only the entry.
 *
 * The union is the whole contract: an Unpin has no rendering to supply, and
 * must stay available for a pinned row no current pass materialized.
 */
export type TriagePinIntentV1 =
  | Readonly<{
      pinned: true;
      entryRef: TriageEntryRefV1;
      displayAtMark: TriagePinnedEntryV1['displayAtMark'];
    }>
  | Readonly<{ pinned: false; entryRef: TriageEntryRefV1 }>;

/** One bounded page, sized to the same row ceiling the list window uses. */
export const TRIAGE_PINNED_PAGE_LIMIT_V1 = MAX_TRIAGE_LIST_WINDOW_ROWS_V1;

export async function submitTriagePin(
  host: TriageMarkHostV1,
  intent: TriagePinIntentV1,
  options?: PluginCancellationOptions,
): Promise<TriageSetEntryPinnedResultV1> {
  const input: JsonValue = intent.pinned
    ? { v: 1, pinned: true, entryRef: intent.entryRef, displayAtMark: intent.displayAtMark }
    : { v: 1, pinned: false, entryRef: intent.entryRef };
  const result = await host.executeAction(
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    input,
    options,
  );
  // The Action crosses a JSON transport, so its own published result schema —
  // not a cast — is what admits the value a row's state is taken from.
  return TriageSetEntryPinnedResultV1Schema.parse(result);
}

export async function readTriagePinnedEntries(
  host: TriageMarkHostV1,
  options?: PluginCancellationOptions,
): Promise<TriageListPinnedEntriesResultV1> {
  const result = await host.executeAction(
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    { v: 1, limit: TRIAGE_PINNED_PAGE_LIMIT_V1 },
    options,
  );
  return TriageListPinnedEntriesResultV1Schema.parse(result);
}
