import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

import {
  administerTriageAction,
  readTriageActionsForSurface,
} from '../../actions/actionsCatalog.js';
import {
  TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
  TriageAdministerActionResultV1Schema,
  TriageReadActionsResultV1Schema,
  type TriageAdministerActionInputV1,
  type TriageAdministerActionResultV1,
  type TriageReadActionsResultV1,
} from '../../actions/actionsCatalogProtocol.js';
import { mintTriageOpaqueIdV1 } from '../../opaqueId.js';
import {
  appendMissingTriageDefaultActionsV1,
  type TriageActionMutableTargetV1,
  type TriageActionsDepsV1,
  type TriageActionV1,
  type TriageActionsReadV1,
} from '../../settings/actions.js';
import type { TriageCatalogStoreV1 } from '../../settings/accountKvCatalogStore.js';

/**
 * The surface's path to the `triage.actions` CAS owner.
 *
 * Two transports, one owner. A mount that can reach the reader's Account
 * directly drives `actions/actionsCatalog.ts` over its own Account KV
 * scope, so the configured actions stay readable and editable with no daemon
 * reachable — a configured action is Account state, not provider data. A mount
 * that cannot invokes the same two published Account Actions. The module owns no state and makes no decision:
 * `settings/actions.ts` still mints the action id, validates every bound and
 * closed vocabulary, decides the conflict verdict and refuses a reorder that is
 * not an exact permutation. This is transport plus the one conversion a caller
 * must not spell twice — an Action projection read back as the owner's own read
 * shape.
 */

/**
 * What an action-catalog command needs from a mounted surface: the ability to
 * invoke this plugin's own catalog Actions, and nothing else about the mount.
 */
export type TriageActionsHostV1 = Readonly<{
  executeAction(
    action: string,
    input: JsonValue,
    options?: PluginCancellationOptions,
  ): Promise<unknown>;
}>;

/**
 * The two catalog operations a mounted surface performs, independent of how
 * they reach the owner. The hook holds one of these and never branches on
 * transport.
 */
export type TriageActionsTransportV1 = Readonly<{
  read(options?: PluginCancellationOptions): Promise<TriageReadActionsResultV1>;
  administer(
    input: TriageAdministerActionInputV1,
    options?: PluginCancellationOptions,
  ): Promise<TriageAdministerActionResultV1 | null>;
}>;

/**
 * The direct transport: this mount's own Account KV catalog, handed to the
 * same projection the Account Action handler calls. It restates no bound, no CAS rule
 * and no id-minting decision.
 */
