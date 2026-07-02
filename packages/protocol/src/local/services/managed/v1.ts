import { z } from 'zod';

import { LocalServiceLoopbackHostV1Schema } from '../hosts.js';
import { LocalServiceInventoryConfidenceV1Schema } from '../inventory/v1.js';

export const HAPPIER_LOCAL_SERVICE_ENV = Object.freeze({
  PORT: 'PORT',
  HOST: 'HOST',
  PRIVATE_URL: 'HAPPIER_URL',
  PREVIEW_URL: 'HAPPIER_PREVIEW_URL',
});

export const LocalServiceManagedOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('session'),
    sessionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('workspace'),
    workspaceId: z.string().trim().min(1),
  }).strict(),
]);
export type LocalServiceManagedOwnerV1 = z.infer<typeof LocalServiceManagedOwnerV1Schema>;

export const LocalServiceLaunchSpecV1Schema = z.object({
  kind: z.string().trim().min(1),
}).passthrough();
export type LocalServiceLaunchSpecV1 = z.infer<typeof LocalServiceLaunchSpecV1Schema>;

export const LocalServiceManagedPortPolicyV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fixed'),
    port: z.number().int().min(1).max(65_535),
    onCollision: z.enum(['fail', 'fallback']).default('fail'),
  }).strict(),
  z.object({
    kind: z.literal('allocated'),
    preferredPort: z.number().int().min(1).max(65_535).optional(),
    onCollision: z.enum(['fail', 'fallback']).default('fallback'),
  }).strict(),
  z.object({
    kind: z.literal('inherited'),
    envName: z.string().trim().min(1),
  }).strict(),
]);
export type LocalServiceManagedPortPolicyV1 = z.infer<typeof LocalServiceManagedPortPolicyV1Schema>;

export const LocalServiceManagedEnvironmentVariableV1Schema = z.enum([
  'PORT',
  'HOST',
  'HAPPIER_URL',
  'HAPPIER_PREVIEW_URL',
]);
export type LocalServiceManagedEnvironmentVariableV1 = z.infer<typeof LocalServiceManagedEnvironmentVariableV1Schema>;

export const LocalServiceManagedLaunchModeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('detectAfterLaunch'),
    minimumConfidence: LocalServiceInventoryConfidenceV1Schema.default('medium'),
  }).strict(),
  z.object({
    kind: z.literal('assignAndInject'),
    portPolicy: LocalServiceManagedPortPolicyV1Schema,
    environment: z.object({
      inject: z.array(LocalServiceManagedEnvironmentVariableV1Schema).default(['PORT', 'HOST']),
    }).strict().default({ inject: ['PORT', 'HOST'] }),
  }).strict(),
  z.object({
    kind: z.literal('externalRegistered'),
    inventoryId: z.string().trim().min(1),
    minimumConfidence: LocalServiceInventoryConfidenceV1Schema.default('high'),
  }).strict(),
]);
export type LocalServiceManagedLaunchModeV1 = z.infer<typeof LocalServiceManagedLaunchModeV1Schema>;

export const LocalServiceManagedHostPolicyV1Schema = z.object({
  kind: z.literal('loopback'),
  host: LocalServiceLoopbackHostV1Schema.optional().default('127.0.0.1'),
}).strict();
export type LocalServiceManagedHostPolicyV1 = z.infer<typeof LocalServiceManagedHostPolicyV1Schema>;

export const LocalServiceManagedNamePolicyV1Schema = z.discriminatedUnion('strategy', [
  z.object({
    strategy: z.literal('derived'),
    base: z.string().trim().min(1),
  }).strict(),
  z.object({
    strategy: z.literal('fixed'),
    name: z.string().trim().min(1),
  }).strict(),
]);
export type LocalServiceManagedNamePolicyV1 = z.infer<typeof LocalServiceManagedNamePolicyV1Schema>;

export const LocalServiceManagedHealthCheckV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('http'),
    path: z.string().trim().min(1).default('/'),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal('command'),
    launch: LocalServiceLaunchSpecV1Schema,
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
]);
export type LocalServiceManagedHealthCheckV1 = z.infer<typeof LocalServiceManagedHealthCheckV1Schema>;

export const LocalServiceManagedRestartPolicyV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }).strict(),
]);
export type LocalServiceManagedRestartPolicyV1 = z.infer<typeof LocalServiceManagedRestartPolicyV1Schema>;

export const LocalServiceManagedCleanupPolicyV1Schema = z.object({
  staleAfterMs: z.number().int().positive(),
}).strict();
export type LocalServiceManagedCleanupPolicyV1 = z.infer<typeof LocalServiceManagedCleanupPolicyV1Schema>;

export const LocalServiceManagedDeclarationV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  owner: LocalServiceManagedOwnerV1Schema,
  launch: LocalServiceLaunchSpecV1Schema,
  launchMode: LocalServiceManagedLaunchModeV1Schema,
  hostPolicy: LocalServiceManagedHostPolicyV1Schema,
  name: LocalServiceManagedNamePolicyV1Schema,
  healthCheck: LocalServiceManagedHealthCheckV1Schema,
  restart: LocalServiceManagedRestartPolicyV1Schema,
  cleanup: LocalServiceManagedCleanupPolicyV1Schema,
}).strict();
export type LocalServiceManagedDeclarationV1 = z.infer<typeof LocalServiceManagedDeclarationV1Schema>;

export const LocalServiceManagedDiagnosticV1Schema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1).optional(),
  severity: z.enum(['info', 'warning', 'error']).optional().default('info'),
}).strict();
export type LocalServiceManagedDiagnosticV1 = z.infer<typeof LocalServiceManagedDiagnosticV1Schema>;

export const LocalServiceManagedRuntimeStateV1Schema = z.object({
  v: z.literal(1),
  id: z.string().trim().min(1),
  owner: LocalServiceManagedOwnerV1Schema,
  phase: z.enum(['starting', 'detecting', 'running', 'unhealthy', 'stopping', 'stopped', 'failed']),
  launchMode: z.enum(['detectAfterLaunch', 'assignAndInject', 'externalRegistered']),
  process: z.object({
    pid: z.number().int().positive(),
    startedAt: z.number().int().nonnegative(),
  }).strict().optional(),
  inventoryId: z.string().trim().min(1).optional(),
  routeName: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  url: z.string().url().optional(),
  diagnostics: z.array(LocalServiceManagedDiagnosticV1Schema).default([]),
}).strict();
export type LocalServiceManagedRuntimeStateV1 = z.infer<typeof LocalServiceManagedRuntimeStateV1Schema>;
