import { z } from '../../zodRuntimePolicy.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { EntityDragItemV1Schema, EntityDropOutcomeV1Schema, EntityDropAdmissionV1Schema } from './entityDragDrop.js';

const Id = z.string().check(z.trim(), z.minLength(1));
const Finite = z.number();
const Pointer = z.strictObject({ x: Finite, y: Finite });
const Bounds = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(Pointer, { width: Finite.check(z.nonnegative()), height: Finite.check(z.nonnegative()) }));
const Viewport = z.strictObject({ width: Finite.check(z.positive()), height: Finite.check(z.positive()) });

/** Closed V1 requests; the mounted host supplies authority and window coordinates. */
export const PluginUiReadEntityDragItemRequestV1Schema = z.strictObject({ kind: z.literal('session') });
export type PluginUiReadEntityDragItemRequestV1 = z.infer<typeof PluginUiReadEntityDragItemRequestV1Schema>;
export const PluginUiReadEntityDragItemResultV1Schema = z.nullable(EntityDragItemV1Schema);

/** Thin hosted event delivery. This is not an iframe-local drag lifecycle. */
export const PluginUiUpdateEntityDragDropRequestV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('mountSource'), mountId: Id, sourceId: Id, reference: PluginUiJsonValueV1Schema }),
  z.strictObject({ kind: z.literal('mountTarget'), mountId: Id, targetId: Id, input: z.optional(PluginUiJsonValueV1Schema), parentId: z.optional(Id), bounds: Bounds, viewport: Viewport }),
  z.strictObject({ kind: z.literal('layout'), mountId: Id, bounds: Bounds, viewport: Viewport }),
  z.strictObject({ kind: z.literal('unmount'), mountId: Id }),
  z.strictObject({ kind: z.literal('begin'), mountId: Id, pointer: Pointer, viewport: Viewport, input: z.optional(z.enum(['pointer', 'keyboard'])) }),
  z.strictObject({ kind: z.literal('destinations'), mountId: Id }),
  z.strictObject({ kind: z.literal('choose'), mountId: Id, targetId: Id, destination: z.optional(PluginUiJsonValueV1Schema) }),
  z.strictObject({ kind: z.literal('commit'), mountId: Id }),
  z.strictObject({ kind: z.literal('perform'), mountId: Id, targetId: Id, destination: z.optional(PluginUiJsonValueV1Schema) }),
  z.strictObject({ kind: z.literal('move'), pointer: Pointer, viewport: Viewport }),
  z.strictObject({ kind: z.literal('release'), pointer: Pointer, viewport: Viewport }),
    z.strictObject({ kind: z.literal('cancel'), mountId: z.optional(Id), reason: z.optional(z.literal('gesture-end')) }),
]);
export type PluginUiUpdateEntityDragDropRequestV1 = z.infer<typeof PluginUiUpdateEntityDragDropRequestV1Schema>;
export const PluginUiEntityDropDestinationV1Schema = z.strictObject({ targetId: Id, destination: z.optional(PluginUiJsonValueV1Schema), label: z.optional(Id), group: z.optional(Id), admission: EntityDropAdmissionV1Schema });
export type PluginUiEntityDropDestinationV1 = z.infer<typeof PluginUiEntityDropDestinationV1Schema>;
export const PluginUiUpdateEntityDragDropResultV1Schema = z.strictObject({
  accepted: z.boolean(),
  outcome: z.optional(z.nullable(EntityDropOutcomeV1Schema)),
  destinations: z.optional(z.array(PluginUiEntityDropDestinationV1Schema)),
  description: z.optional(z.nullable(z.strictObject({ title: Id, subtitle: z.optional(Id) }))),
});
export type PluginUiUpdateEntityDragDropResultV1 = z.infer<typeof PluginUiUpdateEntityDragDropResultV1Schema>;

/** Exact mounted source feedback only; other realm carries never appear in this projection. */
export const PluginUiWatchEntityDragDropRequestV1Schema = z.strictObject({ mountId: Id });
export type PluginUiWatchEntityDragDropRequestV1 = z.infer<typeof PluginUiWatchEntityDragDropRequestV1Schema>;
export const PluginUiEntityDragDropStateV1Schema = z.strictObject({
  current: z.boolean(), phase: z.enum(['idle', 'carrying', 'pending', 'settled']),
  admission: z.nullable(EntityDropAdmissionV1Schema), outcome: z.nullable(EntityDropOutcomeV1Schema),
  destinations: z.array(PluginUiEntityDropDestinationV1Schema),
});
export type PluginUiEntityDragDropStateV1 = z.infer<typeof PluginUiEntityDragDropStateV1Schema>;
