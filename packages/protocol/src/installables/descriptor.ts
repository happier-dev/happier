import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { PluginDescriptorBaseV1Schema } from '../plugins/contributions/_descriptors.js';
import { InstallableSourceSchema } from './sourceKind.js';

export const InstallableAutoUpdateModeSchema = lazyZodSchema(() => z.enum(['off', 'notify', 'auto']));
export type InstallableAutoUpdateMode = z.infer<typeof InstallableAutoUpdateModeSchema>;

export const InstallableDefaultPolicySchema = lazyZodSchema(() => z.strictObject({
  autoInstallWhenNeeded: z.boolean(),
  autoUpdateMode: InstallableAutoUpdateModeSchema,
}));
export type InstallableDefaultPolicy = z.infer<typeof InstallableDefaultPolicySchema>;

export const InstallableConsentModeSchema = lazyZodSchema(() => z.enum(['not_required', 'required']));
export type InstallableConsentMode = z.infer<typeof InstallableConsentModeSchema>;

export const InstallableCapabilityIdSchema = lazyZodSchema(() => z.templateLiteral([
  'dep.', z.string().check(z.regex(/^[A-Za-z0-9._-]+$/, 'Installable capabilityId must use dep.* syntax')),
]));

// Inherits `id`, `version`, gates, redaction, ordering, hidden, defaultValue, clearWhenEmpty
// from PluginDescriptorBaseV1Schema. Only declare fields specific to dependency installables here;
// repeating base fields creates a divergence risk if the base ever tightens (e.g. semver constraints).
// `kind` is restated as a literal narrowing so `InstallableDependencyDescriptor['kind']` resolves to
// the discriminator at the type level — the runtime constraint is still validated by the base.
const InstallableDependencyDescriptorFieldsSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.trim(), z.minLength(1)),
  kind: z.literal('dep'),
  capabilityId: InstallableCapabilityIdSchema,
  display: z.strictObject({
    name: z.string().check(z.trim(), z.minLength(1)),
    subtitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  }),
  description: z.string().check(z.trim(), z.minLength(1)),
  source: InstallableSourceSchema,
  binary: z.strictObject({
    commands: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
    systemFirst: z._default(z.boolean(), true),
    managedFallback: z.optional(z.boolean()),
    platforms: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
    arches: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  }),
  defaultPolicy: InstallableDefaultPolicySchema,
  consent: z.strictObject({
    install: InstallableConsentModeSchema,
    update: InstallableConsentModeSchema,
    commandsPreviewRequired: z.optional(z.boolean()),
  }),
  ui: z.optional(z.strictObject({
    setupUrl: z.optional(z.string().check(z.trim(), z.url())),
    iconName: z.optional(z.string().check(z.trim(), z.minLength(1))),
  })),
  stability: z._default(z.strictObject({
    experimental: z._default(z.boolean(), false),
    supported: z._default(z.boolean(), true),
  }), { experimental: false, supported: true }),
}));

export const InstallableDependencyDescriptorSchema = lazyZodSchema(() => z.intersection(PluginDescriptorBaseV1Schema, InstallableDependencyDescriptorFieldsSchema).check(z.superRefine((value, ctx) => {
    if (value.id !== value.key) {
      ctx.addIssue({
        code: "custom",
        path: ['id'],
        message: 'Installable descriptor id must match key',
      });
    }
    if (value.source.kind === 'vendor_recipe' && value.consent.install !== 'required') {
      ctx.addIssue({
        code: "custom",
        path: ['consent', 'install'],
        message: 'Vendor recipe installables require explicit install consent',
      });
    }
  })));
export type InstallableDependencyDescriptor = z.infer<typeof InstallableDependencyDescriptorSchema>;

export type InstallableKind = InstallableDependencyDescriptor['kind'];
export type InstallableCatalogEntry = Readonly<{
  key: string;
  kind: InstallableKind;
  capabilityId: z.infer<typeof InstallableCapabilityIdSchema>;
  sourceKind: InstallableDependencyDescriptor['source']['kind'];
  display: InstallableDependencyDescriptor['display'];
  description: InstallableDependencyDescriptor['description'];
  ui?: InstallableDependencyDescriptor['ui'];
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
    display: descriptor.display,
    description: descriptor.description,
    ...(descriptor.ui ? { ui: descriptor.ui } : {}),
    defaultPolicy: descriptor.defaultPolicy,
    experimental: descriptor.stability.experimental,
  });
}
