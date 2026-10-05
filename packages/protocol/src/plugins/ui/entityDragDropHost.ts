import { z } from 'zod';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { EntityDragItemV1Schema, EntityDropOutcomeV1Schema, EntityDropAdmissionV1Schema } from './entityDragDrop.js';

const Id = z.string().trim().min(1);
const Finite = z.number().finite();
const Pointer = z.object({ x: Finite, y: Finite }).strict();
const Bounds = Pointer.extend({ width: Finite.nonnegative(), height: Finite.nonnegative() }).strict();
const Viewport = z.object({ width: Finite.positive(), height: Finite.positive() }).strict();

/** Closed V1 requests; the mounted host supplies authority and window coordinates. */
export const PluginUiReadEntityDragItemRequestV1Schema = z.object({ kind: z.literal('session') }).strict();
export type PluginUiReadEntityDragItemRequestV1 = z.infer<typeof PluginUiReadEntityDragItemRequestV1Schema>;
export const PluginUiReadEntityDragItemResultV1Schema = EntityDragItemV1Schema.nullable();

/** Thin hosted event delivery. This is not an iframe-local drag lifecycle. */
export const PluginUiUpdateEntityDragDropRequestV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mountSource'), mountId: Id, sourceId: Id, reference: PluginUiJsonValueV1Schema }).strict(),
  z.object({ kind: z.literal('mountTarget'), mountId: Id, targetId: Id, input: PluginUiJsonValueV1Schema.optional(), parentId: Id.optional(), bounds: Bounds, viewport: Viewport }).strict(),
  z.object({ kind: z.literal('layout'), mountId: Id, bounds: Bounds, viewport: Viewport }).strict(),
  z.object({ kind: z.literal('unmount'), mountId: Id }).strict(),
  z.object({ kind: z.literal('begin'), mountId: Id, pointer: Pointer, viewport: Viewport, input: z.enum(['pointer', 'keyboard']).optional() }).strict(),
  z.object({ kind: z.literal('destinations'), mountId: Id }).strict(),
  z.object({ kind: z.literal('choose'), mountId: Id, targetId: Id, destination: PluginUiJsonValueV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('commit'), mountId: Id }).strict(),
  z.object({ kind: z.literal('perform'), mountId: Id, targetId: Id, destination: PluginUiJsonValueV1Schema.optional() }).strict(),
  z.object({ kind: z.literal('move'), pointer: Pointer, viewport: Viewport }).strict(),
  z.object({ kind: z.literal('release'), pointer: Pointer, viewport: Viewport }).strict(),
    z.object({ kind: z.literal('cancel'), mountId: Id.optional(), reason: z.literal('gesture-end').optional() }).strict(),
]);
export type PluginUiUpdateEntityDragDropRequestV1 = z.infer<typeof PluginUiUpdateEntityDragDropRequestV1Schema>;
export const PluginUiEntityDropDestinationV1Schema = z.object({ targetId: Id, destination: PluginUiJsonValueV1Schema.optional(), label: Id.optional(), group: Id.optional(), admission: EntityDropAdmissionV1Schema }).strict();
export type PluginUiEntityDropDestinationV1 = z.infer<typeof PluginUiEntityDropDestinationV1Schema>;
export const PluginUiUpdateEntityDragDropResultV1Schema = z.object({
  accepted: z.boolean(),
  outcome: EntityDropOutcomeV1Schema.nullable().optional(),
  destinations: z.array(PluginUiEntityDropDestinationV1Schema).optional(),
  description: z.object({ title: Id, subtitle: Id.optional() }).strict().nullable().optional(),
}).strict();
export type PluginUiUpdateEntityDragDropResultV1 = z.infer<typeof PluginUiUpdateEntityDragDropResultV1Schema>;

/** Exact mounted source feedback only; other realm carries never appear in this projection. */
export const PluginUiWatchEntityDragDropRequestV1Schema = z.object({ mountId: Id }).strict();
export type PluginUiWatchEntityDragDropRequestV1 = z.infer<typeof PluginUiWatchEntityDragDropRequestV1Schema>;
export const PluginUiEntityDragDropStateV1Schema = z.object({
  current: z.boolean(), phase: z.enum(['idle', 'carrying', 'pending', 'settled']),
  admission: EntityDropAdmissionV1Schema.nullable(), outcome: EntityDropOutcomeV1Schema.nullable(),
  destinations: z.array(PluginUiEntityDropDestinationV1Schema),
}).strict();
export type PluginUiEntityDragDropStateV1 = z.infer<typeof PluginUiEntityDragDropStateV1Schema>;
