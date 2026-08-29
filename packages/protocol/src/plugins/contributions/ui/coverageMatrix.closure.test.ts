import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1,
  type PluginUiContainerV1,
  type PluginUiTargetKindV1,
} from './surfaceRegistry.js';

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
 *   - `unsurfaced`            — declared in the id VOCABULARY but makes NO product promise
 *                               (no producer in stock tooling, fail-closed at every surface).
 *                               This is the "deleted/unsurfaced" terminal disposition (completion
 *                               rule #2(b)), DISTINCT from `unimplemented`: it is NOT a deferral
 *                               (nothing is being promised for later), so it is NOT allowlisted.
 *   - `unimplemented`         — NO producer/executor exists yet (a labeled deferral)
 *
 * Stage A asserts NOTHING is silently absent: every family / destination slot / runtime
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
  | 'unsurfaced'
  | 'unimplemented';

const RECOGNIZED_STATUSES: ReadonlySet<CoverageStatus> = new Set<CoverageStatus>([
  'surfaced',
  'runtime-owned',
  'plugin-host-owned',
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
// Item shape.
// ---------------------------------------------------------------------------

type CoverageItem = Readonly<{
  key: string;
  family: string;
  owner: string;
  status: CoverageStatus;
}>;

type DestinationReachabilityFacts = Readonly<{
  declared: boolean;
  projected: boolean;
  launchable: boolean;
  mounted: boolean;
}>;

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The only mounted-coverage interpretation lives in this closure test. A
 * renderer inventory, an admitted slot, or a component fixture cannot make a
 * destination mounted by itself. The test-owned proof relation names each
 * independently-owned stage of the real path.
 */
function destinationSlotReachabilityFacts(
  proofRefs: DestinationReachabilityProofReferences | undefined,
): DestinationReachabilityFacts {
  return Object.freeze({
    declared: hasNonEmptyString(proofRefs?.declaration),
    projected: hasNonEmptyString(proofRefs?.projection),
    launchable: hasNonEmptyString(proofRefs?.launcherOrOpenPath),
    mounted: hasNonEmptyString(proofRefs?.productionShell)
      && hasNonEmptyString(proofRefs?.decidingTest),
  });
}

function hasFullDestinationReachability(facts: DestinationReachabilityFacts | undefined): boolean {
  return facts?.declared === true
    && facts.projected === true
    && facts.launchable === true
    && facts.mounted === true;
}

// ---------------------------------------------------------------------------
// Driver 1 — plugin contribution FAMILIES (the canonical `PLUGIN_CORE_*` list,
// narrowed to the plugin-UI + browser surface families that §0.2 owns). Every
// in-scope family must resolve to a live owner, never silently absent.
// ---------------------------------------------------------------------------

const IN_SCOPE_FAMILY_OWNERS: Readonly<
  Record<string, Readonly<{ status: CoverageStatus; owner: string }>>
> = Object.freeze({
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
// Driver 2 — normalized destination slots. The Registry admits the direct V2
// container/target pair; each row is owned by the plugin host projection
// substrate. A slot is not itself proof of a mounted presentation, so it must
// not be reported as `surfaced`. The separate reachability facts below close
// the false renderer-set-is-mounted path without turning this generic inventory
// into a second runtime authority.
// ---------------------------------------------------------------------------

function buildDestinationSlotItems(): readonly CoverageItem[] {
  return PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot): CoverageItem => {
    return {
      key: `destinationSlot:${slot.container}:${slot.targetKind}`,
      family: 'destinationSlot',
      owner: `Plugin UI destination registry ${slot.container}/${slot.targetKind}`,
      status: 'plugin-host-owned',
    };
  });
}

type DestinationSlotKey = `${PluginUiContainerV1}:${PluginUiTargetKindV1}`;
type DestinationReachabilityStage =
  | 'declaration'
  | 'projection'
  | 'launcherOrOpenPath'
  | 'productionShell'
  | 'decidingTest';
type DestinationReachabilityProofReferences = Readonly<
  Record<DestinationReachabilityStage, string>
>;

type DestinationReachabilitySourceCheck = Readonly<{
  sourcePath: string;
  codeIdentifier: string;
}>;

type DestinationReachabilitySourceProof = Readonly<{
  stage: DestinationReachabilityStage;
  ref: string;
  sourcePath: string;
  codeIdentifier: string;
  additionalSourceChecks?: readonly DestinationReachabilitySourceCheck[];
  supportedSlotKeys: readonly DestinationSlotKey[];
}>;

/**
 * Test-owned relation from every admitted direct destination slot to the real
 * declaration, projection, launcher, shell, and deciding-test owners. The
 * public Protocol slot stays limited to routing/admission facts; adding a slot
 * without this proof table must fail the closure below.
 */
const DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT: Readonly<
  Partial<Record<DestinationSlotKey, DestinationReachabilityProofReferences>>
> = Object.freeze({
  'appPage:app': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'pluginAppPageNavigation',
    productionShell: 'PluginAppPageScreen',
    decidingTest: 'PluginAppPageScreen',
  },
  'settingsPage:app': {
    declaration: 'ui.settingsPages',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'useResolvedSettingsPageCatalog',
    productionShell: 'PluginSettingsPageScreen',
    decidingTest: 'PluginSettingsPageScreen',
  },
  'rightSidebarTab:app': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'resolveRightSidebarPluginTabs',
    productionShell: 'AppScopeRightSidebar',
    decidingTest: 'AppScopeRightSidebar',
  },
  'rightSidebarTab:session': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'resolveRightSidebarPluginTabs',
    productionShell: 'SessionRightPanel',
    decidingTest: 'SessionRightPanelRightSidebarRegistry',
  },
  'rightSidebarTab:project': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'resolveRightSidebarPluginTabs',
    productionShell: 'ProjectRightPanel',
    decidingTest: 'ProjectRightPanelRightSidebarRegistry',
  },
  'rightPane:session': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginSurfaceDestinationOpenSurfaceHandler',
    productionShell: 'AppPaneScopeHost',
    decidingTest: 'AppPaneScopeHostPluginSurfacePanels',
  },
  'rightPane:project': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginSurfaceDestinationOpenSurfaceHandler',
    productionShell: 'AppPaneScopeHost',
    decidingTest: 'AppPaneScopeHostPluginSurfacePanels',
  },
  'detailsTab:session': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginDetailsDestinationOpenSurfaceHandler',
    productionShell: 'PluginDetailsDestination',
    decidingTest: 'pluginDetailsDestination',
  },
  'detailsTab:project': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginDetailsDestinationOpenSurfaceHandler',
    productionShell: 'PluginDetailsDestination',
    decidingTest: 'pluginDetailsDestination',
  },
  'detailsPane:session': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginDetailsDestinationOpenSurfaceHandler',
    productionShell: 'PluginDetailsPaneOverlay',
    decidingTest: 'PluginDetailsPaneOverlay',
  },
  'detailsPane:project': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginDetailsDestinationOpenSurfaceHandler',
    productionShell: 'PluginDetailsPaneOverlay',
    decidingTest: 'PluginDetailsPaneOverlay',
  },
  'bottomPane:session': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginSurfaceDestinationOpenSurfaceHandler',
    productionShell: 'AppPaneScopeHost',
    decidingTest: 'AppPaneScopeHostPluginSurfacePanels',
  },
  'bottomPane:project': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'createPluginSurfaceDestinationOpenSurfaceHandler',
    productionShell: 'AppPaneScopeHost',
    decidingTest: 'AppPaneScopeHostPluginSurfacePanels',
  },
  'browserPanel:browser': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'BrowserSurfaceHost',
    productionShell: 'BrowserSurfaceHost',
    decidingTest: 'BrowserPluginSurfacePlacements',
  },
  'servicesPanel:services': {
    declaration: 'ui.views',
    projection: 'buildPluginProjectionV2',
    launcherOrOpenPath: 'LocalServicesSurfaceHost',
    productionShell: 'LocalServicesSurfaceHost',
    decidingTest: 'LocalServicesSurfaceHost',
  },
});

