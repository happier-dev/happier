import { z } from 'zod';

import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';

/**
 * The resource a subscription observes: a **resource contribution** reference,
 * spelled exactly as `readResource` spells it — a bare local id bound to the
 * calling plugin, or a qualified `{ pluginId, localId }`.
 *
 * It deliberately does NOT reuse `PluginSessionResourceTargetV1`, which is the
 * declarative UI target selector of a different bounded context (§3.6.1). Using
 * that vocabulary here made the invalidation signal and its snapshot authority
 * name their subject two different ways for the same host method.
 */
export const PluginUiResourceSubscriptionTargetV1Schema = z.union([
  z.string().trim().min(1),
  z.object({
    pluginId: z.string().trim().min(1),
    localId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginUiResourceSubscriptionTargetV1 =
  z.infer<typeof PluginUiResourceSubscriptionTargetV1Schema>;

export const PluginUiResourceSubscriptionRequestV1Schema = z.object({
  subscriptionId: z.string().trim().min(1),
  resource: PluginUiResourceSubscriptionTargetV1Schema,
}).strict();
export type PluginUiResourceSubscriptionRequestV1 =
  z.infer<typeof PluginUiResourceSubscriptionRequestV1Schema>;

/**
 * The one disposal payload for every acknowledged host resource. A resource
 * may be a context subscription, Resource watch, Composer observation, or
 * Composer input-lock lease; its id is host-issued only.
 */
export const PluginUiDisposeHostResourceRequestV1Schema = z.object({
  subscriptionId: z.string().trim().min(1),
}).strict();
export type PluginUiDisposeHostResourceRequestV1 =
  z.infer<typeof PluginUiDisposeHostResourceRequestV1Schema>;

/**
 * The canonical plugin UI subscription event (§3.6).
 *
 * It is a **bounded invalidation signal, not a payload channel**: `readResource`
 * remains the single snapshot authority, so an observer re-reads through it
 * after an `invalidated` event rather than receiving resource bytes here. The
 * predecessor `snapshot` arm carried a full `PluginUiResourceSnapshotV1` — a
 * second data path bound to the declarative session-resource-target vocabulary —
 * and is retired with its `resourceSnapshots.ts` owner; it had no producer.
 *
 * `complete` and `error` are the acknowledged-async retirement and rejection
 * arms and are unchanged.
 */
export const PluginUiResourceSubscriptionEventV1Schema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('invalidated'),
    digest: PluginUiArtifactDigestV1Schema,
  }).strict(),
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('complete'),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
  z.object({
    version: z.literal(1),
    subscriptionId: z.string().trim().min(1),
    kind: z.literal('error'),
    code: z.enum(['unavailable', 'denied', 'stale_surface', 'expired_resource']),
    diagnostics: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
]);
export type PluginUiResourceSubscriptionEventV1 =
  z.infer<typeof PluginUiResourceSubscriptionEventV1Schema>;
