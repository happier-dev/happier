import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

/** Outside todo.* so released item/order readers never mistake the catalog for a task. */
export const TODO_LABEL_CATALOG_KEY_V1 = 'task-label-colours.v1';
/** Existing Plugin UI theme colour keys; values stay theme-relative across devices. */
export const TODO_LABEL_COLOR_TOKENS_V1 = ['secondaryText', 'accent', 'info', 'success', 'warning', 'danger'] as const;
export const TodoLabelColorTokenV1Schema = lazyZodSchema(() => z.enum(TODO_LABEL_COLOR_TOKENS_V1));
export const TodoLabelColorV1Schema = lazyZodSchema(() => z.strictObject({
  name: z.string(), colorToken: TodoLabelColorTokenV1Schema,
}));
export const TodoLabelCatalogV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), colors: z.record(z.string(), TodoLabelColorTokenV1Schema),
}));
export const TodoLabelCatalogV1StoredSchema = createStoredReadSchema(TodoLabelCatalogV1Schema);
export type TodoLabelCatalogV1 = z.infer<typeof TodoLabelCatalogV1Schema>;

export function projectTodoLabelColorsV1(labels: readonly string[], catalog: TodoLabelCatalogV1): z.infer<typeof TodoLabelColorV1Schema>[] {
  return labels.map(name => ({ name, colorToken: Object.hasOwn(catalog.colors, name) ? catalog.colors[name]! : 'secondaryText' as const }));
}
