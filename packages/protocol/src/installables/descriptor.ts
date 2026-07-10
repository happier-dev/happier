import { z } from 'zod';

import type { CapabilityId } from '../capabilities/index.js';
import { PluginDescriptorBaseV1Schema } from '../plugins/contributions/_descriptors.js';
import { InstallableSourceSchema } from './sourceKind.js';

export const InstallableAutoUpdateModeSchema = z.enum(['off', 'notify', 'auto']);
export type InstallableAutoUpdateMode = z.infer<typeof InstallableAutoUpdateModeSchema>;

export const InstallableDefaultPolicySchema = z.object({
  autoInstallWhenNeeded: z.boolean(),
  autoUpdateMode: InstallableAutoUpdateModeSchema,
}).strict();
export type InstallableDefaultPolicy = z.infer<typeof InstallableDefaultPolicySchema>;

export const InstallableConsentModeSchema = z.enum(['not_required', 'required']);
export type InstallableConsentMode = z.infer<typeof InstallableConsentModeSchema>;

const InstallableCapabilityIdSchema = z.custom<Extract<CapabilityId, `dep.${string}`>>(
  (value) => typeof value === 'string' && /^dep\.[A-Za-z0-9._-]+$/.test(value),
  'Installable capabilityId must use dep.* syntax',
);

// Inherits `id`, `version`, gates, redaction, ordering, hidden, defaultValue, clearWhenEmpty
// from PluginDescriptorBaseV1Schema. Only declare fields specific to dependency installables here;
// repeating base fields creates a divergence risk if the base ever tightens (e.g. semver constraints).
// `kind` is restated as a literal narrowing so `InstallableDependencyDescriptor['kind']` resolves to
// the discriminator at the type level — the runtime constraint is still validated by the base.
const InstallableDependencyDescriptorFieldsSchema = z.object({
  key: z.string().trim().min(1),
  kind: z.literal('dep'),
  capabilityId: InstallableCapabilityIdSchema,
  display: z.object({
    name: z.string().trim().min(1),
    subtitle: z.string().trim().min(1).optional(),
  }).strict(),
  description: z.string().trim().min(1),
  source: InstallableSourceSchema,
  binary: z.object({
    commands: z.array(z.string().trim().min(1)).min(1),
    systemFirst: z.boolean().default(true),
    managedFallback: z.boolean().optional(),
    platforms: z.array(z.string().trim().min(1)).optional(),
    arches: z.array(z.string().trim().min(1)).optional(),
  }).strict(),
  defaultPolicy: InstallableDefaultPolicySchema,
  consent: z.object({
    install: InstallableConsentModeSchema,
    update: InstallableConsentModeSchema,
    commandsPreviewRequired: z.boolean().optional(),
  }).strict(),
  ui: z.object({
    setupUrl: z.string().trim().url().optional(),
    iconName: z.string().trim().min(1).optional(),
  }).strict().optional(),
  stability: z.object({
    experimental: z.boolean().default(false),
    supported: z.boolean().default(true),
  }).strict().default({ experimental: false, supported: true }),
}).strict();

export const InstallableDependencyDescriptorSchema = PluginDescriptorBaseV1Schema
  .and(InstallableDependencyDescriptorFieldsSchema)
  .superRefine((value, ctx) => {
    if (value.id !== value.key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: 'Installable descriptor id must match key',
      });
    }
    if (value.source.kind === 'vendor_recipe' && value.consent.install !== 'required') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consent', 'install'],
        message: 'Vendor recipe installables require explicit install consent',
      });
    }
  });
export type InstallableDependencyDescriptor = z.infer<typeof InstallableDependencyDescriptorSchema>;

export type InstallableKind = InstallableDependencyDescriptor['kind'];
export type InstallableCatalogEntry = Readonly<{
  key: string;
  kind: InstallableKind;
  capabilityId: Extract<CapabilityId, `dep.${string}`>;
  sourceKind: InstallableDependencyDescriptor['source']['kind'];
  defaultPolicy: InstallableDefaultPolicy;
  experimental: boolean;
}>;

export function toInstallableCatalogEntry(
  descriptor: InstallableDependencyDescriptor,
): InstallableCatalogEntry {
  return Object.freeze({
    key: descriptor.key,
    kind: descriptor.kind,
    capabilityId: descriptor.capabilityId,
    sourceKind: descriptor.source.kind,
    defaultPolicy: descriptor.defaultPolicy,
    experimental: descriptor.stability.experimental,
  });
}
