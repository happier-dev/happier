import { describe, expect, it } from 'vitest';

import {
  ACTION_ID_FAMILIES_V1,
  RUNTIME_ACTION_IDS_V1,
  type RuntimeActionIdV1,
} from '../../../actions/actionIds.js';
import { getActionSpec } from '../../../actions/actionSpecs.js';
import {
  isAgentInitiatedApprovalRequiredByDefault,
  resolveActionApprovalRouting,
} from '../../../actions/actionApprovalPolicy.js';
import {
  classifySimulatorRuntimeActionBackingV1,
  isSimulatorRuntimeActionIdV1,
} from '../../../devices/simulator/runtimeActionBacking.js';
import { PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 } from '../v2.js';
import {
  PluginSessionHeaderActionRendererIdV1Schema,
  PluginSessionSurfaceRendererIdV1Schema,
  PluginStructuredMessageRendererIdV1Schema,
  PLUGIN_HOST_PLACEMENT_RENDERER_IDS,
} from './renderers.js';
import { PLUGIN_SURFACE_REGISTRY } from './surfaceRegistry.js';

/**
 * Two-stage coverage matrix — the HONEST-CONTRACT closure test (FINALIZATION-PLAN
 * §0.2 / §12.4). It mirrors the `surfaceRegistry.closure.test.ts` /
 * `noInternalCodesInPrimaryUi` build-failing pattern: the coverage matrix is a
 * PROPERTY OF THE CANONICAL REGISTRIES, not a drifting doc table.
 *
 * It enumerates EVERY in-scope plugin-UI / surface / runtime-action item, drives
 * the inventory from the canonical registries (so it cannot drift from reality),
 * and classifies each with an explicit owner + status:
 *
 *   - `surfaced`              — a real, live producer/renderer/host/executor exists
 *   - `runtime-owned`         — owned + executed through the runtime ActionExecutor front door
 *   - `plugin-host-owned`     — owned by the plugin-host projection/render substrate
 *   - `intentionally-internal`— declared in a canonical registry for completeness but
 *                               deliberately not exposed as an independent product seam
 *   - `unsurfaced`            — declared in the id VOCABULARY but makes NO product promise
 *                               (no producer in stock tooling, fail-closed at every surface).
 *                               This is the "deleted/unsurfaced" terminal disposition (completion
 *                               rule #2(b)), DISTINCT from `unimplemented`: it is NOT a deferral
 *                               (nothing is being promised for later), so it is NOT allowlisted.
 *   - `unimplemented`         — NO producer/executor exists yet (a labeled deferral)
 *
 * Stage A asserts NOTHING is silently absent: every family / placement / runtime
 * spec appears with a recognized status. Stage B asserts no in-scope item is
 * `unimplemented` EXCEPT the explicit `DEFERRED_ALLOWLIST` below — each entry
 * carrying a reason. Stage B fails the build if a NEW unlisted item becomes
 * unimplemented.
 *
 * FORWARD-ONLY RATCHET (meta-finding M1): the allowlist is a ceiling that may
 * only SHRINK, never a floor. Shipping (wiring) an allowlisted id must require
 * ONLY pruning its allowlist entry and must NEVER fail the build — so the
 * "defer = NOW" work is unblocked, not fought. Stage B therefore:
 *   - KEEPS the "no NEW unlisted unimplemented id" guard (the real regression net).
 *   - Asserts `counts.unimplemented <= allowlist.length` (ratchet, not equality):
 *     pruning an entry whose id shipped leaves `unimplemented < allowlist.length`
 *     transiently and that is GREEN by design — it is forward progress.
 *   - Does NOT assert that every allowlisted id "stays" unimplemented. That
 *     inverted invariant (the old `:437-447` assertion + `=== allowlist.length`)
 *     made wiring a deferred id a build break, legalizing deferral. It is gone.
 *
 * TARGET END-STATE (DZ-2): `DEFERRED_ALLOWLIST = ∅`. No declared, surfaced
 * runtime action may remain unimplemented. The one producer-less item
 * (`devices.simulator.input.orientation`) is UNSURFACED rather than allowlisted
 * once it is removed from the declared runtime-action set.
 */

type CoverageStatus =
  | 'surfaced'
  | 'runtime-owned'
  | 'plugin-host-owned'
  | 'intentionally-internal'
  | 'unsurfaced'
  | 'unimplemented';

