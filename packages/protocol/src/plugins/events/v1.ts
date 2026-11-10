import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const HAPPIER_HOST_EVENT_PREFIX_V1 = '@happier/' as const;

export const PluginEventLocalIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/, 'Plugin event ids must use lower-case slash grammar segments'), z.refine((value) => !value.startsWith(HAPPIER_HOST_EVENT_PREFIX_V1), {
    message: 'Plugin event ids cannot use the reserved @happier namespace',
  })));
export type PluginEventLocalIdV1 = z.infer<typeof PluginEventLocalIdV1Schema>;

export const HostEventNamespaceV1Schema = lazyZodSchema(() => z.enum(['runtime', 'lifecycle', 'session', 'automation']));
export type HostEventNamespaceV1 = z.infer<typeof HostEventNamespaceV1Schema>;

export const EventSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('host'),
    namespace: HostEventNamespaceV1Schema,
  }),
  z.strictObject({
    kind: z.literal('plugin'),
    pluginId: z.string().check(z.trim(), z.minLength(1)),
  }),
]));
export type EventSourceV1 = z.infer<typeof EventSourceV1Schema>;

export const TypedEventEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  emittedAt: z.string().check(z.iso.datetime({ offset: true })),
  source: EventSourceV1Schema,
  sequence: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type TypedEventEnvelopeV1 = z.infer<typeof TypedEventEnvelopeV1Schema>;

export const TypedEventV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  payload: z.unknown(),
  envelope: TypedEventEnvelopeV1Schema,
}));
export type TypedEventV1<TPayload = unknown> = Readonly<{
  id: string;
  payload: TPayload;
  envelope: TypedEventEnvelopeV1;
}>;

export const EventSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  pathPrefix: z.optional(z.string().check(z.trim(), z.minLength(1))),
  ids: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
}).check(z.refine((value) => (
  value.pluginId !== undefined
  || value.pathPrefix !== undefined
  || (value.ids !== undefined && value.ids.length > 0)
), {
  message: 'Event selectors must include pluginId, pathPrefix, or ids',
})));
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
