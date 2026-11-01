import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginUpdatePolicyV1Schema } from '../marketplace/pluginUpdatePolicyV1.js';

/** Development lifecycle facts have one wire owner for daemon, Actions and Settings. */
export const PluginDevelopmentPhaseV1Schema = lazyZodSchema(() => z.enum([
  'observing', 'preparing_dependencies', 'compiling', 'validating',
  'active', 'retained_incumbent', 'unavailable',
]));

export const PluginDevelopmentStatusV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  roots: z.readonly(z.array(z.readonly(z.strictObject({
    kind: z.enum(['home', 'workspace', 'explicit']),
    rootPath: z.string().check(z.minLength(1)),
    trusted: z.boolean(),
    persisted: z.boolean(),
  })))),
  plugins: z.readonly(z.array(z.readonly(z.strictObject({
    sourceRootPath: z.string().check(z.minLength(1)),
    pluginId: z.optional(z.string().check(z.minLength(1))),
    phase: PluginDevelopmentPhaseV1Schema,
    occurrenceId: z.optional(z.string().check(z.minLength(1))),
    uiArtifactDigest: z.optional(z.string().check(z.minLength(1))),
    diagnostic: z.optional(z.readonly(z.strictObject({ code: z.string().check(z.minLength(1)), message: z.optional(z.string()) }))),
  })))),
})));
export type PluginDevelopmentStatusV1 = z.infer<typeof PluginDevelopmentStatusV1Schema>;
export type PluginDevelopmentPhaseV1 = z.infer<typeof PluginDevelopmentPhaseV1Schema>;

export const PluginDevelopmentControlResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('status'), status: PluginDevelopmentStatusV1Schema }),
  z.strictObject({ kind: z.literal('trustRequired'), projectRoot: z.string().check(z.minLength(1)), pluginRoot: z.string().check(z.minLength(1)),
    status: PluginDevelopmentStatusV1Schema }),
  z.strictObject({ kind: z.literal('failed'), code: z.string().check(z.minLength(1)), message: z.string(),
    status: PluginDevelopmentStatusV1Schema }),
]));
export type PluginDevelopmentControlResultV1 = z.infer<typeof PluginDevelopmentControlResultV1Schema>;

const DiagnosticSchema = lazyZodSchema(() => z.readonly(z.object({
  code: z.string(), message: z.string(), details: z.optional(z.unknown()),
})));
const DistributionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), registryOrigin: z.string(), registryProfileId: z.optional(z.string()), packageName: z.string() }),
  z.object({ kind: z.literal('localPath'), canonicalPath: z.string() }),
  z.object({ kind: z.literal('archive'), source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('localFile'), canonicalPath: z.string() }),
    z.object({ kind: z.literal('remoteUrl'), canonicalUrl: z.string() }),
  ]), integrity: z.string() }),
]));

/** Presentation projection: validate known facts and drop additive unknown detail. */
export const InstalledPluginCapabilityEntryV1Schema = lazyZodSchema(() => z.readonly(z.object({
  pluginId: z.string(), desiredGeneration: z.optional(z.nullable(z.string())), appliedGeneration: z.optional(z.nullable(z.string())),
  admittedIntegrity: z.optional(z.nullable(z.string())), title: z.string(), description: z.nullable(z.string()),
  version: z.string(), enabled: z.boolean(),
  accountEnabled: z.optional(z.boolean()), machineEnabled: z.optional(z.boolean()),
  rollbackAvailability: z.optional(z.enum(['available', 'unavailable'])),
  source: z.readonly(z.object({
    kind: z.string(), locator: z.string(), devWatch: z.optional(z.boolean()), trustPolicy: z.optional(z.string()),
    installPolicy: z.optional(z.string()), resolvedPath: z.optional(z.string()),
  })),
  install: z.readonly(z.object({
    mode: z.string(), manifestVersion: z.string(), installedPath: z.optional(z.nullable(z.string())),
    updatePolicy: z.optional(PluginUpdatePolicyV1Schema),
    trust: z.optional(z.readonly(z.object({ pluginId: z.string(), distribution: DistributionSchema, state: z.literal('trusted'), approvedAtMs: z.number() }))),
  })),
  compatibility: z.readonly(z.object({ status: z.string(), diagnostics: z.readonly(z.array(DiagnosticSchema)) })),
  diagnostics: z.readonly(z.array(DiagnosticSchema)),
})));
export type InstalledPluginCapabilityEntryV1 = z.infer<typeof InstalledPluginCapabilityEntryV1Schema>;
export type InstalledPluginCapabilityDiagnosticV1 = InstalledPluginCapabilityEntryV1['diagnostics'][number];
export type InstalledPluginCapabilityDistributionV1 = z.infer<typeof DistributionSchema>;

export const PluginMarketplaceCapabilityDataV1Schema = lazyZodSchema(() => z.readonly(z.object({
  installedPlugins: z.optional(z.readonly(z.array(InstalledPluginCapabilityEntryV1Schema))),
  developmentActions: z.optional(z.readonly(z.object({ create: z.boolean() }))),
  developmentStatus: z.optional(PluginDevelopmentStatusV1Schema),
  pendingChanges: z.optional(z.readonly(z.array(z.unknown()))),
})));
export type PluginMarketplaceCapabilityDataV1 = z.infer<typeof PluginMarketplaceCapabilityDataV1Schema>;