const EVIDENCED_DESTINATION_SLOT_KEYS: readonly DestinationSlotKey[] = Object.freeze(
  PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot) => (
    destinationSlotKey(slot.container, slot.targetKind)
  )),
);

/**
 * Test-only source proofs, grouped by the real producer/consumer reference
 * rather than duplicated per slot. `supportedSlotKeys` is deliberately a
 * narrow relation oracle: it detects a copied, but otherwise real, reference
 * being attached to the wrong admitted destination without becoming a runtime
 * registry, projection, or mounted predicate.
 */
const DESTINATION_REACHABILITY_SOURCE_PROOFS_V1 = [
  {
    stage: 'declaration',
    ref: 'ui.views',
    sourcePath: 'packages/protocol/src/plugins/contributions/ui/v2.ts',
    codeIdentifier: 'PluginUiViewV2Schema',
    supportedSlotKeys: EVIDENCED_DESTINATION_SLOT_KEYS.filter((key) => key !== 'settingsPage:app'),
  },
  {
    stage: 'declaration',
    ref: 'ui.settingsPages',
    sourcePath: 'packages/protocol/src/plugins/contributions/ui/v2.ts',
    codeIdentifier: 'PluginUiSettingsPageV1Schema',
    supportedSlotKeys: ['settingsPage:app'],
  },
  {
    stage: 'projection',
    ref: 'buildPluginProjectionV2',
    sourcePath: 'apps/cli/src/plugins/projection/registry/projection/v2.ts',
    codeIdentifier: 'pluginUiProjectionFamily,',
    additionalSourceChecks: [
      {
        sourcePath: 'apps/cli/src/plugins/projection/registry/ui/projection.ts',
        codeIdentifier: 'normalizePluginUiDestinationBindingV1({',
      },
      {
        sourcePath: 'apps/cli/src/plugins/projection/registry/ui/projection.ts',
        codeIdentifier: 'const binding = normalizePluginUiSettingsPageBindingV1({',
      },
    ],
    supportedSlotKeys: EVIDENCED_DESTINATION_SLOT_KEYS,
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'pluginAppPageNavigation',
    sourcePath: 'apps/ui/sources/components/appShell/plugins/pluginAppPageNavigation.ts',
    codeIdentifier: 'export function usePluginAppPageDestinationHandler',
    supportedSlotKeys: ['appPage:app'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'useResolvedSettingsPageCatalog',
    sourcePath: 'apps/ui/sources/components/settings/catalog/runtime/useResolvedSettingsPageCatalog.ts',
    codeIdentifier: 'export function useResolvedSettingsPageCatalog',
    supportedSlotKeys: ['settingsPage:app'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'resolveRightSidebarPluginTabs',
    sourcePath: 'apps/ui/sources/components/appShell/rightSidebar/rightSidebarPluginTabs.ts',
    codeIdentifier: 'export function resolveRightSidebarPluginTabs',
    supportedSlotKeys: ['rightSidebarTab:app', 'rightSidebarTab:session', 'rightSidebarTab:project'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'createPluginSurfaceDestinationOpenSurfaceHandler',
    sourcePath: 'apps/ui/sources/components/plugins/surfaces/pluginSurfaceDestinationNavigation.ts',
    codeIdentifier: 'export function createPluginSurfaceDestinationOpenSurfaceHandler',
    supportedSlotKeys: ['rightPane:session', 'rightPane:project', 'bottomPane:session', 'bottomPane:project'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'createPluginDetailsDestinationOpenSurfaceHandler',
    sourcePath: 'apps/ui/sources/components/appShell/panes/details/surfaces/pluginDetailsDestination.tsx',
    codeIdentifier: 'export function createPluginDetailsDestinationOpenSurfaceHandler',
    supportedSlotKeys: ['detailsTab:session', 'detailsTab:project', 'detailsPane:session', 'detailsPane:project'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'BrowserSurfaceHost',
    sourcePath: 'apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx',
    codeIdentifier: 'export function BrowserSurfaceHost',
    supportedSlotKeys: ['browserPanel:browser'],
  },
  {
    stage: 'launcherOrOpenPath',
    ref: 'LocalServicesSurfaceHost',
    sourcePath: 'apps/ui/sources/components/sessions/localServices/LocalServicesSurfaceHost.tsx',
    codeIdentifier: 'export function LocalServicesSurfaceHost',
    supportedSlotKeys: ['servicesPanel:services'],
  },
  {
    stage: 'productionShell',
    ref: 'PluginAppPageScreen',
    sourcePath: 'apps/ui/sources/components/appShell/plugins/PluginAppPageScreen.tsx',
    codeIdentifier: 'placement={page.placement}',
    supportedSlotKeys: ['appPage:app'],
  },
  {
    stage: 'productionShell',
    ref: 'PluginSettingsPageScreen',
    sourcePath: 'apps/ui/sources/components/settings/plugins/PluginSettingsPageScreen.tsx',
    codeIdentifier: '<PluginSettingsPageHost',
    supportedSlotKeys: ['settingsPage:app'],
  },
  {
    stage: 'productionShell',
    ref: 'AppScopeRightSidebar',
    sourcePath: 'apps/ui/sources/components/appShell/rightSidebar/AppScopeRightSidebar.tsx',
    codeIdentifier: 'placement={activePlacement}',
    supportedSlotKeys: ['rightSidebarTab:app'],
  },
  {
    stage: 'productionShell',
    ref: 'SessionRightPanel',
    sourcePath: 'apps/ui/sources/components/sessions/panes/SessionRightPanel.tsx',
    codeIdentifier: 'placement={tab.placement}',
    supportedSlotKeys: ['rightSidebarTab:session'],
  },
  {
    stage: 'productionShell',
    ref: 'ProjectRightPanel',
    sourcePath: 'apps/ui/sources/components/projects/detail/ProjectRightPanel.tsx',
    codeIdentifier: 'placement={tab.placement}',
    supportedSlotKeys: ['rightSidebarTab:project'],
  },
  {
    stage: 'productionShell',
    ref: 'AppPaneScopeHost',
    sourcePath: 'apps/ui/sources/components/appShell/panes/AppPaneScopeHost.tsx',
    codeIdentifier: '<PluginAppPaneSurface',
    supportedSlotKeys: ['rightPane:session', 'rightPane:project', 'bottomPane:session', 'bottomPane:project'],
  },
  {
    stage: 'productionShell',
    ref: 'PluginDetailsDestination',
    sourcePath: 'apps/ui/sources/components/appShell/panes/details/surfaces/pluginDetailsDestination.tsx',
    codeIdentifier: 'placement={props.resolution.placement}',
    supportedSlotKeys: ['detailsTab:session', 'detailsTab:project'],
  },
  {
    stage: 'productionShell',
    ref: 'PluginDetailsPaneOverlay',
    sourcePath: 'apps/ui/sources/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay.tsx',
    codeIdentifier: 'placement={selection.placement}',
    supportedSlotKeys: ['detailsPane:session', 'detailsPane:project'],
  },
  {
    stage: 'productionShell',
    ref: 'BrowserSurfaceHost',
    sourcePath: 'apps/ui/sources/components/browser/surfaces/BrowserSurfaceHost.tsx',
    codeIdentifier: '<BrowserPluginSurfacePlacements',
    supportedSlotKeys: ['browserPanel:browser'],
  },
  {
    stage: 'productionShell',
    ref: 'LocalServicesSurfaceHost',
    sourcePath: 'apps/ui/sources/components/sessions/localServices/LocalServicesSurfaceHost.tsx',
    codeIdentifier: '<PluginSurfacePlacementStack',
    supportedSlotKeys: ['servicesPanel:services'],
  },
  {
    stage: 'decidingTest',
    ref: 'PluginAppPageScreen',
    sourcePath: 'apps/ui/sources/components/appShell/plugins/PluginAppPageScreen.test.tsx',
    codeIdentifier: 'expect(context.surface.mount).toEqual({',
    supportedSlotKeys: ['appPage:app'],
  },
  {
    stage: 'decidingTest',
    ref: 'PluginSettingsPageScreen',
    sourcePath: 'apps/ui/sources/components/settings/plugins/PluginSettingsPageScreen.test.tsx',
    codeIdentifier: 'expect(hostSpy).toHaveBeenCalledWith(expect.objectContaining({',
    supportedSlotKeys: ['settingsPage:app'],
  },
  {
    stage: 'decidingTest',
    ref: 'AppScopeRightSidebar',
    sourcePath: 'apps/ui/sources/components/appShell/rightSidebar/AppScopeRightSidebar.test.tsx',
    codeIdentifier: "expect(screen.findByTestId('plugin-host-renderer-descriptor-panel')).toBeTruthy();",
    supportedSlotKeys: ['rightSidebarTab:app'],
  },
  {
    stage: 'decidingTest',
    ref: 'SessionRightPanelRightSidebarRegistry',
    sourcePath: 'apps/ui/sources/components/sessions/panes/SessionRightPanel.rightSidebarRegistry.test.tsx',
    codeIdentifier: "expect(host.props.placement.descriptorId).toBe('review-panel');",
    supportedSlotKeys: ['rightSidebarTab:session'],
  },
  {
    stage: 'decidingTest',
    ref: 'ProjectRightPanelRightSidebarRegistry',
    sourcePath: 'apps/ui/sources/components/projects/detail/ProjectRightPanel.rightSidebarRegistry.test.tsx',
    codeIdentifier: "expect(host.props.placement.descriptorId).toBe('project-review-panel');",
    supportedSlotKeys: ['rightSidebarTab:project'],
  },
  {
    stage: 'decidingTest',
    ref: 'AppPaneScopeHostPluginSurfacePanels',
    sourcePath: 'apps/ui/sources/components/appShell/panes/AppPaneScopeHost.pluginSurfacePanels.test.tsx',
    codeIdentifier: "mountInstanceKey: 'instance-right',",
    supportedSlotKeys: ['rightPane:session', 'rightPane:project', 'bottomPane:session', 'bottomPane:project'],
  },
  {
    stage: 'decidingTest',
    ref: 'pluginDetailsDestination',
    sourcePath: 'apps/ui/sources/components/appShell/panes/details/surfaces/pluginDetailsDestination.test.ts',
    codeIdentifier: "expect(rendered.props).not.toHaveProperty('launchInput');",
    supportedSlotKeys: ['detailsTab:session', 'detailsTab:project'],
  },
  {
    stage: 'decidingTest',
    ref: 'PluginDetailsPaneOverlay',
    sourcePath: 'apps/ui/sources/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay.test.tsx',
    codeIdentifier: "screen.root.findByType('PluginSurfacePlacementHostStub' as never).props",
    supportedSlotKeys: ['detailsPane:session', 'detailsPane:project'],
  },
  {
    stage: 'decidingTest',
    ref: 'BrowserPluginSurfacePlacements',
    sourcePath: 'apps/ui/sources/components/browser/surfaces/BrowserPluginSurfacePlacements.test.tsx',
    codeIdentifier: "screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();",
    supportedSlotKeys: ['browserPanel:browser'],
  },
  {
    stage: 'decidingTest',
    ref: 'LocalServicesSurfaceHost',
    sourcePath: 'apps/ui/sources/components/sessions/localServices/LocalServicesSurfaceHost.test.tsx',
    codeIdentifier: "container: 'servicesPanel',",
    supportedSlotKeys: ['servicesPanel:services'],
  },
] as const satisfies readonly DestinationReachabilitySourceProof[];

const DESTINATION_REACHABILITY_STAGES = [
  'declaration',
  'projection',
  'launcherOrOpenPath',
  'productionShell',
  'decidingTest',
] as const satisfies readonly DestinationReachabilityStage[];

function destinationSlotKey(
  container: PluginUiContainerV1,
  targetKind: PluginUiTargetKindV1,
): DestinationSlotKey {
  return `${container}:${targetKind}` as DestinationSlotKey;
}

function destinationReachabilitySourceProofKey(
  stage: DestinationReachabilityStage,
  ref: string,
): string {
  return `${stage}:${ref}`;
}

/**
 * The master 03a-L0 ruling rejects these fixture-only App pane combinations
 * for Preview. App retains its routed page and right-sidebar destinations;
 * it does not gain a global AppPane scope merely because the generic pane
 * registry can describe one.
 */
const REJECTED_APP_WHOLE_PANE_SLOT_KEYS = [
  'rightPane:app',
  'detailsPane:app',
  'bottomPane:app',
] as const satisfies readonly DestinationSlotKey[];

/**
 * Every destination slot a MAINTAINED first-party or public-example producer
 * actually authors, pinned to the exact container/target tuple in its source.
 *
 * The `declaration` stage above proves only that the manifest GRAMMAR can
 * express a slot: `PluginUiViewV2Schema` backs fourteen of the fifteen rows, so
 * deleting the last real author of a container/target pair could not fail it.
 * This relation is the missing half — an authored declaration a reader can
 * delete and watch the closure go red.
 */
const MAINTAINED_AUTHORED_DESTINATION_DECLARATIONS_V1 = [
  {
    slotKey: 'appPage:app',
    sourcePath: 'packages/plugin-sdk/examples/public-authoring/definition.ts',
    codeIdentifier: ["                container: 'appPage',", "                target: { kind: 'app' },"].join('\n'),
  },
  {
    slotKey: 'settingsPage:app',
    sourcePath: 'packages/plugins/channels/src/manifest.ts',
    codeIdentifier: '  settingsPages: [{',
  },
  {
    slotKey: 'rightSidebarTab:app',
    sourcePath: 'packages/plugins/inspector/src/manifest.ts',
    codeIdentifier: ["    container: 'rightSidebarTab' as const,", "    target: { kind: 'app' as const },"].join('\n'),
  },
  {
    slotKey: 'rightSidebarTab:session',
    sourcePath: 'packages/plugins/triage/src/manifest.ts',
    codeIdentifier: ["        container: 'rightSidebarTab',", "        target: { kind: 'session' },"].join('\n'),
  },
  {
    slotKey: 'rightPane:session',
    sourcePath: 'packages/plugin-sdk/examples/public-authoring/definition.ts',
    codeIdentifier: ["                container: 'rightPane',", "                target: { kind: 'session' },"].join('\n'),
  },
  {
    slotKey: 'detailsTab:session',
    sourcePath: 'packages/plugin-sdk/examples/public-authoring/definition.ts',
    codeIdentifier: ["                container: 'detailsTab',", "                target: { kind: 'session' },"].join('\n'),
  },
  {
    slotKey: 'bottomPane:session',
    sourcePath: 'packages/plugin-sdk/examples/public-authoring/definition.ts',
    codeIdentifier: ["                container: 'bottomPane',", "                target: { kind: 'session' },"].join('\n'),
  },
  {
    slotKey: 'bottomPane:project',
    sourcePath: 'packages/plugin-sdk/examples/public-authoring/definition.ts',
    codeIdentifier: ["                container: 'bottomPane',", "                target: { kind: 'project' },"].join('\n'),
  },
  {
    slotKey: 'browserPanel:browser',
    sourcePath: 'packages/plugins/inspector/src/manifest.ts',
    codeIdentifier: [
      "    container: 'browserPanel' as const,",
      "    target: { kind: 'browser' as const, browserViewIdPath: '/browser/viewId' },",
    ].join('\n'),
  },
  {
    slotKey: 'servicesPanel:services',
    sourcePath: 'packages/plugins/inspector/src/manifest.ts',
    codeIdentifier: [
      "    container: 'servicesPanel' as const,",
      "    target: { kind: 'services' as const },",
    ].join('\n'),
  },
] as const satisfies readonly Readonly<{
  slotKey: DestinationSlotKey;
  sourcePath: string;
  codeIdentifier: string;
}>[];

/**
 * Admitted slots that NO maintained producer authors today. They still pass the
 * declaration/projection/launcher/shell/deciding-test relation above, so this
 * is the honest statement of what that relation cannot prove for them: the host
 * side exists, the author side is unexercised.
 *
 * This list is a ceiling, not a permit. Authoring one of these — or dropping the
 * last author of a slot that is currently proven — moves the computed set and
 * fails the closure, which is the point.
 *
 * Both directions are enforced against REAL SOURCE, not against the pinned list
 * alone. `readAuthoredDestinationSlotKeysFromSource` re-derives the authored set
 * by reading every maintained producer manifest, so a plugin that starts
 * authoring one of these slots fails the closure even though nobody edited the
 * relation above. Comparing the pinned rows only to each other was the earlier
 * shape, and it could not fail on a gain: a real `detailsPane:session` view
 * added to the public-authoring example left this ceiling green and stale.
 */
const DESTINATION_SLOTS_WITHOUT_MAINTAINED_AUTHORED_DECLARATION = [
  'rightSidebarTab:project',
  'rightPane:project',
  'detailsTab:project',
  'detailsPane:session',
  'detailsPane:project',
] as const satisfies readonly DestinationSlotKey[];

/**
 * The container/target TUPLE an authored view declares. The tuple, not the
 * container alone: `bottomPane` appears twice in one example for two different
 * targets, and reading only the container name would credit both slots to one
 * declaration.
 *
 * A target carries `kind` plus whatever else its own grammar requires — the
 * `browser` target also carries `browserViewIdPath`. Requiring `kind` to be the
 * target's ONLY member made this scanner structurally blind to every such slot:
 * `browserPanel:browser` was authored in `packages/plugins/inspector` while the
 * ceiling below still claimed nobody authored it, and the GAIN half could not
 * fail. Anything after `kind` up to the target's own closing brace is skipped.
 */
const AUTHORED_DESTINATION_TUPLE_PATTERN =
  /container:\s*'([A-Za-z]+)'(?:\s+as\s+const)?,\s*target:\s*\{\s*kind:\s*'([A-Za-z]+)'(?:\s+as\s+const)?(?:\s*,[^{}]*)?\s*\}/gu;

/**
 * Every destination slot a maintained producer AUTHORS TODAY, re-derived from
 * source instead of from the pinned relation.
 *
 * The producer set is DISCOVERED rather than listed — every plugin manifest and
 * every public SDK example — because a hand-listed producer set has the same
 * blind spot this function exists to remove: a brand-new plugin authoring a
 * slot nobody thought to scan. Settings pages are a separate grammar
 * (`ui.settingsPages` carries no `target`), so they are matched on their own
 * declaration.
 */
function readAuthoredDestinationSlotKeysFromSource(repoRoot: string): Set<string> {
  const producerSources: string[] = [];
  const pluginsDir = resolve(repoRoot, 'packages/plugins');
  for (const entry of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, entry, 'src', 'manifest.ts');
    if (existsSync(manifest)) producerSources.push(manifest);
  }
  const examplesDir = resolve(repoRoot, 'packages/plugin-sdk/examples');
  for (const entry of readdirSync(examplesDir)) {
    const definition = join(examplesDir, entry, 'definition.ts');
    if (existsSync(definition)) producerSources.push(definition);
  }
  // A discovery that found nothing would make every assertion below vacuous.
  expect(
    producerSources.length,
    'no maintained producer manifest or public example was discovered',
  ).toBeGreaterThan(0);

  const authored = new Set<string>();
  for (const path of producerSources) {
    const source = readFileSync(path, 'utf8');
    AUTHORED_DESTINATION_TUPLE_PATTERN.lastIndex = 0;
    let match = AUTHORED_DESTINATION_TUPLE_PATTERN.exec(source);
    while (match) {
      authored.add(`${match[1]}:${match[2]}`);
      match = AUTHORED_DESTINATION_TUPLE_PATTERN.exec(source);
    }
    if (/\n\s*settingsPages:\s*\[\{/u.test(source)) authored.add('settingsPage:app');
  }
  return authored;
}

// ---------------------------------------------------------------------------
// Historical placement-ID disposition. These strings are deliberately
// TEST-ONLY: L1 removed their production schema, parser, and mounted-placement
// predicate. The list preserves the approved compatibility audit boundary
// without reviving a runtime registry or an ingress adapter that has no
// released-provenance consumer.
// ---------------------------------------------------------------------------

const HISTORICAL_CURRENT_UI_SURFACE_IDS = [
  'session.details',
  'session.preview',
  'session.tool',
  'session.side',
  'session.rightSidebarTab',
  'session.headerAction',
  'session.structuredMessage',
  'workspace.details',
  'workspace.main',
  'project.details',
  'project.main',
  'project.rightSidebarTab',
  'app.settingsPage',
  'app.rightSidebarTab',
  'app.sidePanel',
  'app.bottomPanel',
  'app.page',
  'browser.panel',
  'services.panel',
] as const;
type HistoricalCurrentUiSurfaceId = (typeof HISTORICAL_CURRENT_UI_SURFACE_IDS)[number];

type HistoricalCurrentUiSurfaceDisposition =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{
    kind: 'binding';
    container: PluginUiContainerV1;
    targetKind: PluginUiTargetKindV1;
  }>
  | Readonly<{
    kind: 'semantic';
    family: 'sessionHeaderActions';
  }>;

type HistoricalBindingDisposition = Extract<
  HistoricalCurrentUiSurfaceDisposition,
  Readonly<{ kind: 'binding' }>
>;
type HistoricalSemanticDisposition = Extract<
  HistoricalCurrentUiSurfaceDisposition,
  Readonly<{ kind: 'semantic' }>
>;
type HistoricalDispositionEntry = readonly [
  HistoricalCurrentUiSurfaceId,
  HistoricalCurrentUiSurfaceDisposition,
];
type HistoricalBindingEntry = readonly [
  HistoricalCurrentUiSurfaceId,
  HistoricalBindingDisposition,
];
type HistoricalSemanticEntry = readonly [
  HistoricalCurrentUiSurfaceId,
  HistoricalSemanticDisposition,
];

const HISTORICAL_CURRENT_UI_SURFACE_DISPOSITIONS: Readonly<
  Record<HistoricalCurrentUiSurfaceId, HistoricalCurrentUiSurfaceDisposition>
> = Object.freeze({
  'session.details': { kind: 'binding', container: 'detailsTab', targetKind: 'session' },
  'session.preview': { kind: 'removed' },
  'session.tool': { kind: 'removed' },
  'session.side': { kind: 'removed' },
  'session.rightSidebarTab': { kind: 'binding', container: 'rightSidebarTab', targetKind: 'session' },
  'session.headerAction': { kind: 'semantic', family: 'sessionHeaderActions' },
  'session.structuredMessage': { kind: 'removed' },
  'workspace.details': { kind: 'removed' },
  'workspace.main': { kind: 'removed' },
  'project.details': { kind: 'binding', container: 'detailsTab', targetKind: 'project' },
  'project.main': { kind: 'removed' },
  'project.rightSidebarTab': { kind: 'binding', container: 'rightSidebarTab', targetKind: 'project' },
  'app.settingsPage': { kind: 'binding', container: 'settingsPage', targetKind: 'app' },
  'app.rightSidebarTab': { kind: 'binding', container: 'rightSidebarTab', targetKind: 'app' },
  'app.sidePanel': { kind: 'removed' },
  'app.bottomPanel': { kind: 'removed' },
  'app.page': { kind: 'binding', container: 'appPage', targetKind: 'app' },
  'browser.panel': { kind: 'binding', container: 'browserPanel', targetKind: 'browser' },
  'services.panel': { kind: 'binding', container: 'servicesPanel', targetKind: 'services' },
});

function isHistoricalBindingDisposition(
  disposition: HistoricalCurrentUiSurfaceDisposition,
): disposition is HistoricalBindingDisposition {
  return disposition.kind === 'binding';
}

function isHistoricalSemanticDisposition(
  disposition: HistoricalCurrentUiSurfaceDisposition,
): disposition is HistoricalSemanticDisposition {
  return disposition.kind === 'semantic';
}

function isHistoricalBindingEntry(entry: HistoricalDispositionEntry): entry is HistoricalBindingEntry {
  return isHistoricalBindingDisposition(entry[1]);
}

function isHistoricalSemanticEntry(entry: HistoricalDispositionEntry): entry is HistoricalSemanticEntry {
  return isHistoricalSemanticDisposition(entry[1]);
}

// ---------------------------------------------------------------------------
// Driver 3 — runtime ACTION SPECS (the §12.4 "browser targets/actions, simulator
// actions, preview/tunnel routes, diagnostics families"). Status derives from
// the canonical `getActionSpec(id).surfaces.ui` flag (true = a real executor
// routes the id through the ActionExecutor front door) — NOT a hand list. Ids
// with no executor are `unimplemented` (must be in the deferred-allowlist).
// ---------------------------------------------------------------------------

function buildRuntimeActionItems(): readonly CoverageItem[] {
  return RUNTIME_ACTION_IDS_V1.map((id): CoverageItem => {
    const spec = getActionSpec(id);
    const surfacedOnUi = spec.surfaces.ui === true;
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
    ...buildDestinationSlotItems(),
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

  it('enumerates every direct destination slot (no silent drop)', () => {
    const destinationSlotKeys = new Set(
      matrix.filter((i) => i.family === 'destinationSlot').map((i) => i.key),
    );
    for (const slot of PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1) {
      expect(
        destinationSlotKeys.has(`destinationSlot:${slot.container}:${slot.targetKind}`),
        `destination slot '${slot.container}/${slot.targetKind}' must be classified`,
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

  it('no normalized destination slot remains unimplemented', () => {
    const unimplementedSlots = matrix.filter(
      (i) => i.family === 'destinationSlot' && i.status === 'unimplemented',
    );
    expect(unimplementedSlots.map((i) => i.key)).toEqual([]);
  });

  it('keeps mounted reachability proof identities in this closure owner, not Protocol slot data', () => {
    const admittedSlotKeys = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot) => (
      destinationSlotKey(slot.container, slot.targetKind)
    ));
    expect(Object.keys(DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT).sort()).toEqual(
      [...admittedSlotKeys].sort(),
    );

    const productionSlotsWithReachability = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1
      .filter((slot) => Object.prototype.hasOwnProperty.call(slot, 'reachability'))
      .map((slot) => destinationSlotKey(slot.container, slot.targetKind));
    expect(productionSlotsWithReachability).toEqual([]);
  });

  it('requires separate declaration, projection, launcher, and mount evidence for every evidenced public binding', () => {
    // RED discriminator: a renderer inventory was the retired false source of
    // mounted truth. It has none of the real path evidence and must stay false.
    expect(destinationSlotReachabilityFacts(undefined)).toEqual({
      declared: false,
      projected: false,
      launchable: false,
      mounted: false,
    });

    const slots = matrix.filter((item) => item.family === 'destinationSlot');
    expect(slots).toHaveLength(PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.length);
    const unprovenSlots = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.filter((slot) => (
      !hasFullDestinationReachability(
        destinationSlotReachabilityFacts(
          DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT[
            destinationSlotKey(slot.container, slot.targetKind)
          ],
        ),
      )
    ));
    expect(unprovenSlots.map((slot) => destinationSlotKey(slot.container, slot.targetKind))).toEqual([]);

    for (const slot of PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1) {
      const slotKey = destinationSlotKey(slot.container, slot.targetKind);
      expect(
        destinationSlotReachabilityFacts(DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT[slotKey]),
        `${slotKey} must name its declaration, projection producer, launcher/open path, production shell, and deciding test`,
      ).toEqual({
        declared: true,
        projected: true,
        launchable: true,
        mounted: true,
      });
    }
  });

  it('does not admit fixture-only App whole-pane bindings without an approved App shell journey', () => {
    const admittedAppWholePaneSlots = PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1
      .filter((slot) => REJECTED_APP_WHOLE_PANE_SLOT_KEYS.includes(
        destinationSlotKey(slot.container, slot.targetKind) as typeof REJECTED_APP_WHOLE_PANE_SLOT_KEYS[number],
      ))
      .map((slot) => destinationSlotKey(slot.container, slot.targetKind));

    expect(admittedAppWholePaneSlots).toEqual([]);
  });

  it('binds each reachability reference to its current source owner and supported destination slots', () => {
    const proofsByStageAndRef = new Map(
      DESTINATION_REACHABILITY_SOURCE_PROOFS_V1.map((proof) => [
        destinationReachabilitySourceProofKey(proof.stage, proof.ref),
        proof,
      ]),
    );
    expect(proofsByStageAndRef.size).toBe(DESTINATION_REACHABILITY_SOURCE_PROOFS_V1.length);

    const repoRoot = resolve(import.meta.dirname, '../../../../../..');
    const sourceByPath = new Map<string, string>();
    const usedProofKeys = new Set<string>();

    for (const slot of PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1) {
      const slotKey = destinationSlotKey(slot.container, slot.targetKind);
      const proofRefs = DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT[slotKey];
      if (proofRefs === undefined) {
        throw new Error(`${slotKey} has no test-owned reachability proof references`);
      }

      for (const stage of DESTINATION_REACHABILITY_STAGES) {
        const ref = proofRefs[stage];
        const proofKey = destinationReachabilitySourceProofKey(stage, ref);
        const proof = proofsByStageAndRef.get(proofKey);
        if (proof === undefined) {
          throw new Error(`${slotKey} has no source proof for ${stage}:${ref}`);
        }

        expect(
          proof.supportedSlotKeys,
          `${slotKey} must not borrow ${stage}:${ref} from an unrelated binding`,
        ).toContain(slotKey);

        const sourceChecks: readonly DestinationReachabilitySourceCheck[] = [
          { sourcePath: proof.sourcePath, codeIdentifier: proof.codeIdentifier },
          ...(proof.additionalSourceChecks ?? []),
        ];
        for (const sourceCheck of sourceChecks) {
          const source = sourceByPath.get(sourceCheck.sourcePath)
            ?? readFileSync(resolve(repoRoot, ...sourceCheck.sourcePath.split('/')), 'utf8');
          sourceByPath.set(sourceCheck.sourcePath, source);
          expect(
            source,
            `${stage}:${ref} must remain bound to ${sourceCheck.sourcePath}#${sourceCheck.codeIdentifier}`,
          ).toContain(sourceCheck.codeIdentifier);
        }
        usedProofKeys.add(proofKey);
      }
    }

    expect([...usedProofKeys].sort()).toEqual([...proofsByStageAndRef.keys()].sort());
  });

  it('keeps every claimed destination slot bound to a maintained producer that actually authors it', () => {
    const repoRoot = resolve(import.meta.dirname, '../../../../../..');
    const sourceByPath = new Map<string, string>();
    const admittedSlotKeys = new Set(PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map(
      (slot) => destinationSlotKey(slot.container, slot.targetKind),
    ));

    const authoredSlotKeys = new Set<DestinationSlotKey>();
    for (const declaration of MAINTAINED_AUTHORED_DESTINATION_DECLARATIONS_V1) {
      expect(
        admittedSlotKeys.has(declaration.slotKey),
        `${declaration.slotKey} is authored but is not an admitted destination slot`,
      ).toBe(true);
      expect(
        authoredSlotKeys.has(declaration.slotKey),
        `${declaration.slotKey} must name exactly one maintained authored declaration`,
      ).toBe(false);
      authoredSlotKeys.add(declaration.slotKey);

      const source = sourceByPath.get(declaration.sourcePath)
        ?? readFileSync(resolve(repoRoot, ...declaration.sourcePath.split('/')), 'utf8');
      sourceByPath.set(declaration.sourcePath, source);
      // The whole point of this row: the exact container/target TUPLE, not a
      // container name that a nearby unrelated view could satisfy.
      expect(
        source,
        `${declaration.slotKey} claims a maintained author at ${declaration.sourcePath}, but that declaration is gone`,
      ).toContain(declaration.codeIdentifier);
    }

    // The GAIN half. Everything above can only notice a pinned declaration that
    // disappeared; a producer that STARTS authoring an admitted slot moves no
    // pinned row, so without this the ceiling below stays green while going
    // stale — and its own failure message promises to catch exactly that.
    const observedAuthoredSlotKeys = [...readAuthoredDestinationSlotKeysFromSource(repoRoot)]
      .filter((slotKey) => admittedSlotKeys.has(slotKey as DestinationSlotKey))
      .sort();
    expect(
      observedAuthoredSlotKeys,
      'a maintained producer authors an admitted destination slot the authored-declaration relation does not name',
    ).toEqual([...authoredSlotKeys].sort());

    const unauthoredSlotKeys = [...admittedSlotKeys]
      .filter((slotKey) => !authoredSlotKeys.has(slotKey))
      .sort();
    expect(
      unauthoredSlotKeys,
      'a destination slot gained or lost its maintained author; update the authored-declaration relation',
    ).toEqual([...DESTINATION_SLOTS_WITHOUT_MAINTAINED_AUTHORED_DECLARATION].sort());
  });

  it('no contribution family remains unimplemented', () => {
    const dead = matrix.filter(
      (i) => i.family === 'contributionFamily' && i.status === 'unimplemented',
    );
    expect(dead.map((i) => i.key)).toEqual([]);
  });

  it('the deferred set is bounded and runtime-action-scoped (no creeping deferrals)', () => {
    // Every deferral is a runtime action (the only in-scope family that legitimately
    // carries labeled support-matrix deferrals). Families/destination slots must
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
// Historical UI placement disposition — this is intentionally separate from
// destination-slot coverage. A retained semantic family is real, but it is not
// a page/pane placement and must never acquire a mounted-slot claim by sharing
// the generic coverage inventory.
// ===========================================================================

describe('coverage matrix — historical UI surface disposition', () => {
  const entries: readonly HistoricalDispositionEntry[] = HISTORICAL_CURRENT_UI_SURFACE_IDS.map((id) => [
    id,
    HISTORICAL_CURRENT_UI_SURFACE_DISPOSITIONS[id],
  ] as const);

  it('keeps the exact disjoint 18 placement candidates plus 1 semantic family', () => {
    expect(HISTORICAL_CURRENT_UI_SURFACE_IDS).toHaveLength(19);
    expect(new Set(HISTORICAL_CURRENT_UI_SURFACE_IDS).size).toBe(19);

    const bindings = entries.filter(isHistoricalBindingEntry);
    const removed = entries.filter(([, disposition]) => disposition.kind === 'removed');
    const semantic = entries.filter(isHistoricalSemanticEntry);

    expect(bindings.map(([id, disposition]) => (
      `${id}->${disposition.container}/${disposition.targetKind}`
    ))).toEqual([
      'session.details->detailsTab/session',
      'session.rightSidebarTab->rightSidebarTab/session',
      'project.details->detailsTab/project',
      'project.rightSidebarTab->rightSidebarTab/project',
      'app.settingsPage->settingsPage/app',
      'app.rightSidebarTab->rightSidebarTab/app',
      'app.page->appPage/app',
      'browser.panel->browserPanel/browser',
      'services.panel->servicesPanel/services',
    ]);
    expect(removed.map(([id]) => id)).toEqual([
      'session.preview',
      'session.tool',
      'session.side',
      'session.structuredMessage',
      'workspace.details',
      'workspace.main',
      'project.main',
      'app.sidePanel',
      'app.bottomPanel',
    ]);
    expect(semantic.map(([id, disposition]) => `${id}->${disposition.family}`)).toEqual([
      'session.headerAction->sessionHeaderActions',
    ]);

    expect(bindings).toHaveLength(9);
    expect(removed).toHaveLength(9);
    expect(semantic).toHaveLength(1);
    expect(bindings.length + removed.length + semantic.length).toBe(19);
  });

  it('keeps retained placement successors direct and fully evidenced', () => {
    const slotsByKey = new Map(
      PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot) => [
        `${slot.container}:${slot.targetKind}`,
        slot,
      ]),
    );
    const unprovenHistoricalBindings: HistoricalCurrentUiSurfaceId[] = [];
    for (const [historicalId, disposition] of entries) {
      if (!isHistoricalBindingDisposition(disposition)) continue;
      const slot = slotsByKey.get(`${disposition.container}:${disposition.targetKind}`);
      expect(
        slot,
        `${historicalId} must resolve only to an admitted direct destination slot`,
      ).toBeDefined();
      const proofRefs = DESTINATION_REACHABILITY_PROOF_REFS_BY_SLOT[
        destinationSlotKey(disposition.container, disposition.targetKind)
      ];
      if (!hasFullDestinationReachability(destinationSlotReachabilityFacts(proofRefs))) {
        unprovenHistoricalBindings.push(historicalId);
      }
    }
    expect(unprovenHistoricalBindings).toEqual([]);
  });

  it('retains semantic families without admitting them to mounted-placement coverage', () => {
    const canonicalFamilies = new Set(PLUGIN_CORE_CONTRIBUTION_FAMILIES_V2.map((family) => family.family));
    const semanticIds = entries
      .filter(isHistoricalSemanticEntry)
      .map(([id, disposition]) => ({ id, family: disposition.family }));
    expect(semanticIds).toEqual([
      { id: 'session.headerAction', family: 'sessionHeaderActions' },
    ]);
    for (const semantic of semanticIds) {
      expect(canonicalFamilies.has(semantic.family), `${semantic.id} must remain a real semantic family`).toBe(true);
    }

    const historicalMountedIds = entries
      .filter(isHistoricalBindingEntry)
      .map(([id]) => id);
    expect(historicalMountedIds).not.toContain('session.headerAction');
    expect(historicalMountedIds).not.toContain('session.structuredMessage');
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
      unsurfaced: 0,
      unimplemented: 0,
    };
    for (const item of matrix) counts[item.status] += 1;

    // UNSURFACED (DZ-2) = statically-unbacked simulator ids only. Destination
    // slots are admission records, not claims that a presentation is mounted.
    const staticallyUnbackedSimulatorCount = ACTION_ID_FAMILIES_V1.devices_simulator.filter(
      (id) => classifySimulatorRuntimeActionBackingV1(id as never) === 'statically-unbacked',
    ).length;
    expect(counts.unsurfaced).toBe(staticallyUnbackedSimulatorCount);

    // The only `unimplemented` items are the labeled runtime-action deferrals. Forward-only
    // ratchet (DZ-1): this is `<=`, never equality — when a deferred id ships, its
    // status flips to runtime-owned and `unimplemented` falls below the allowlist
    // size until the allowlist entry is pruned. Equality here was the inverted
    // invariant that turned shipping a deferred id into a build break.
    expect(counts.unimplemented).toBeLessThanOrEqual(Object.keys(DEFERRED_ALLOWLIST).length);
    expect(counts['plugin-host-owned']).toBe(
      Object.keys(IN_SCOPE_FAMILY_OWNERS).length + PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.length,
    );
    expect(counts.surfaced).toBe(0);
  });
});