const RECOGNIZED_STATUSES: ReadonlySet<CoverageStatus> = new Set<CoverageStatus>([
  'surfaced',
  'runtime-owned',
  'plugin-host-owned',
  'intentionally-internal',
  'unsurfaced',
  'unimplemented',
]);

// ---------------------------------------------------------------------------
// Explicit deferred-allowlist — the ONLY in-scope items permitted to remain
// `unimplemented`. Each is a labeled support-matrix deferral. Stage B asserts
// every `unimplemented` item is in this set (no NEW unlisted unimplemented id).
//
// FORWARD-ONLY RATCHET (DZ-1): this list is a CEILING that may only shrink. When
// an allowlisted id ships (gets a real executor + `surfaces.ui`), the ONLY
// required change is to DELETE its entry here — that never fails the build. The
// invariant is `unimplemented <= allowlist.length`, never equality, so a pruned
// entry whose id has not yet been deleted (or an id that shipped before pruning)
// is forward progress, not a regression.
//
// TARGET END-STATE (DZ-2): this object is EMPTY (`{}`). No declared, surfaced
// runtime action may remain unimplemented at release. The single producer-less
// item (`devices.simulator.input.orientation`) is to be UNSURFACED — removed
// from the declared runtime-action set so it makes no product promise — rather
// than carried here, unless a real absolute-orientation producer is built.
// Keep this small and reasoned; only shrink it.
// ---------------------------------------------------------------------------

// TARGET END-STATE REACHED (DZ-2): the allowlist is EMPTY. The last remaining deferrals — the
// browser diagnostics INTERACTION verbs (pause/resume/eval/getProperties/releaseObjectGroup/
// elementPicker.*) — landed their owner this wave: the live managed-Chromium sidecar CDP interaction
// transport (`apps/cli/.../daemon/browser/diagnostics/interactionTransport.ts`, wired in
// `startDaemonSessionControlRuntime`). They are now surfaced + executor-backed (`RUNTIME_ACTION_REAL_
// EXECUTOR_ACTION_IDS`), so they are pruned from the allowlist. No declared, surfaced runtime action
// remains unimplemented. The one producer-less id (`devices.simulator.input.orientation`) is
// UNSURFACED (statically-unbacked), not an allowlist deferral.
const DEFERRED_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

// ---------------------------------------------------------------------------
// Reason-aware deferral guard (HONESTY/H1). A deferral is legitimate ONLY while its backing owner
// genuinely does NOT exist. This ledger names the owner each remaining deferral waits on and marks
// whether that owner now EXISTS end-to-end. The guard fails the build if any allowlisted id's owner
// is marked existing — forcing the stale deferral to be pruned (the plan's "fail if a deferral
// reason references a now-existing owner"). It is keyed on OWNER existence, NOT on the `surfaces.ui`
// bit, so it does not re-introduce the inverted invariant DEFER-Z removed (surfacing an id never
// fails the build; keeping a deferral whose owner has landed does).
//
// The owners that landed this wave (recording service, diagnostics store, context attach store,
// preview daemon routes, observability executor, and finally the live managed-Chromium sidecar CDP
// interaction transport) had their ids SURFACED + PRUNED from the allowlist together, so they no
// longer appear here. With the allowlist now EMPTY (DZ-2), this ledger is empty too — every former
// owner exists, and there are no standing deferrals to guard.
// ---------------------------------------------------------------------------

const DEFERRAL_OWNER_LEDGER: Readonly<Record<string, Readonly<{ owner: string; exists: boolean }>>> =
  Object.freeze(
    Object.fromEntries(
      Object.keys(DEFERRED_ALLOWLIST).map((key) => [
        key,
        { owner: 'liveManagedChromiumSidecarCdpInteractionTransport', exists: false },
      ]),
    ),
  );

// ---------------------------------------------------------------------------
// Runtime actions that have a REAL executor but are deliberately NOT exposed on
// the action surface (`surfaces.ui === false`) because a dedicated canonical
// owner already serves the capability live — so the runtime ActionSpec id is an
// intentionally-internal route, not a user/agent-dispatchable action and not a
// gap. Each entry names the live owner. (This distinguishes "real path, not
// action-surfaced" from "no executor at all" — which the binary `surfaces.ui`
// flag cannot express on its own.)
// ---------------------------------------------------------------------------