export function createDirectTriageActionsTransport(
  catalog: TriageCatalogStoreV1,
  host: Pick<PluginUiHostApi, 'admitAction'>,
  /** What plugins contribute in this mount's admitted snapshot; the Account Action reads its own. */
  contributed: TriageActionsDepsV1['contributed'] = [],
): TriageActionsTransportV1 {
  return Object.freeze({
    read: async (options) => await readTriageActionsForSurface({ v: 1 }, {
      catalog,
      contributed,
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
    administer: async (input, options) => {
      if (!await host.admitAction(TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1, input as unknown as JsonValue, options)) return null;
      return await administerTriageAction(input, {
        catalog,
        contributed,
        // Minted at the writer, which for this transport is this mount.
        mintActionId: mintTriageOpaqueIdV1,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
  });
}

/** The same catalog owner, reached through the published Account Actions. */
export function createActionTriageActionsTransport(
  host: TriageActionsHostV1,
): TriageActionsTransportV1 {
  return Object.freeze({
    read: async (options) => await readTriageActionsFromSurface(host, options),
    administer: async (input, options) => (
      await administerTriageActionFromSurface(host, input, options)
    ),
  });
}

export async function readTriageActionsFromSurface(
  host: TriageActionsHostV1,
  options?: PluginCancellationOptions,
): Promise<TriageReadActionsResultV1> {
  const result = await host.executeAction(
    TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1,
    { v: 1 },
    options,
  );
  // The Action crosses a JSON transport, so its own published result schema —
  // not a cast — admits the value the editor is built from.
  return TriageReadActionsResultV1Schema.parse(result);
}

export async function administerTriageActionFromSurface(
  host: TriageActionsHostV1,
  input: TriageAdministerActionInputV1,
  options?: PluginCancellationOptions,
): Promise<TriageAdministerActionResultV1> {
  const result = await host.executeAction(
    TRIAGE_ADMINISTER_ACTION_ACTION_LOCAL_ID_V1,
    input as unknown as JsonValue,
    options,
  );
  return TriageAdministerActionResultV1Schema.parse(result);
}

/**
 * Read one Action projection as the owner's own read shape.
 *
 * `absent` is carried through rather than flattened into `parsed`, because the
 * two mean different things to the editor: an absent catalog is showing the
 * shipped seed and the first write stores it, while a parsed one includes the
 * person's configured rows and any missing built-ins. `unavailable` becomes
 * `unreadable` and carries the empty stand-in — the editor must say the catalog belongs to a newer writer
 * rather than offering to replace it.
 */
export function readTriageActionsProjectionV1(
  projection: Readonly<{
    availability: TriageReadActionsResultV1['availability'];
    actions: TriageReadActionsResultV1['actions'];
  }>,
): TriageActionsReadV1 {
  if (projection.availability === 'unavailable') {
    return { kind: 'unreadable', value: { v: 1, actions: [] } };
  }
  return { kind: projection.availability, value: { v: 1,
    actions: appendMissingTriageDefaultActionsV1(projection.actions),
  } };
}

/** Everything an action is, minus the identity the writer owns. */
export type TriageActionEditorDraftV1 = Readonly<{
  label: string;
  enabled: boolean;
  appliesTo: readonly TriageActionV1['appliesTo'][number][];
  profileId: string | null;
  workspaceMode: TriageActionV1['workspaceMode'];
  /** Writer-owned seed state; never projected onto the mutation wire. */
  hasSeededFallbackInstruction: boolean;
  target: TriageActionMutableTargetV1;
}>;

function draftWire(draft: TriageActionEditorDraftV1): Omit<
  Extract<TriageAdministerActionInputV1, Readonly<{ kind: 'create' }>>,
  'v' | 'kind' | 'expectedRevision'
> {
  return {
    label: draft.label,
    enabled: draft.enabled,
    appliesTo: [...draft.appliesTo],
    profileId: draft.profileId,
    workspaceMode: draft.workspaceMode,
    target: draft.target.kind === 'reviewStart'
      ? {
        kind: 'reviewStart',
        promptInvocationId: draft.target.promptInvocationId,
        ...(draft.target.promptArgsText === undefined
          ? {}
          : { promptArgsText: draft.target.promptArgsText }),
      }
      : {
        kind: 'agent',
        promptInvocationId: draft.target.promptInvocationId,
        ...(draft.target.promptArgsText === undefined
          ? {}
          : { promptArgsText: draft.target.promptArgsText }),
        delivery: draft.target.delivery,
      },
  };
}

/**
 * Every command names the catalogue it was formed against.
 *
 * The revision is not a detail the transport adds: it is the difference between
 * "save these five answers" and "save these five answers to the set I was
 * looking at". The owner refuses the second when the set has moved, which is
 * why the caller — not the writer — is the one that has to state it.
 */
export function triageCreateActionInputV1(
  draft: TriageActionEditorDraftV1,
  expectedRevision: string,
): TriageAdministerActionInputV1 {
  return { v: 1, kind: 'create', expectedRevision, ...draftWire(draft) };
}

/**
 * Rename, disable and reconfigure are ONE update.
 *
 * Every one of them writes the same five answers, so the caller supplies the
 * whole draft it wants stored and this is the only place that becomes an
 * `update`. A control that assembled a partial command would be a second answer
 * to "what does Rename leave untouched", and the first stale member it met
 * would be written back over a change made on another device.
 */
export function triageUpdateActionInputV1(
  actionId: string,
  draft: TriageActionEditorDraftV1,
  expectedRevision: string,
): TriageAdministerActionInputV1 {
  return { v: 1, kind: 'update', actionId, expectedRevision, ...draftWire(draft) };
}

/** Put the shipped catalog back: the Account's own catalog is deleted at the revision it was read at. */
export function triageResetActionsInputV1(expectedRevision: string): TriageAdministerActionInputV1 {
  return { v: 1, kind: 'reset', expectedRevision };
}

export function triageDeleteActionInputV1(
  actionId: string,
  expectedRevision: string,
): TriageAdministerActionInputV1 {
  return { v: 1, kind: 'delete', actionId, expectedRevision };
}

export function triageReorderActionsInputV1(
  actionIds: readonly string[],
  expectedRevision: string,
): TriageAdministerActionInputV1 {
  return { v: 1, kind: 'reorder', actionIds: [...actionIds], expectedRevision };
}

/**
 * Move one action one place, as an exact permutation of the set it moves in.
 *
 * The writer refuses anything that is not a permutation, so the move is
 * computed from the authoritative order the caller is showing rather than from
 * an index a control remembered. A move off either end is not an error and not
 * a wrap: it is the same order, and returning it unchanged is what keeps the
 * control from writing a no-op the person did not ask for.
 */
export function triageMovedActionOrderV1(
  actions: readonly TriageActionV1[],
  actionId: string,
  direction: 'up' | 'down',
): readonly string[] | null {
  const index = actions.findIndex((action) => action.actionId === actionId);
  if (index < 0) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= actions.length) return null;
  const order = actions.map((action) => action.actionId);
  const moved = order[index];
  const displaced = order[target];
  if (moved === undefined || displaced === undefined) return null;
  order[target] = moved;
  order[index] = displaced;
  return order;
}

/**
 * What the editor and entry controls hold before Account KV has answered.
 *
 * The shipped seed is an executable catalog only after an authoritative read
 * answers with a readable catalog. Until then this empty unreadable projection
 * makes no claim about the Account and exposes nothing that can be pressed.
 */
export const TRIAGE_UNREAD_ACTIONS_V1: TriageActionsReadV1 = Object.freeze({
  kind: 'unreadable',
  value: Object.freeze({ v: 1, actions: Object.freeze([]) }),
});
