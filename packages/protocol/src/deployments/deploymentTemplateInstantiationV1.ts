import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentTemplateRefV1Schema, DeploymentDigestV1Schema, DeploymentComposeSelectorsV1Schema,
  StoredAppPresetInputV1Schema, StoredAppPresetBindingsV1Schema, EnvironmentVariableBindingV1Schema, DeploymentSecretBindingSourceV1Schema } from './storedAppInputV1.js';
import { SharedSavedSecretCreateInputV1Schema } from '../account/settings/savedSecretResourceActionsV1.js';
import { DeploymentTemplateV1Schema, DeploymentTemplateSecretProfileV1Schema } from '../plugins/contributions/deploymentTemplates.js';
import { ResolvedDeploymentCreationDefaultsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentEnvironmentDeployerPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

const existingEnvironment = lazyZodSchema(() => z.strictObject({ kind: z.literal('existing'), environmentId: id, expectedRevision: revision }));
const createEnvironment = lazyZodSchema(() => z.strictObject({ kind: z.literal('create'), name: StoredAppPresetInputV1Schema.shape.name, requestKey: id,
  protection: z.enum(['production', 'nonProduction']), purpose: z.literal('standard'),
  deployerMode: z.enum(['managers', 'members', 'chosen']), deployerPrincipals: z.optional(DeploymentEnvironmentDeployerPrincipalsV1Schema), controllerMachineId: id, buildMachineId: z.optional(id) }));
const existingTarget = lazyZodSchema(() => z.strictObject({ kind: z.literal('existing'), targetLinkId: id,
  expectedRevision: revision, installationId: id }));
const newTarget = lazyZodSchema(() => z.strictObject({ kind: z.literal('new'), installationId: id }));
const storedPin = lazyZodSchema(() => z.strictObject({ kind: z.literal('stored'), contentRevision: revision, composeDigest: DeploymentDigestV1Schema }));

/** Reviewed audience only; generation never widens grants or accepts credential bytes. */
export const DeploymentTemplateGeneratedSecretAudienceV1Schema = lazyZodSchema(() => z.pick(SharedSavedSecretCreateInputV1Schema,
  { accountGrants: true, teamGrants: true, groupGrants: true }));

/** The stored vertical has no pretend repository arm. SCM publication remains its own source writer. */
export const DeploymentTemplateInstantiateInputV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['preview', 'apply']), serverId: id, machineId: id, projectSourceId: id,
  templateRef: DeploymentTemplateRefV1Schema,
  environment: z.discriminatedUnion('kind', [existingEnvironment, createEnvironment]),
  target: z.discriminatedUnion('kind', [existingTarget, newTarget]),
  destination: z.union([storedPin, z.strictObject({ kind: z.literal('stored') })]),
  bindings: StoredAppPresetBindingsV1Schema,
  generatedSecretAudience: z.optional(DeploymentTemplateGeneratedSecretAudienceV1Schema),
  connectTo: z.optional(z.strictObject({ service: id })), replace: z.optional(z.array(id)),
  domainBindings: z.optional(z.array(z.strictObject({ key: id, hostname: id }))),
}).check(z.superRefine((input, context) => {
  if (input.environment.kind === 'existing' && !('contentRevision' in input.destination)
    || input.environment.kind === 'create' && ('contentRevision' in input.destination || input.target.kind !== 'new')) {
    context.addIssue({ code: 'custom', path: ['destination'], message: 'The destination must pin the existing definition or create a new stored definition.' });
  }
  if (input.bindings.some(binding => binding.source.kind === 'generated') && input.generatedSecretAudience === undefined) {
    context.addIssue({ code: 'custom', path: ['generatedSecretAudience'], message: 'Generated credentials require an explicitly reviewed audience.' });
  }
})));
export type DeploymentTemplateInstantiateInputV1 = z.infer<typeof DeploymentTemplateInstantiateInputV1Schema>;

export const DeploymentTemplateCapacityReviewV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  resource: z.enum(['memoryBytes', 'freeDiskBytes']), minimumBytes: z.number().check(z.minimum(0)),
  observedBytes: z.nullable(z.number().check(z.minimum(0))), observedAt: z.nullable(z.number().check(z.minimum(0))),
  state: z.enum(['shortfall', 'meetsMinimum', 'unknown']),
})));
export type DeploymentTemplateCapacityReviewV1 = z.infer<typeof DeploymentTemplateCapacityReviewV1Schema>;
export const DeploymentTemplateInstantiationReviewV1Schema = lazyZodSchema(() => z.strictObject({
  templateRef: DeploymentTemplateRefV1Schema, ...DeploymentComposeSelectorsV1Schema.shape,
  bindings: z.array(EnvironmentVariableBindingV1Schema),
  generatedSecrets: z.array(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']), key: id,
    profile: DeploymentTemplateSecretProfileV1Schema })),
  domains: z.array(z.extend(DeploymentTemplateV1Schema.shape.domains.def.element, { hostname: id })),
  minimumResources: DeploymentTemplateV1Schema.shape.minimumResources,
  firstRunSetup: DeploymentTemplateV1Schema.shape.firstRunSetup,
  creationDefaults: z.optional(ResolvedDeploymentCreationDefaultsV1Schema),
  creationDefaultsBasis: z.optional(z.strictObject({ projectSourceId: id, sourceRevision: revision,
    projectDefaultsRevision: z.number().check(z.int(), z.minimum(0)),
    content: z.nullable(DeploymentArtifactContentReferenceV1Schema) })),
  capacity: z.optional(DeploymentTemplateCapacityReviewV1Schema),
}));
export type DeploymentTemplateInstantiationReviewV1 = z.infer<typeof DeploymentTemplateInstantiationReviewV1Schema>;

/** A newer sample of equal capacity is the same reviewed fact, not new consent. */
export function areDeploymentTemplateReviewFactsEqualV1(left: unknown, right: unknown): boolean {
  const before = DeploymentTemplateInstantiationReviewV1Schema.safeParse(left);
  const after = DeploymentTemplateInstantiationReviewV1Schema.safeParse(right);
  if (!before.success || !after.success) return false;
  const facts = ({ capacity, ...review }: DeploymentTemplateInstantiationReviewV1) => ({ ...review,
    ...(capacity ? { capacity: capacity.map(({ observedAt: _observedAt, ...value }) => value) } : {}) });
  return sameStrictJsonValue(facts(before.data), facts(after.data));
}
const savedSecrets = lazyZodSchema(() => z.array(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']),
  source: DeploymentSecretBindingSourceV1Schema })));
export const DeploymentTemplateInstantiationPartialV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('partial'), environmentId: z.optional(id), revision: z.optional(revision),
  targetLinkId: z.optional(id), definition: z.optional(storedPin), savedSecrets,
  phase: z.enum(['generation', 'environment', 'target', 'bindings', 'metadata']), errorCode: id,
  unknownSecret: z.optional(z.strictObject({ name: id, phase: z.enum(['build', 'runtime']), ref: DeploymentSecretBindingSourceV1Schema.shape.ref })),
}));
/** Acknowledged effects survive later failure; ambiguous create refs never masquerade as saved credentials. */
export const DeploymentTemplateInstantiateResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('preview'), review: DeploymentTemplateInstantiationReviewV1Schema }),
  z.strictObject({ kind: z.literal('applied'), environmentId: id, revision, targetLinkId: id,
    definition: storedPin, savedSecrets }),
  DeploymentTemplateInstantiationPartialV1Schema,
]));
export type DeploymentTemplateInstantiateResultV1 = z.infer<typeof DeploymentTemplateInstantiateResultV1Schema>;
