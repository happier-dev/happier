import { z } from 'zod';

export const HAPPIER_HOST_EVENT_PREFIX_V1 = '@happier/' as const;

export const PluginEventLocalIdV1Schema = z.string()
  .trim()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/,
    'Plugin event ids must use lower-case slash grammar segments',
  )
  .refine((value) => !value.startsWith(HAPPIER_HOST_EVENT_PREFIX_V1), {
    message: 'Plugin event ids cannot use the reserved @happier namespace',
  });
export type PluginEventLocalIdV1 = z.infer<typeof PluginEventLocalIdV1Schema>;

export const HostEventNamespaceV1Schema = z.enum(['runtime', 'lifecycle', 'session', 'automation']);
export type HostEventNamespaceV1 = z.infer<typeof HostEventNamespaceV1Schema>;

export const EventSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    namespace: HostEventNamespaceV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().trim().min(1),
  }).strict(),
]);
export type EventSourceV1 = z.infer<typeof EventSourceV1Schema>;

export const TypedEventEnvelopeV1Schema = z.object({
  emittedAt: z.string().datetime({ offset: true }),
  source: EventSourceV1Schema,
  sequence: z.number().int().nonnegative().optional(),
}).strict();
export type TypedEventEnvelopeV1 = z.infer<typeof TypedEventEnvelopeV1Schema>;

export const TypedEventV1Schema = z.object({
  id: z.string().trim().min(1),
  payload: z.unknown(),
  envelope: TypedEventEnvelopeV1Schema,
}).strict();
export type TypedEventV1<TPayload = unknown> = Readonly<{
  id: string;
  payload: TPayload;
  envelope: TypedEventEnvelopeV1;
}>;

export const EventSelectorV1Schema = z.object({
  pluginId: z.string().trim().min(1).optional(),
  pathPrefix: z.string().trim().min(1).optional(),
  ids: z.array(z.string().trim().min(1)).optional(),
}).strict().refine((value) => (
  value.pluginId !== undefined
  || value.pathPrefix !== undefined
  || (value.ids !== undefined && value.ids.length > 0)
), {
  message: 'Event selectors must include pluginId, pathPrefix, or ids',
});
export type EventSelectorV1 = z.infer<typeof EventSelectorV1Schema>;

export function isPluginEventLocalIdV1(value: string): boolean {
  return PluginEventLocalIdV1Schema.safeParse(value).success;
}

export function qualifyPluginEventIdV1(pluginId: string, localId: string): string {
  return `${pluginId}/${PluginEventLocalIdV1Schema.parse(localId)}`;
}

export function readHostEventNamespaceV1(eventId: string): HostEventNamespaceV1 | null {
  if (!eventId.startsWith(HAPPIER_HOST_EVENT_PREFIX_V1)) {
    return null;
  }
  const suffix = eventId.slice(HAPPIER_HOST_EVENT_PREFIX_V1.length);
  const separatorIndex = suffix.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === suffix.length - 1) {
    return null;
  }
  const namespace = suffix.slice(0, separatorIndex);
  const eventPath = suffix.slice(separatorIndex + 1);
  if (!PluginEventLocalIdV1Schema.safeParse(eventPath).success) {
    return null;
  }
  return HostEventNamespaceV1Schema.safeParse(namespace).success
    ? namespace as HostEventNamespaceV1
    : null;
}
