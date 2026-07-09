import { z } from 'zod';

import { ScmRepoModeSchema } from '../../scm/index.js';
import { ScmBackendCapabilitiesSchema } from '../../scm/backendCapabilities.js';

const DependencyCapabilityIdSchema = z.string().trim().regex(
  /^dep\.[A-Za-z0-9._-]+$/,
  'SCM backend installable dependencies must use dep.* ids',
);

export const ScmBackendContributionDetectionSchema = z.object({
  rootMarkers: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ScmBackendContributionDetection = z.infer<typeof ScmBackendContributionDetectionSchema>;

export const ScmBackendContributionToolCommandSchema = z.object({
  installableKey: DependencyCapabilityIdSchema,
  command: z.string().trim().min(1),
}).strict();
export type ScmBackendContributionToolCommand = z.infer<typeof ScmBackendContributionToolCommandSchema>;

export const ScmBackendContributionToolingSchema = z.object({
  commands: z.array(ScmBackendContributionToolCommandSchema).default([]),
  systemFirst: z.boolean().default(true),
  managedFallback: z.boolean().default(false),
}).strict().default({
  commands: [],
  systemFirst: true,
  managedFallback: false,
});
export type ScmBackendContributionTooling = z.infer<typeof ScmBackendContributionToolingSchema>;

export const ScmBackendContributionSafetyConstraintsSchema = z.object({
  mutatesWorkingTree: z.boolean().default(false),
  requiresUserConfirmationForDestructiveWrites: z.boolean().default(false),
}).strict().default({
  mutatesWorkingTree: false,
  requiresUserConfirmationForDestructiveWrites: false,
});
export type ScmBackendContributionSafetyConstraints =
  z.infer<typeof ScmBackendContributionSafetyConstraintsSchema>;

export const ScmBackendContributionSchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  repoModes: z.array(ScmRepoModeSchema).min(1),
  detection: ScmBackendContributionDetectionSchema,
  capabilities: ScmBackendCapabilitiesSchema,
  installableDependencies: z.array(DependencyCapabilityIdSchema).default([]),
  tooling: ScmBackendContributionToolingSchema,
  safetyConstraints: ScmBackendContributionSafetyConstraintsSchema,
}).strict();
export type ScmBackendContribution = z.infer<typeof ScmBackendContributionSchema>;