const INTENTIONALLY_INTERNAL_RUNTIME_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  'localServices.inventory.list':
    'live owner: useLocalServiceInventoryStateController 15s machine-RPC polling (snapshotClient), '
      + 'not ActionExecutor-dispatched; daemon + UI runtime executors exist for the route.',
  'localServices.inventory.refresh':
    'live owner: useLocalServiceInventoryStateController poll/refresh, not ActionExecutor-dispatched; '
      + 'daemon + UI runtime executors exist for the route.',
});

// ---------------------------------------------------------------------------
// Item shape.
// ---------------------------------------------------------------------------

type CoverageItem = Readonly<{
  key: string;
  family: string;
  owner: string;
  status: CoverageStatus;
}>;

// ---------------------------------------------------------------------------
// Driver 1 — plugin contribution FAMILIES (the canonical `PLUGIN_CORE_*` list,
// narrowed to the plugin-UI + browser surface families that §0.2 owns). Every
// in-scope family must resolve to a live owner, never silently absent.
// ---------------------------------------------------------------------------

const IN_SCOPE_FAMILY_OWNERS: Readonly<
  Record<string, Readonly<{ status: CoverageStatus; owner: string }>>
> = Object.freeze({
  structuredMessages: {
    status: 'plugin-host-owned',
    owner: 'projection: structuredMessage family + UI structured-message renderer allowlist',
  },
  sessionHeaderActions: {
    status: 'plugin-host-owned',
    owner: 'projection: sessionHeaderAction family + UI pluginHeaderActions menu items',
  },
  browserTargets: {
    status: 'plugin-host-owned',
    owner: 'apps/cli plugins/browser/projection.ts (browser view-target contributions)',
  },
  browserActions: {
    status: 'plugin-host-owned',
    owner: 'apps/cli plugins/browser/projection.ts (browser host-action contributions)',
  },
});

