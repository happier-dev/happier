import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import {
  listTriagePinnedEntries,
  setTriageEntryPinned,
} from '../../actions/userMarks.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
  TriageListPinnedEntriesResultV1Schema,
  TriageSetEntryPinnedResultV1Schema,
  type TriageListPinnedEntriesResultV1,
  type TriageSetEntryPinnedResultV1,
} from '../../actions/userMarksProtocol.js';
import type { CorpusCollectionsV1 } from '../../corpus/collections/bindCorpusCollections.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../../projection/listWindow.js';

/**
 * The surface's path to the canonical `user-marks` owner.
 *
 * There are two transports and one owner. A mount that can reach the reader's
 * Account directly drives `actions/userMarks.ts` over its own Account
 * Collection handle, so Pin, Unpin and the pinned section keep working with no
 * daemon reachable at all — a pin is Account state, not provider data. A mount
 * that cannot reach the Account directly invokes the same two published
 * Actions, which reach the same owner through a daemon. Neither transport
 * decides anything: `setPinned` still owns idempotency, the derived address,
 * the conditional resurrection and the conflict verdict.
 *
 * The module owns no state: there is no local pinned set, no optimistic
 * commitment and no queue, because a pin is durable user intent with no
 * upstream owner to reconstruct it from — the only honest thing to show is what
 * the Account says.
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

/**
 * The two mark operations a mounted surface performs, independent of how they
 * reach the owner. The hook holds one of these and never branches on transport.
 */
export type TriageMarksTransportV1 = Readonly<{
  read(
    cursor: string | undefined,
    options?: PluginCancellationOptions,
  ): Promise<TriageListPinnedEntriesResultV1>;
  write(
    intent: TriagePinIntentV1,
    options?: PluginCancellationOptions,
  ): Promise<TriageSetEntryPinnedResultV1>;
}>;

/**
 * The direct transport: this mount's own Account Collection handle, handed to
 * the same Action-layer projection the daemon handler calls. No daemon is in
 * the path, and no identity derivation, codec or CAS rule is restated here.
 */
export function createDirectTriageMarksTransport(
  collections: Pick<CorpusCollectionsV1, 'userMarks'>,
  nowMs: () => number = () => Date.now(),
): TriageMarksTransportV1 {
  return Object.freeze({
    async read(cursor, options) {
      return await listTriagePinnedEntries({
        v: 1,
        limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        ...(cursor === undefined ? {} : { cursor }),
      }, {
        collections,
        nowMs,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
    async write(intent, options) {
      return await setTriageEntryPinned(
        intent.pinned
          ? { v: 1, pinned: true, entryRef: intent.entryRef, displayAtMark: intent.displayAtMark }
          : { v: 1, pinned: false, entryRef: intent.entryRef },
        {
          collections,
          nowMs,
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    },
  });
}

/** The daemon transport: the same owner, reached through the published Actions. */
export function createActionTriageMarksTransport(host: TriageMarkHostV1): TriageMarksTransportV1 {
  return Object.freeze({
    read: async (cursor, options) => await readTriagePinnedEntries(host, cursor, options),
    write: async (intent, options) => await submitTriagePin(host, intent, options),
  });
}

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

/**
 * One bounded page of the reader's pins, newest first.
 *
 * `cursor` is the previous page's `nextCursor`, passed back untouched. It is a
 * process-local argument and nothing more: this module keeps no page, no cursor
 * and no accumulated set, so a lost mount starts at the newest page with
 * nothing to resume.
 */
export async function readTriagePinnedEntries(
  host: TriageMarkHostV1,
  cursor?: string,
  options?: PluginCancellationOptions,
): Promise<TriageListPinnedEntriesResultV1> {
  const result = await host.executeAction(
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    {
      v: 1,
      limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    },
    options,
  );
  return TriageListPinnedEntriesResultV1Schema.parse(result);
}
