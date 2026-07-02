import { z } from 'zod';

import { PluginPermissionCapabilityV1Schema } from './v1.js';

export const PluginPermissionGrantPluginIdV1Schema = z.string().trim().min(1);
export type PluginPermissionGrantPluginIdV1 = z.infer<typeof PluginPermissionGrantPluginIdV1Schema>;

export const PluginPermissionGrantTargetScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
  }).strict(),
  z.object({
    kind: z.literal('project'),
    projectId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('workspace'),
    workspaceId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginPermissionGrantTargetScopeV1 = z.infer<typeof PluginPermissionGrantTargetScopeV1Schema>;

export const PluginPermissionGrantStatusV1Schema = z.enum(['active', 'revoked']);
export type PluginPermissionGrantStatusV1 = z.infer<typeof PluginPermissionGrantStatusV1Schema>;

export const PluginPermissionGrantRequestStatusV1Schema = z.enum(['pending', 'granted', 'dismissed']);
export type PluginPermissionGrantRequestStatusV1 = z.infer<typeof PluginPermissionGrantRequestStatusV1Schema>;

export const PluginPermissionGrantActorV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('plugin'),
    pluginId: PluginPermissionGrantPluginIdV1Schema,
    sessionId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('host'),
    label: z.string().trim().min(1).optional(),
  }).strict(),
]);
export type PluginPermissionGrantActorV1 = z.infer<typeof PluginPermissionGrantActorV1Schema>;

export const PluginPermissionGrantAuthoritySourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bundled'),
  }).strict(),
  z.object({
    kind: z.literal('machine_installation'),
    machineId: z.string().trim().min(1),
    installationId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginPermissionGrantAuthoritySourceV1 = z.infer<typeof PluginPermissionGrantAuthoritySourceV1Schema>;

const PluginPermissionGrantAuthoritySourceWithDefaultV1Schema =
  PluginPermissionGrantAuthoritySourceV1Schema.default({ kind: 'bundled' });

export const PluginPermissionGrantV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  status: PluginPermissionGrantStatusV1Schema,
  requestId: z.string().trim().min(1).optional(),
  grantedByUserId: z.string().trim().min(1),
  grantedAt: z.number().int().nonnegative(),
  revokedByUserId: z.string().trim().min(1).optional(),
  revokedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantV1 = z.infer<typeof PluginPermissionGrantV1Schema>;

export const PluginPermissionGrantRequestV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  requester: PluginPermissionGrantActorV1Schema,
  reason: z.string().trim().min(1),
  status: PluginPermissionGrantRequestStatusV1Schema,
  grantId: z.string().trim().min(1).optional(),
  createdByUserId: z.string().trim().min(1).optional(),
  decidedByUserId: z.string().trim().min(1).optional(),
  decidedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantRequestV1 = z.infer<typeof PluginPermissionGrantRequestV1Schema>;

export const PluginPermissionGrantAuditEventKindV1Schema = z.enum([
  'requested',
  'granted',
  'revoked',
  'dismissed',
]);
export type PluginPermissionGrantAuditEventKindV1 = z.infer<typeof PluginPermissionGrantAuditEventKindV1Schema>;

export const PluginPermissionGrantAuditEventV1Schema = z.object({
  v: z.literal(1),
  eventId: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  authoritySource: PluginPermissionGrantAuthoritySourceWithDefaultV1Schema,
  eventKind: PluginPermissionGrantAuditEventKindV1Schema,
  actor: PluginPermissionGrantActorV1Schema,
  requestId: z.string().trim().min(1).optional(),
  grantId: z.string().trim().min(1).optional(),
  previousState: z.unknown().optional(),
  nextState: z.unknown().optional(),
  reason: z.string().trim().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type PluginPermissionGrantAuditEventV1 = z.infer<typeof PluginPermissionGrantAuditEventV1Schema>;

export const PluginPermissionGrantListActionInputV1Schema = z.object({
  pluginId: PluginPermissionGrantPluginIdV1Schema.optional(),
  capability: PluginPermissionCapabilityV1Schema.optional(),
  targetScope: PluginPermissionGrantTargetScopeV1Schema.optional(),
  includeRevoked: z.boolean().default(false),
  includeResolvedRequests: z.boolean().default(false),
  limit: z.number().int().positive().max(200).default(50),
}).strict();
export type PluginPermissionGrantListActionInputV1 = z.infer<typeof PluginPermissionGrantListActionInputV1Schema>;

export const PluginPermissionGrantRequestActionInputV1Schema = z.object({
  pluginId: PluginPermissionGrantPluginIdV1Schema,
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: PluginPermissionGrantTargetScopeV1Schema,
  requester: PluginPermissionGrantActorV1Schema,
  reason: z.string().trim().min(1),
}).strict();
export type PluginPermissionGrantRequestActionInputV1 = z.infer<typeof PluginPermissionGrantRequestActionInputV1Schema>;

export const PluginPermissionGrantGrantActionInputV1Schema = z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type PluginPermissionGrantGrantActionInputV1 = z.infer<typeof PluginPermissionGrantGrantActionInputV1Schema>;

export const PluginPermissionGrantRevokeActionInputV1Schema = z.object({
  grantId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type PluginPermissionGrantRevokeActionInputV1 = z.infer<typeof PluginPermissionGrantRevokeActionInputV1Schema>;

export const PluginPermissionGrantDismissRequestActionInputV1Schema = z.object({
  requestId: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
}).strict();
export type PluginPermissionGrantDismissRequestActionInputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionInputV1Schema>;

export const PluginPermissionGrantListActionOutputV1Schema = z.object({
  grants: z.array(PluginPermissionGrantV1Schema),
  pendingRequests: z.array(PluginPermissionGrantRequestV1Schema),
}).strict();
export type PluginPermissionGrantListActionOutputV1 = z.infer<typeof PluginPermissionGrantListActionOutputV1Schema>;

export const PluginPermissionGrantRequestActionOutputV1Schema = z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantRequestActionOutputV1Schema>;

export const PluginPermissionGrantGrantActionOutputV1Schema = z.object({
  grant: PluginPermissionGrantV1Schema,
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantGrantActionOutputV1 = z.infer<typeof PluginPermissionGrantGrantActionOutputV1Schema>;

export const PluginPermissionGrantRevokeActionOutputV1Schema = z.object({
  grant: PluginPermissionGrantV1Schema,
}).strict();
export type PluginPermissionGrantRevokeActionOutputV1 = z.infer<typeof PluginPermissionGrantRevokeActionOutputV1Schema>;

export const PluginPermissionGrantDismissRequestActionOutputV1Schema = z.object({
  pendingRequest: PluginPermissionGrantRequestV1Schema,
}).strict();
export type PluginPermissionGrantDismissRequestActionOutputV1 = z.infer<typeof PluginPermissionGrantDismissRequestActionOutputV1Schema>;
