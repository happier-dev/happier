import { registryUpstreamEqualV1 } from '@happier-dev/protocol/registries';
import type {
  RegistryContentRefV1,
  RegistryUpdateCheckResultV1,
  RegistryUpstreamV1,
} from '@happier-dev/protocol/registries';

import { describeRegistrySourceStatus, type RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';
import type { RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';
import { contentRefLabel } from '@/components/settings/skills/updates/useSkillsUpdates';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

import type { ManagedInventoryRow as InstalledRow } from '../inventory/useManagedInventory';
import type { BrowserExtensionActionIntent } from '../catalog/storeBrowserExtensions';
import type { StorePluginUpdateEntry } from './useStorePluginUpdates';

/** The kinds whose owners record where they came from and what that source says now (the registry trackers). */
export const STORE_UPDATE_KINDS = [
  'app',
  'mcpServer',
  'skill',
  'agent',
  'browserExtension',
  'plugin',
] as const;
export type StoreUpdateKind = typeof STORE_UPDATE_KINDS[number];

export type StoreUpdateEntry = Readonly<{
  key: string;
  row: InstalledRow;
  /** Exact placement of a daemon-qualified observation; absent for Account-level observations. */
  machineId?: string;
  /**
   * `available`: a newer version is waiting and the person never changed theirs. `needsChoice`: they changed it and
   * the source changed too (Skills asks per file). `removed`: the source no longer lists it. `unchecked`: the last
   * check could not reach the source and nothing recorded says a newer version is waiting. `current` keeps an
   * installed browser extension visible after its owner confirms the installed version is up to date.
   */
  state: 'available' | 'needsChoice' | 'removed' | 'unchecked' | 'current';
  reason?: RegistryFailureStatus;
  status?: CapabilityStatus;
  from: string | null;
  to: string | null;
  /** The native update Action binds the exact version selected by the registry check. */
  apply?: Extract<BrowserExtensionActionIntent, { actionId: 'browser.extensions.update' }>;
  /** App updates open the Environment's existing template review; this is navigation, never an apply operation. */
  review?: Readonly<{ kind: 'environmentTemplateUpdate'; href: string }>;
}>;

export type StoreUpdatesView = Readonly<{
  /** Last complete check of these held rows; null is unknown, including before the first check. */
  count: number | null;
  sections: readonly Readonly<{
    kind: StoreUpdateKind;
    entries: readonly StoreUpdateEntry[];
  }>[];
  /** Held items that came from a source that can publish a newer version; zero means "up to date" would mean nothing. */
  tracked: number;
  /** Items the latest check could not reach, by their source's failure. */
  unchecked: number;
  /** Coverage of the latest finite reply, restricted to still-current held subjects. */
  freshness: Readonly<{ checked: number; tracked: number; checkedAt: number | null }>;
}>;

type Tracked = Readonly<{
  kind: StoreUpdateKind;
  key: string;
  upstream: RegistryUpstreamV1 | undefined;
  current: RegistryContentRefV1 | null;
  modified: boolean;
  basis: string;
}>;

/** The owner's own record of where an installed thing came from; null when nothing upstream can publish a newer one. */
function readTracked(row: InstalledRow): Tracked | null {
  switch (row.kind) {
    case 'app':
      return { kind: 'app', key: row.native.environment.id, upstream: undefined, current: null, modified: false,
        basis: JSON.stringify([row.native.environment.id, row.native.environment.revision]) };
    case 'browserExtension': {
      if (row.subject !== 'extension') return null;
      const extension = row.native.extension;
      return { kind: 'browserExtension', key: JSON.stringify([row.native.profileId, extension.id]),
        upstream: extension.upstream, current: { kind: 'version', version: extension.version }, modified: false,
        basis: JSON.stringify([extension.source, extension.provenance, extension.version, extension.upstream]) };
    }
    case 'skill': {
      const provenance = row.native.provenance;
      if (
        provenance.kind !== 'registry' &&
        provenance.kind !== 'link' &&
        provenance.kind !== 'wellKnown'
      )
        return null;
      const current =
        provenance.kind === 'registry'
          ? provenance.registry.ref
          : provenance.kind === 'link'
            ? provenance.ref
            : provenance;
      return {
        kind: 'skill',
        key: row.native.skillId,
        upstream: row.native.upstream,
        current,
        modified: row.native.modified,
        basis: JSON.stringify([provenance, row.native.revision]),
      };
    }
    case 'mcpServer': {
      const origin = row.native.origin;
      if (origin?.kind !== 'registry') return null;
      return {
        kind: 'mcpServer',
        key: row.native.id,
        upstream: origin.upstream,
        current: origin.provenance.ref ?? null,
        modified: false,
        basis: JSON.stringify([origin.provenance, row.native.updatedAt, origin.upstream]),
      };
    }
    case 'agent': {
      if (row.subject !== 'definition' || !row.native.origin) return null;
      const origin = row.native.origin;
      return {
        kind: 'agent',
        key: row.native.id,
        upstream: origin.upstream,
        current: origin.provenance.ref ?? null,
        modified: false,
        basis: JSON.stringify([origin.provenance, row.native.updatedAt, origin.upstream]),
      };
    }
    default:
      return null;
  }
}

/** Capture only held provenance/revisions, once on explicit Check; never acquire another inventory. */
export function captureStoreUpdateBasis(rows: readonly InstalledRow[]): ReadonlyMap<string, string> {
  const basis = new Map<string, string>();
  for (const row of rows) {
    const item = readTracked(row);
    if (item) basis.set(row.key, item.basis);
  }
  return basis;
}

/**
 * Store → Updates: the owners' recorded observations, overlaid by this page's latest finite check. A failed check
 * never turns into "current": it keeps a recorded newer version and otherwise says it could not check.
 */
export function buildStoreUpdates(
  rows: readonly InstalledRow[],
  results: RegistryUpdateCheckResultV1['results'],
  check?: Pick<RegistryUpdateCheckState, 'checkedAt' | 'failed' | 'basis' | 'attemptedAt'>,
  plugins: readonly StorePluginUpdateEntry[] = [],
): StoreUpdatesView {
  const pluginUpdates = new Map<string, StorePluginUpdateEntry[]>();
  for (const update of plugins) {
    const entries = pluginUpdates.get(update.key);
    if (entries) entries.push(update); else pluginUpdates.set(update.key, [update]);
  }
  const checked = new Map(
    results.map((result) => [result.kind === 'browserExtension'
      ? JSON.stringify([result.kind, result.machineId, result.key])
      : `${result.kind}:${result.key}`, result.upstream]),
  );
  const byKind = new Map<StoreUpdateKind, StoreUpdateEntry[]>();
  let tracked = 0;
  let unchecked = 0;
  let successful = 0;
  let complete = check?.checkedAt != null && !check.failed;
  for (const row of rows) {
    if (row.kind === 'plugin') {
      tracked += 1;
      const updates = pluginUpdates.get(row.key);
      if (!updates?.length) { complete = false; continue; }
      if (updates.some(update => update.state === 'unchecked')) { unchecked += 1; complete = false; }
      if (updates.every(update => update.observation && update.state !== 'unchecked')) successful += 1;
      for (const update of updates) {
        if (!update.observation) { complete = false; continue; }
        const pluginEntry: StoreUpdateEntry | null = update.state === 'unchecked'
          ? { key: row.key, row, state: 'unchecked', reason: update.reason, from: update.from, to: null }
          : update.state === 'available' && update.observation.state === 'update_available'
            ? { key: row.key, row, state: 'available', from: update.from, to: update.observation.latest ? contentRefLabel(update.observation.latest) : null }
            : update.state === 'removed'
              ? { key: row.key, row, state: 'removed', status: { kind: 'removed' }, from: update.from, to: null }
              : null;
        if (pluginEntry) {
          const entries = byKind.get('plugin');
          const placed = update.machineId ? { ...pluginEntry, key: JSON.stringify([row.key, update.machineId]), machineId: update.machineId } : pluginEntry;
          if (entries) entries.push(placed);
          else byKind.set('plugin', [placed]);
        }
      }
      continue;
    }
    // App provenance stays private to the Environment. Only its tracker's supplied observations establish tracking.
    if (row.kind === 'app' && !checked.has(`app:${row.native.environment.id}`)) continue;
    const item = readTracked(row);
    if (!item) continue;
    tracked += 1;
    const finite = checked.get(row.kind === 'browserExtension'
      ? JSON.stringify([item.kind, row.machineId, item.key])
      : `${item.kind}:${item.key}`);
    const latest = check?.basis && check.basis.get(row.key) !== item.basis ? undefined : finite;
    const recorded = item.upstream;
    // Recording this check can advance the native revision before its reply arrives.
    if (finite && finite.state !== 'unchecked' && (latest || registryUpstreamEqualV1(recorded, finite))) successful += 1;
    // A new item was never checked. An advanced native version may supersede
    // the checked one only when its owner has an explicit observation.
    if (!finite || finite.state === 'unchecked' || !latest && !recorded) complete = false;
    let entry: StoreUpdateEntry | null = null;
    const from = item.current ? contentRefLabel(item.current) : null;
    if (latest?.state === 'unchecked') {
      unchecked += 1;
      entry =
        recorded?.state === 'update_available' ||
        recorded?.state === 'removed_from_source'
          ? null
          : {
              key: row.key,
              row,
              state: 'unchecked',
              reason: latest.reason,
              from,
              to: null,
            };
    }
    const upstream = latest && latest.state !== 'unchecked' ? latest : recorded;
    if (!entry && upstream?.state === 'update_available') {
      entry = {
        key: row.key,
        row,
        state: item.modified ? 'needsChoice' : 'available',
        from,
        to: upstream.latest ? contentRefLabel(upstream.latest) : null,
        ...(row.kind === 'browserExtension' && row.subject === 'extension' && upstream.latest?.kind === 'version' ? {
          apply: { actionId: 'browser.extensions.update' as const, input: { machineId: row.machineId,
            profileId: row.native.profileId, extensionId: row.native.extension.id, expectedVersion: upstream.latest.version } },
        } : {}),
      };
    } else if (!entry && upstream?.state === 'removed_from_source') {
      entry = { key: row.key, row, state: 'removed', status: { kind: 'removed' }, from, to: null };
    } else if (!entry && row.kind === 'browserExtension' && upstream?.state === 'current') {
      entry = { key: row.key, row, state: 'current', from, to: null };
    }
    if (!entry) continue;
    if (row.kind === 'app') entry = { ...entry, review: { kind: 'environmentTemplateUpdate', href: row.home } };
    const list = byKind.get(item.kind);
    if (list) list.push(entry);
    else byKind.set(item.kind, [entry]);
  }
  const sections = STORE_UPDATE_KINDS.flatMap((kind) =>
    byKind.has(kind) ? [{ kind, entries: byKind.get(kind)! }] : [],
  );
  return {
    count: complete ? sections.reduce((total, section) => total + section.entries.filter(entry => entry.state !== 'current').length, 0) : null,
    sections,
    tracked,
    unchecked,
    freshness: { checked: successful, tracked, checkedAt: check?.attemptedAt ?? check?.checkedAt ?? null },
  };
}

/**
 * One line per failing source and reason, naming the source the native result labelled (`sourceTitle`, else
 * `sourceId`). A result without a label stays unlabeled: the reason alone, never an invented name.
 */
export function describeUncheckedSources(
  results: RegistryUpdateCheckResultV1['results'],
): string[] {
  const lines = new Set<string>();
  for (const result of results) {
    if (result.upstream.state !== 'unchecked') continue;
    const reason = describeRegistrySourceStatus(result.upstream.reason);
    const source = result.sourceTitle ?? result.sourceId;
    lines.add(source ? `${source} · ${reason}` : reason);
  }
  return [...lines];
}

/** Placement comes from native inventory, never from the Machine being viewed or its availability. */
export function readStoreUpdateMachineIds(entry: StoreUpdateEntry): readonly string[] {
  const row = entry.row;
  if (entry.machineId) return [entry.machineId];
  switch (row.kind) {
    case 'app': {
      const link = row.native.runtimeTargetLink;
      return link?.source.kind === 'host' ? link.machines : link?.machineId ? [link.machineId] : [];
    }
    case 'browserExtension': return [row.machineId];
    case 'plugin': return [...new Set(row.installations.map(installation => installation.materialization.machineId))];
    // Reach is an owner's explicit enabled placement, not a local availability inference.
    case 'skill':
    case 'mcpServer': return row.reach.filter(machine => machine.agents.some(agent => agent.enabled)).map(machine => machine.machineId);
    // Account Agent definitions have no Machine membership; executable Agent CLIs already have their own update items.
    default: return [];
  }
}
