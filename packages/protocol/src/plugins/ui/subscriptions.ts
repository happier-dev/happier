import { PluginUiLaunchInputV1Schema } from './semanticCommands.js';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginUiResourceContentV1Schema } from './resourceContent.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import { ActionOperationSnapshotV1Schema } from '../../actions/operations/v1.js';
import { projectZodProtocolSchema } from '../actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { PluginUiMachineServiceReadReferenceV1Schema } from '../../daemon/machineServiceLogsResource.js';
import { ManagedListInputV1Schema } from '../../machines/managed/actionsV1.js';
import { DeploymentEnvironmentListInputV1Schema } from '../../deployments/deploymentActionsV1.js';
import type { ActionId } from '../../actions/actionIds.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../../actions/actionIds.js';
export { PluginUiMachineServiceLogsReadReferenceV1Schema } from '../../daemon/machineServiceLogsResource.js';

/** Closed, invocation-qualified authority observation; it never returns credential material. */
export const PluginUiReadAuthorityReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  readAuthority: z.strictObject({
    consumer: QualifiedConnectedAccountPurposeV1Schema.shape.consumer,
    purpose: QualifiedConnectedAccountPurposeV1Schema.shape.purpose,
    input: PluginUiJsonValueV1Schema,
  }),
}));
export type PluginUiReadAuthorityReferenceV1 = z.infer<typeof PluginUiReadAuthorityReferenceV1Schema>;

export const PluginUiHostReadReferenceV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  hostRead: z.enum(['usage.query', 'connectedServices.quota.get', 'connectedServices.pools.selection.get', 'discussion.get', 'action.operations.get']),
  input: PluginUiJsonValueV1Schema,
}), z.strictObject({
  hostRead: z.literal('deployments.environments.list'),
  input: DeploymentEnvironmentListInputV1Schema,
}), z.strictObject({
  hostRead: z.literal('machines.managed.list'),
  // This observation borrows the canonical active inventory, not a second query/selector owner.
  input: z.strictObject({ homeId: ManagedListInputV1Schema.shape.homeId }),
}), PluginUiMachineServiceReadReferenceV1Schema]));
export type PluginUiHostReadReferenceV1 = z.infer<typeof PluginUiHostReadReferenceV1Schema>;

/** Host Resource aliases borrow the original Action's admission in every host. */
export function resolvePluginUiHostReadActionIdV1(hostRead: PluginUiHostReadReferenceV1['hostRead']): ActionId {
  switch (hostRead) {
    case 'database.connection': return ACTION_INVOKE_ACTION_ID_V1;
    case 'machines.services.logs': return 'machines.services.logs.read';
    case 'deployments.logs': return 'deployments.logs.read';
    case 'deployments.health.edge': return 'deployments.health.current';
    default: return hostRead;
  }
}

/** Existing qualified operation and transport evidence, without reclassifying acceptance or settlement. */
export const PluginUiActionOperationHostReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  operation: z.nullable(ActionOperationSnapshotV1Schema),
  observation: z.enum(['available', 'reconnecting', 'unavailable']),
}));
export type PluginUiActionOperationHostReadResultV1 = z.infer<typeof PluginUiActionOperationHostReadResultV1Schema>;
export const PluginUiActionOperationHostReadResultV1ProtocolSchema = lazyDefinition(() =>
  projectZodProtocolSchema(PluginUiActionOperationHostReadResultV1Schema));

/**
 * The subject a subscription observes: a **resource contribution** reference,
 * spelled exactly as `readResource` spells it — a bare local id bound to the
 * calling plugin, a qualified `{ pluginId, localId }`, or a closed host-read
 * reference admitted by the canonical Action executor. An authority-only target
 * instead observes its exact admitted read consumer/purpose and has no snapshot.
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
  input: z.optional(PluginUiLaunchInputV1Schema),
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
 * Resource watches normally invalidate rereadable content. A producer whose
 * finite pages cannot be reread delivers those bytes on its existing watch.
 * Subscription identity and disposal remain with the same watch lifetime.
 * Authority-only watches carry terminal withdrawal, never credential content.
 */
export const PluginUiResourceSubscriptionEventV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    version: z.literal(1),
    subscriptionId: z.string().check(z.trim(), z.minLength(1)),
    kind: z.literal('pages'),
    pages: z.array(PluginUiResourceContentV1Schema),
  }),
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
