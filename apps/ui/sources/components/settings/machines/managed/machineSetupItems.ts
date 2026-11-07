import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

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
