import { isSameActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { mergeMachineSetupsV1, readMachineSetupAppIdentityV1, readMachineSetupRecipeIdentityV1, type MachinePresetItemV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { InputOptionValue } from '@happier-dev/protocol/inputs/inputFields';
import { listMachineSetupAdaptersV1, type BuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

type Items = readonly MachinePresetItemV1[];
export type MachineSetupItemKind = MachinePresetItemV1['kind'];

/** Apply order the editor presents: setup, software, Agents, then Apps. */
const GROUP_ORDER: readonly MachineSetupItemKind[] = [
  'setupRecipe',
  'softwareRecipe',
  'agent',
  'app',
];

/**
 * The preset's one ordered item list, shown by kind. Each row keeps its stored index so every edit
 * writes back to the same single array; nothing is copied into a second per-group list.
 */
export function groupMachineSetupItems(items: Items | undefined) {
  return GROUP_ORDER.map((kind) => ({
    kind,
    rows: (items ?? []).flatMap((item, index) =>
      item.kind === kind ? [{ item, index }] : [],
    ),
  })).filter((group) => group.rows.length > 0);
}

/** Swap with the nearest item of the same kind; other kinds keep their places. */
export function moveMachineSetupItem<T extends Items>(
  items: T,
  index: number,
  direction: -1 | 1,
): T | MachinePresetItemV1[] {
  const kind = items[index]?.kind;
  if (!kind) return items;
  let target = index + direction;
  while (target >= 0 && target < items.length && items[target]!.kind !== kind)
    target += direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  next[index] = items[target]!;
  next[target] = items[index]!;
  return next;
}

/** Taking out the last item leaves no item list rather than an empty one. */
export function removeMachineSetupItem(
  items: Items,
  index: number,
): MachinePresetItemV1[] | undefined {
  const next = items.filter((_, at) => at !== index);
  return next.length ? next : undefined;
}

/** An App item's Environment name; its catalog pin or authored key (its identity) never changes. */
export function renameMachineSetupApp<T extends Items>(
  items: T,
  index: number,
  name: string,
): T | MachinePresetItemV1[] {
  const item = items[index];
  const trimmed = name.trim();
  if (item?.kind !== 'app' || !trimmed || trimmed === item.definition.name)
    return items;
  return items.map((entry, at) =>
    at === index
      ? { ...item, definition: { ...item.definition, name: trimmed } }
      : entry,
  );
}

/**
 * A catalog App's saved address for one template Domain. A blank hostname clears that selection, and an App with
 * none keeps no `domainBindings`; the template preparer validates the hostname when Setup reviews the App.
 */
export function setMachineSetupAppDomain<T extends Items>(
  items: T,
  index: number,
  templateDomainId: string,
  hostname: string,
): T | MachinePresetItemV1[] {
  const item = items[index];
  if (item?.kind !== 'app' || item.definition.definition.from !== 'catalogApp') return items;
  const trimmed = hostname.trim();
  const rest = (item.definition.domainBindings ?? []).filter((binding) => binding.templateDomainId !== templateDomainId);
  const domainBindings = trimmed ? [...rest, { templateDomainId, hostname: trimmed }] : rest;
  const { domainBindings: _previous, ...definition } = item.definition;
  const next = { ...item, definition: domainBindings.length ? { ...definition, domainBindings } : definition };
  return items.map((entry, at) => (at === index ? next : entry));
}

/** Every characterized global-install adapter, across the platforms the catalog declares: the toolchain's name owner. */
export function machineSetupAdapters(): readonly BuiltinNativeToolchainAdapterV1[] {
  const byId = new Map<string, BuiltinNativeToolchainAdapterV1>();
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const adapter of listMachineSetupAdaptersV1(platform))
      if (!byId.has(adapter.id)) byId.set(adapter.id, adapter);
  }
  return [...byId.values()];
}

/** Catalog Agent identity and presentation for inert preset authoring. */
export type MachineSetupAgentOffer = Readonly<{ agentId: string; title: string; description?: string; icon?: string }>;

/** Declared Setup recipes an item is named from: native value, title, purpose and mark. */
export type MachineSetupRecipeOffer = Readonly<{ value: InputOptionValue; label: string; description?: string | null; icon?: string }>;

const sameRecipe = (value: InputOptionValue, ref: MachineRecipeReferenceV1) => !!value && typeof value === 'object'
  && !Array.isArray(value) && 'pluginId' in value && 'recipeId' in value
  && typeof value.pluginId === 'string' && typeof value.recipeId === 'string'
  && readMachineSetupRecipeIdentityV1({ pluginId: value.pluginId, recipeId: value.recipeId }) === readMachineSetupRecipeIdentityV1(ref);

/**
 * An item's name and purpose. A recipe resolves against the offer with its identical native value; a retired revision
 * keeps the offered title and says it is no longer offered, an unknown ref keeps its recipe id. `offered: null` means
 * the offers are not known (not read yet, unreadable, or an App), so nothing is claimed about availability.
 */
export function machineSetupItemPresentation(
  item: MachinePresetItemV1,
  offers: readonly MachineSetupRecipeOffer[] | null,
  agents: readonly MachineSetupAgentOffer[] | null = null,
): Readonly<{ title: string; description?: string; icon?: string; offered: boolean | null }> {
  if (item.kind === 'app') return { title: item.definition.name, offered: null };
  if (item.kind === 'agent') {
    const offer = agents?.find(agent => agent.agentId === item.agentId);
    return offer ? { title: offer.title, ...(offer.description ? { description: offer.description } : {}),
      ...(offer.icon ? { icon: offer.icon } : {}), offered: true }
      : { title: item.agentId, offered: agents === null ? null : false };
  }
  const ref = item.selection.ref;
  if (!offers) return { title: ref.recipeId, offered: null };
  const exact = offers.find((offer) => isSameActionInputOptionValue(offer.value, ref));
  if (exact) return { title: exact.label, ...(exact.description ? { description: exact.description } : {}), ...(exact.icon ? { icon: exact.icon } : {}), offered: true };
  const retired = offers.find((offer) => sameRecipe(offer.value, ref));
  return { title: retired?.label ?? ref.recipeId, ...(retired?.icon ? { icon: retired.icon } : {}), offered: false };
}

const itemIdentity = (item: MachinePresetItemV1) => item.kind === 'app'
  ? readMachineSetupAppIdentityV1(item) : item.kind === 'agent' ? `agent:${item.agentId}` : readMachineSetupRecipeIdentityV1(item.selection.ref);

/** Recipes, Agents and App pins retain one identity in the preset's single item list. */
export function containsMachineSetupItem(setup: MachineSetupV1 | undefined, item: MachinePresetItemV1): boolean {
  const identity = itemIdentity(item);
  return identity !== undefined && (setup?.items ?? []).some(entry => itemIdentity(entry) === identity);
}

/** Every authoring door appends through the existing setup merge; saving the draft executes nothing. */
export function addMachineSetupItem(
  setup: MachineSetupV1 | undefined,
  item: MachinePresetItemV1,
): Readonly<{ ok: true; setup: MachineSetupV1 }> | Readonly<{ ok: false; reason: 'contains' | 'conflict' }> {
  if (containsMachineSetupItem(setup, item)) return { ok: false, reason: 'contains' };
  const merged = mergeMachineSetupsV1([setup ?? {}, { items: [item] }]);
  return merged.ok ? { ok: true, setup: { ...setup, items: merged.setup.items } } : { ok: false, reason: 'conflict' };
}

export function addMachineSetupSoftware(setup: MachineSetupV1 | undefined, ref: MachineRecipeReferenceV1) {
  return addMachineSetupItem(setup, { kind: 'softwareRecipe', selection: { ref, inputs: {} } });
}
