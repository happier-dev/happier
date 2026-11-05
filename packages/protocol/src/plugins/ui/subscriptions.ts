import { PluginUiMachineServiceReadReferenceV1Schema } from '../../daemon/machineServiceLogsResource.js';
import type { ActionId } from '../../actions/actionIds.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';

/** Closed, invocation-qualified authority observation; it never returns credential material. */
export const PluginUiReadAuthorityReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  readAuthority: z.strictObject({
    consumer: QualifiedConnectedAccountPurposeV1Schema.shape.consumer,
    purpose: QualifiedConnectedAccountPurposeV1Schema.shape.purpose,
    input: PluginUiJsonValueV1Schema,
  }),
}));
export type PluginUiReadAuthorityReferenceV1 = z.infer<typeof PluginUiReadAuthorityReferenceV1Schema>;

/** Closed host-read identity. Action admission still owns caller policy and input validation. */
export const PluginUiHostReadReferenceV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  hostRead: z.enum(['usage.query', 'connectedServices.quota.get', 'connectedServices.pools.selection.get']),
  input: PluginUiJsonValueV1Schema,
}), PluginUiMachineServiceReadReferenceV1Schema]));
export type PluginUiHostReadReferenceV1 = z.infer<typeof PluginUiHostReadReferenceV1Schema>;

/** Host Resource aliases borrow the original Action's admission in every host. */
export function resolvePluginUiHostReadActionIdV1(hostRead: PluginUiHostReadReferenceV1['hostRead']): ActionId {
  switch (hostRead) {
    case 'machines.services.logs': return 'machines.services.logs.read';
    case 'deployments.logs': return 'deployments.logs.read';
    case 'deployments.health.edge': return 'deployments.health.current';
    default: return hostRead;
  }
}


/**
 * The resource a subscription observes: a **resource contribution** reference,
 * spelled exactly as `readResource` spells it — a bare local id bound to the
 * calling plugin, a qualified `{ pluginId, localId }`, or a closed host-read
 * reference admitted by the canonical Action executor.
 *
 * It deliberately does NOT reuse `PluginSessionResourceTargetV1`, which is the
 * declarative UI target selector of a different bounded context (§3.6.1). Using
 * that vocabulary here made the invalidation signal and its snapshot authority
 * name their subject two different ways for the same host method.
 */
export const PluginUiResourceSubscriptionTargetV1Schema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.strictObject({
    pluginId: z.string().check(z.trim(), z.minLength(1)),
    localId: z.string().check(z.trim(), z.minLength(1)),
  }),
  PluginUiHostReadReferenceV1Schema,
  PluginUiReadAuthorityReferenceV1Schema,
]));
export type PluginUiResourceSubscriptionTargetV1 =
  z.infer<typeof PluginUiResourceSubscriptionTargetV1Schema>;

export const PluginUiResourceSubscriptionRequestV1Schema = lazyZodSchema(() => z.strictObject({
  subscriptionId: z.string().check(z.trim(), z.minLength(1)),
  resource: PluginUiResourceSubscriptionTargetV1Schema,
}));
export type PluginUiResourceSubscriptionRequestV1 =
  z.infer<typeof PluginUiResourceSubscriptionRequestV1Schema>;

/**
 * The one disposal payload for every acknowledged host resource. A resource
 * may be a context subscription, Resource watch, Composer observation, or
 * Composer input-lock lease; its id is host-issued only.
 */
export const PluginUiDisposeHostResourceRequestV1Schema = lazyZodSchema(() => z.strictObject({
  subscriptionId: z.string().check(z.trim(), z.minLength(1)),
}));
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
export const PluginUiResourceSubscriptionEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    subscriptionId: z.string().check(z.trim(), z.minLength(1)),
    kind: z.literal('invalidated'),
    digest: PluginUiArtifactDigestV1Schema,
  }),
  z.strictObject({
    version: z.literal(1),
    subscriptionId: z.string().check(z.trim(), z.minLength(1)),
    kind: z.literal('complete'),
    diagnostics: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
  }),
  z.strictObject({
    version: z.literal(1),
    subscriptionId: z.string().check(z.trim(), z.minLength(1)),
    kind: z.literal('error'),
    code: z.enum(['unavailable', 'denied', 'stale_surface', 'expired_resource']),
    diagnostics: z._default(z.array(z.string().check(z.trim(), z.minLength(1))), []),
  }),
]));
export type PluginUiResourceSubscriptionEventV1 =
  z.infer<typeof PluginUiResourceSubscriptionEventV1Schema>;
