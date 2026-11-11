import { isSameActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { mergeMachineSetupsV1, readMachineSetupRecipeIdentityV1, type MachinePresetItemV1, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { InputOptionValue } from '@happier-dev/protocol/inputs/inputFields';

type Items = readonly MachinePresetItemV1[];
export type MachineSetupItemKind = MachinePresetItemV1['kind'];

/** Apply order the editor presents: setup and software first, then apps. */
const GROUP_ORDER: readonly MachineSetupItemKind[] = [
  'setupRecipe',
  'softwareRecipe',
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
): Readonly<{ title: string; description?: string; icon?: string; offered: boolean | null }> {
  if (item.kind === 'app') return { title: item.definition.name, offered: null };
  const ref = item.selection.ref;
  if (!offers) return { title: ref.recipeId, offered: null };
  const exact = offers.find((offer) => isSameActionInputOptionValue(offer.value, ref));
  if (exact) return { title: exact.label, ...(exact.description ? { description: exact.description } : {}), ...(exact.icon ? { icon: exact.icon } : {}), offered: true };
  const retired = offers.find((offer) => sameRecipe(offer.value, ref));
  return { title: retired?.label ?? ref.recipeId, ...(retired?.icon ? { icon: retired.icon } : {}), offered: false };
}

/** Add an offered recipe as a Software item through the one setup merge; a recipe already held (any revision) is refused. */
export function addMachineSetupSoftware(
  setup: MachineSetupV1 | undefined,
  ref: MachineRecipeReferenceV1,
): Readonly<{ ok: true; setup: MachineSetupV1 }> | Readonly<{ ok: false; reason: 'contains' | 'conflict' }> {
  if ((setup?.items ?? []).some((item) => item.kind !== 'app' && sameRecipe(item.selection.ref, ref)))
    return { ok: false, reason: 'contains' };
  const merged = mergeMachineSetupsV1([setup ?? {}, { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] }]);
  return merged.ok ? { ok: true, setup: { ...setup, items: merged.setup.items } } : { ok: false, reason: 'conflict' };
}