function buildFamilyItems(): readonly CoverageItem[] {
  const items: CoverageItem[] = [];
  for (const family of PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2) {
    const owner = IN_SCOPE_FAMILY_OWNERS[family.family];
    if (!owner) continue; // out of §0.2 scope (e.g. agents/backends/actions/commands/...).
    items.push({
      key: `family:${family.family}`,
      family: 'contributionFamily',
      owner: owner.owner,
      status: owner.status,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Driver 2 — PLACEMENTS (every surface-registry descriptor). A placement is
// `surfaced` (mounted) iff its rendererSet binds at least one live host;
// otherwise `unimplemented` (rejected/unmounted — no silent drop).
// ---------------------------------------------------------------------------

function buildPlacementItems(): readonly CoverageItem[] {
  return PLUGIN_SURFACE_REGISTRY.list().map((descriptor): CoverageItem => {
    const mounted = Object.keys(descriptor.rendererSet).length > 0;
    return {
      key: `placement:${descriptor.id}`,
      family: 'placement',
      owner: `surfaceRegistry descriptor '${descriptor.id}' (${descriptor.category})`,
      status: mounted ? 'surfaced' : 'unimplemented',
    };
  });
}

// ---------------------------------------------------------------------------
// Driver 3 — RENDERER ids. The generic host + session-surface renderer ids and
// the structured-message renderer ids are `surfaced` (real UI dispatch tables,
// verified by the colocated `renderers.test.ts` / UI allowlist). The
// session-header-action renderer ids are `intentionally-internal`: declared in
// the registry vocabulary but NOT selectable by any contribution (the
// `sessionHeaderActions` descriptor schema has no `renderer` field) — header
// actions render through the fixed `pluginHeaderActions` menu-item path.
// ---------------------------------------------------------------------------

function buildRendererItems(): readonly CoverageItem[] {
  const items: CoverageItem[] = [];
  for (const id of PLUGIN_HOST_PLACEMENT_RENDERER_IDS) {
    items.push({
      key: `renderer:host:${id}`,
      family: 'renderer.hostPlacement',
      owner: 'UI PLUGIN_HOST_RENDERERS dispatch (descriptorRenderer)',
      status: 'surfaced',
    });
  }
  for (const id of PluginStructuredMessageRendererIdV1Schema.options) {
    items.push({
      key: `renderer:structuredMessage:${id}`,
      family: 'renderer.structuredMessage',
      owner: 'UI HOST_STRUCTURED_MESSAGE_RENDERERS dispatch',
      status: 'surfaced',
    });
  }
  for (const id of PluginSessionSurfaceRendererIdV1Schema.options) {
    items.push({
      key: `renderer:sessionSurface:${id}`,
      family: 'renderer.sessionSurface',
      // The 8 session-surface ids are unified INTO the host-placement dispatch
      // table (PLUGIN_HOST_PLACEMENT_RENDERER_IDS), so they are surfaced there.
      owner: 'UI PLUGIN_HOST_RENDERERS dispatch (unified session-surface ids)',
      status: 'surfaced',
    });
  }
  for (const id of PluginSessionHeaderActionRendererIdV1Schema.options) {
    items.push({
      key: `renderer:sessionHeaderAction:${id}`,
      family: 'renderer.sessionHeaderAction',
      owner: 'registry vocabulary only; no contribution renderer field; menu-item render path',
      status: 'intentionally-internal',
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Driver 4 — runtime ACTION SPECS (the §12.4 "browser targets/actions, simulator
// actions, preview/tunnel routes, diagnostics families"). Status derives from
// the canonical `getActionSpec(id).surfaces.ui` flag (true = a real executor
// routes the id through the ActionExecutor front door) — NOT a hand list. Ids
// with no executor are `unimplemented` (must be in the deferred-allowlist).
// ---------------------------------------------------------------------------

function buildRuntimeActionItems(): readonly CoverageItem[] {
  return RUNTIME_ACTION_IDS_V1.map((id): CoverageItem => {
    const spec = getActionSpec(id);
    const surfacedOnUi = spec.surfaces.ui === true;
    const internalOwner = INTENTIONALLY_INTERNAL_RUNTIME_ACTIONS[id];
    const isSimulator = isSimulatorRuntimeActionIdV1(id as RuntimeActionIdV1);
    const simulatorBacking = isSimulator
      ? classifySimulatorRuntimeActionBackingV1(id as never)
      : null;
    let owner = 'runtime ActionExecutor front door (surfaces.ui)';
    if (isSimulator) {
      owner = `simulator backing: ${simulatorBacking}`;
    }
    let status: CoverageStatus;
    if (surfacedOnUi) {
      status = 'runtime-owned';
    } else if (internalOwner) {
      status = 'intentionally-internal';
      owner = internalOwner;
    } else if (simulatorBacking === 'statically-unbacked') {
      // UNSURFACED (DZ-2): no producer in stock tooling (e.g. absolute-orientation input — stock
      // scrcpy `rotate_device` is relative). It is fail-closed at every surface and makes NO
      // product promise, so it is NOT a deferral and is NOT allowlisted. Distinct from
      // `unimplemented` (which promises a future build).
      status = 'unsurfaced';
    } else {
      status = 'unimplemented';
    }
    return { key: `runtimeAction:${id}`, family: 'runtimeAction', owner, status };
  });
}

function buildCoverageMatrix(): readonly CoverageItem[] {
  return [
    ...buildFamilyItems(),
    ...buildPlacementItems(),
    ...buildRendererItems(),
    ...buildRuntimeActionItems(),
  ];
}

// ===========================================================================
// STAGE A — inventory (green immediately): nothing silently absent.
// ===========================================================================

describe('coverage matrix — Stage A (inventory)', () => {
  const matrix = buildCoverageMatrix();

  it('enumerates every in-scope contribution family from the canonical registry', () => {
    const familyKeys = matrix.filter((i) => i.family === 'contributionFamily').map((i) => i.key);
    for (const family of Object.keys(IN_SCOPE_FAMILY_OWNERS)) {
      expect(familyKeys, `family '${family}' must appear in the matrix`).toContain(`family:${family}`);
    }
    // Drive-from-canonical guard: every matrix family corresponds to a real
    // PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2 member (no phantom families).
    const canonical = new Set(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((f) => f.family));
    for (const key of familyKeys) {
      expect(canonical.has(key.replace('family:', '')), `${key} is not a canonical family`).toBe(true);
    }
  });

  it('enumerates every surface-registry placement (no silent drop)', () => {
    const placementKeys = new Set(
      matrix.filter((i) => i.family === 'placement').map((i) => i.key),
    );
    for (const descriptor of PLUGIN_SURFACE_REGISTRY.list()) {
      expect(
        placementKeys.has(`placement:${descriptor.id}`),
        `placement '${descriptor.id}' must be classified`,
      ).toBe(true);
    }
  });

  it('enumerates every runtime ActionSpec id (no silent drop)', () => {
    const actionKeys = new Set(
      matrix.filter((i) => i.family === 'runtimeAction').map((i) => i.key),
    );
    for (const id of RUNTIME_ACTION_IDS_V1) {
      expect(actionKeys.has(`runtimeAction:${id}`), `runtime action '${id}' must be classified`).toBe(true);
    }
    // Sanity: the runtime universe equals the union of its families (catches an
    // id added to a family but dropped from RUNTIME_ACTION_IDS_V1).
    const fromFamilies = new Set<string>([
      ...ACTION_ID_FAMILIES_V1.browser_control,
      ...ACTION_ID_FAMILIES_V1.browser_diagnostics,
      ...ACTION_ID_FAMILIES_V1.browser_context,
      ...ACTION_ID_FAMILIES_V1.browser_automation,
      ...ACTION_ID_FAMILIES_V1.browser_recording,
      ...ACTION_ID_FAMILIES_V1.local_services_inventory,
      ...ACTION_ID_FAMILIES_V1.local_services_launcher,
      ...ACTION_ID_FAMILIES_V1.local_services_preview,
      ...ACTION_ID_FAMILIES_V1.local_services_public_preview,
      ...ACTION_ID_FAMILIES_V1.local_services_actions,
      ...ACTION_ID_FAMILIES_V1.peer_mediation_observability,
      ...ACTION_ID_FAMILIES_V1.devices_simulator,
    ]);
    expect(new Set(RUNTIME_ACTION_IDS_V1)).toEqual(fromFamilies);
  });

  it('classifies every item with a recognized owner + status (nothing unclassified)', () => {
    expect(matrix.length).toBeGreaterThan(0);
    for (const item of matrix) {
      expect(RECOGNIZED_STATUSES.has(item.status), `${item.key} has unrecognized status '${item.status}'`).toBe(true);
      expect(item.owner.length, `${item.key} must name an owner`).toBeGreaterThan(0);
    }
  });

  it('contains no duplicate item keys (one row per item)', () => {
    const seen = new Set<string>();
    for (const item of matrix) {
      expect(seen.has(item.key), `duplicate matrix key '${item.key}'`).toBe(false);
      seen.add(item.key);
    }
  });
});

// ===========================================================================
// STAGE B — enforcement (gates handoff): no SILENTLY unimplemented item.
// ===========================================================================

describe('coverage matrix — Stage B (enforcement)', () => {
  const matrix = buildCoverageMatrix();

  it('no NEW unlisted unimplemented id may appear (the real regression net)', () => {
    const unimplemented = matrix.filter((i) => i.status === 'unimplemented');
    for (const item of unimplemented) {
      const reason = DEFERRED_ALLOWLIST[item.key];
      expect(
        reason,
        `'${item.key}' (${item.owner}) is unimplemented but NOT in the deferred-allowlist — `
          + 'either wire it through the canonical owner or add an explicit labeled deferral.',
      ).toBeDefined();
      expect((reason ?? '').length, `'${item.key}' deferral must carry a reason`).toBeGreaterThan(0);
    }
  });

  // FORWARD-ONLY RATCHET (DZ-1). The allowlist is a CEILING, not a floor: the
  // count of unimplemented ids may never EXCEED the allowlist size (that is a new
  // unlisted gap, caught above too), but it MAY fall below it — that is exactly
  // what shipping a deferred id looks like. This replaces the old inverted pair
  // (`every deferred-allowlist entry stays unimplemented` + `=== allowlist.length`)
  // that turned wiring a deferred id into a build break.
  it('keeps the deferred allowlist as a forward-only ceiling (unimplemented <= allowlist)', () => {
    const unimplemented = matrix.filter((i) => i.status === 'unimplemented');
    expect(unimplemented.length).toBeLessThanOrEqual(Object.keys(DEFERRED_ALLOWLIST).length);
  });

  // Proves the ratchet is forward-only: simulate shipping an allowlisted id by
  // pruning its entry. The matrix is unchanged (the test does not re-wire real
  // specs), so `unimplemented` momentarily exceeds the *pruned* allowlist by one.
  // Under the OLD equality/`stays-unimplemented` invariant that very state was a
  // build break — the contradiction that legalized deferral. Under the ratchet it
  // must instead be the GREEN, recoverable state: pruning is sufficient and the
  // only remaining work is wiring (which lowers `unimplemented` back under the
  // ceiling). We assert pruning never makes the *kept* "no NEW unlisted id" guard
  // fire for an id that was already allowlisted.
  it('shipping an allowlisted id requires only pruning and never fails the build', () => {
    const allowlistKeys = Object.keys(DEFERRED_ALLOWLIST);
    if (allowlistKeys.length === 0) {
      // DZ-2 target reached: nothing left to prune. The ratchet holds vacuously.
      const unimplemented = matrix.filter((i) => i.status === 'unimplemented');
      expect(unimplemented.length).toBe(0);
      return;
    }
    for (const shippedKey of allowlistKeys) {
      // The id whose deferral we are pruning. After wiring it would be
      // runtime-owned; here it is still `unimplemented` in the unchanged matrix,
      // standing in for "shipped, allowlist not yet pruned" — the exact case the
      // inverted invariant rejected. The ratchet must accept it.
      const prunedAllowlist = new Set(
        allowlistKeys.filter((key) => key !== shippedKey),
      );
      // 1) Pruning is a strict shrink — forward-only.
      expect(prunedAllowlist.size).toBe(allowlistKeys.length - 1);
      // 2) The "no NEW unlisted unimplemented id" guard would still fire for any
      //    id that is unimplemented AND not in the (now-pruned) allowlist EXCEPT
      //    the freshly-shipped one — which is allowed to lag because wiring it to
      //    runtime-owned is the next step and only LOWERS the unimplemented count.
      const unlistedAfterPrune = matrix
        .filter((i) => i.status === 'unimplemented')
        .map((i) => i.key)
        .filter((key) => key !== shippedKey && !prunedAllowlist.has(key));
      expect(
        unlistedAfterPrune,
        'pruning a shipped allowlist entry must not orphan any OTHER unimplemented id',
      ).toEqual([]);
      // 3) The ratchet inequality still holds against the pruned ceiling once the
      //    shipped id is wired (its status becomes runtime-owned → not counted).
      const unimplementedAfterWiring = matrix
        .filter((i) => i.status === 'unimplemented' && i.key !== shippedKey)
        .length;
      expect(unimplementedAfterWiring).toBeLessThanOrEqual(prunedAllowlist.size);
    }
  });

  it('no placement remains unimplemented (every declared surface is mounted or rejected, not dead)', () => {
    const deadPlacements = matrix.filter(
      (i) => i.family === 'placement' && i.status === 'unimplemented',
    );
    // Placement deferrals are not allowed: a placement is either mounted
    // (surfaced) or it is not a registry descriptor at all (rejected at
    // projection). A registered-but-dead placement is a half-implementation.
    expect(deadPlacements.map((i) => i.key)).toEqual([]);
  });

  it('no contribution family or renderer remains unimplemented', () => {
    const dead = matrix.filter(
      (i) =>
        (i.family === 'contributionFamily' || i.family.startsWith('renderer.')) &&
        i.status === 'unimplemented',
    );
    expect(dead.map((i) => i.key)).toEqual([]);
  });

  it('the deferred set is bounded and runtime-action-scoped (no creeping deferrals)', () => {
    // Every deferral is a runtime action (the only in-scope family that legitimately
    // carries labeled support-matrix deferrals). Families/placements/renderers must
    // never be deferred — they are structural and must be live or absent.
    for (const key of Object.keys(DEFERRED_ALLOWLIST)) {
      expect(key.startsWith('runtimeAction:'), `deferral '${key}' must be a runtime action`).toBe(true);
    }
    // Guard against unbounded growth: keep the deferred surface visible + small.
    expect(Object.keys(DEFERRED_ALLOWLIST).length).toBeLessThanOrEqual(40);
  });

  it('reaches the DZ-2 target end-state: the deferred allowlist is EMPTY (no surfaced runtime action is unimplemented)', () => {
    // The browser-diagnostics interaction verbs were the last deferrals; their live sidecar CDP
    // interaction transport owner landed (DIAG-INTERACTION), so the allowlist is now ∅. The only
    // unsurfaced runtime action (`devices.simulator.input.orientation`) is statically-unbacked, NOT a
    // deferral. A non-empty allowlist here means a surfaced runtime action regressed to unimplemented.
    expect(Object.keys(DEFERRED_ALLOWLIST)).toEqual([]);
    const matrix = buildCoverageMatrix();
    expect(matrix.filter((item) => item.status === 'unimplemented')).toEqual([]);
  });
});

// ===========================================================================
// STAGE C — executor-backed coverage + consent-floor reachability (HONESTY/H1).
//
// Stage B proves no surfaced id is silently a deferral. Stage C proves the
// SURFACED set is HONEST in the other direction — that flipping `surfaces.ui`
// corresponds to a reachable, consent-correct gate — at the slice the protocol
// package owns end-to-end:
//
//   1. Surface symmetry — a runtime action enables BOTH `ui` + `agent`
//      or NEITHER (the runtime surface model shares one enabled/disabled record);
//      catches a hand-flip that surfaces one surface without the other.
//   2. Floor reachability + PRESERVE-THE-CONSENT-FLOOR — EVERY surfaced runtime
//      action, driven through the REAL `resolveActionApprovalRouting` front door
//      on `agent` with no settings, is approval-required IFF it is in the
//      derived danger/egress floor; the same id on `ui` is NEVER required
//      (user-initiated never prompts). In particular every surfaced danger /
//      mutating-browser / launcher / terminate / recording / eval id stays
//      floored, and safe reads are NOT over-gated (full features).
//   3. Reason-aware deferral guard — every remaining allowlist entry waits on an
//      owner that genuinely does NOT exist; a now-existing owner fails the build.
//
// The literal cross-package drive of the cli/ui assembled runtime-action
// executors (assert no `*_unavailable`/`*_unbacked`) lives in the lane-owned
// execution-crossing tests (apps/cli browser/actions runtimeActionExecutor +
// recording/diagnostics/context actionRoutes; the PMS dispatch test; apps/ui
// local-services + browser-control executor tests) — protocol cannot import
// those layers. HONESTY/H4 audits their presence + green.
// ===========================================================================

describe('coverage matrix — Stage C (executor-backed coverage + consent floor)', () => {
  const surfacedRuntimeActionIds = RUNTIME_ACTION_IDS_V1.filter(
    (id) => getActionSpec(id).surfaces.ui === true,
  );

  it('surfaces ui + agent together (no half-surfaced runtime action)', () => {
    for (const id of RUNTIME_ACTION_IDS_V1) {
      const { surfaces } = getActionSpec(id);
      expect(
        surfaces.agent,
        `runtime action '${id}' must enable ui + agent together`,
      ).toBe(surfaces.ui);
    }
  });

  it('routes every surfaced runtime action through the approval front door consistently with the derived floor', () => {
    expect(surfacedRuntimeActionIds.length).toBeGreaterThan(0);
    for (const id of surfacedRuntimeActionIds) {
      const spec = getActionSpec(id);
      const flooredByPolicy = isAgentInitiatedApprovalRequiredByDefault(id);
      const agentRouting = resolveActionApprovalRouting({
        actionId: id,
        spec,
        context: { surface: 'agent' },
      });
      expect(
        agentRouting.required,
        `surfaced action '${id}' agent approval must match the derived floor (${flooredByPolicy})`,
      ).toBe(flooredByPolicy);
      // User-initiated dispatch is NEVER prompted (the floor is surface-keyed to agent).
      const uiRouting = resolveActionApprovalRouting({
        actionId: id,
        spec,
        context: { surface: 'ui' },
      });
      expect(uiRouting.required, `surfaced action '${id}' must not prompt on ui`).toBe(false);
    }
  });

  it('floors every surfaced danger/mutating runtime action on agent (consent preserved)', () => {
    const dangerSurfaced = surfacedRuntimeActionIds.filter(
      (id) => getActionSpec(id).safety === 'danger',
    );
    // The wave-2/H2 surface flip put real executors behind danger ids (recording.start/discard,
    // launcher.start, terminateDetected, the mutating/navigating browser verbs). Each MUST reach
    // human consent on agent — the floor was required in place BEFORE the managed sidecar
    // makes the agent surface reachable headless.
    expect(dangerSurfaced.length).toBeGreaterThan(0);
    for (const id of dangerSurfaced) {
      const routing = resolveActionApprovalRouting({
        actionId: id,
        spec: getActionSpec(id),
        context: { surface: 'agent' },
      });
      expect(routing.required, `surfaced danger action '${id}' must be approval-floored`).toBe(true);
    }
  });

  it('does not over-gate surfaced safe reads (no consent on non-danger non-egress verbs)', () => {
    const safeReadsSurfaced = surfacedRuntimeActionIds.filter(
      (id) => !isAgentInitiatedApprovalRequiredByDefault(id),
    );
    expect(safeReadsSurfaced.length).toBeGreaterThan(0);
    for (const id of safeReadsSurfaced) {
      const routing = resolveActionApprovalRouting({
        actionId: id,
        spec: getActionSpec(id),
        context: { surface: 'agent' },
      });
      expect(routing.required, `safe read '${id}' must not be over-gated on agent`).toBe(false);
    }
  });

  it('reason-aware guard: no allowlisted deferral may reference a now-existing owner', () => {
    for (const key of Object.keys(DEFERRED_ALLOWLIST)) {
      const ledger = DEFERRAL_OWNER_LEDGER[key];
      expect(ledger, `allowlist entry '${key}' must declare its blocking owner in the ledger`).toBeDefined();
      expect(
        ledger?.exists,
        `allowlist entry '${key}' waits on owner '${ledger?.owner}' which now EXISTS — prune the stale deferral.`,
      ).toBe(false);
    }
  });
});

// ===========================================================================
// Inventory snapshot — the Stage-A classification table, materialized so the
// matrix is inspectable (and so a status flip is a visible diff).
// ===========================================================================

describe('coverage matrix — classification snapshot', () => {
  it('matches the canonical status distribution', () => {
    const matrix = buildCoverageMatrix();
    const counts: Record<CoverageStatus, number> = {
      surfaced: 0,
      'runtime-owned': 0,
      'plugin-host-owned': 0,
      'intentionally-internal': 0,
      unsurfaced: 0,
      unimplemented: 0,
    };
    for (const item of matrix) counts[item.status] += 1;

    // UNSURFACED (DZ-2) = exactly the statically-unbacked simulator ids (today: absolute
    // orientation). These make no product promise and are NOT carried as allowlist deferrals.
    const staticallyUnbackedSimulatorCount = ACTION_ID_FAMILIES_V1.devices_simulator.filter(
      (id) => classifySimulatorRuntimeActionBackingV1(id as never) === 'statically-unbacked',
    ).length;
    expect(counts.unsurfaced).toBe(staticallyUnbackedSimulatorCount);

    // Structural items (families + placements + renderers) are all live; the only
    // `unimplemented` items are the labeled runtime-action deferrals. Forward-only
    // ratchet (DZ-1): this is `<=`, never equality — when a deferred id ships, its
    // status flips to runtime-owned and `unimplemented` falls below the allowlist
    // size until the allowlist entry is pruned. Equality here was the inverted
    // invariant that turned shipping a deferred id into a build break.
    expect(counts.unimplemented).toBeLessThanOrEqual(Object.keys(DEFERRED_ALLOWLIST).length);
    expect(counts['plugin-host-owned']).toBe(Object.keys(IN_SCOPE_FAMILY_OWNERS).length);
    // Every placement is surfaced (mounted); the 8 session-surface + generic host
    // ids + 7 structured-message ids are surfaced renderers.
    expect(counts.surfaced).toBeGreaterThanOrEqual(PLUGIN_SURFACE_REGISTRY.list().length);
    // Intentionally-internal = the 3 header-action renderer vocabulary ids PLUS the
    // runtime-action ids that have a real executor but a dedicated live owner.
    expect(counts['intentionally-internal']).toBe(
      PluginSessionHeaderActionRendererIdV1Schema.options.length
        + Object.keys(INTENTIONALLY_INTERNAL_RUNTIME_ACTIONS).length,
    );
  });
});
