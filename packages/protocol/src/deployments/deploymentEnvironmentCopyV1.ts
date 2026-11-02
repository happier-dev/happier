import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentSecretBindingSourceV1Schema, DeploymentNonSecretVariableBindingSourceV1Schema,
  EnvironmentSecretBindingIdentityV1Schema, EnvironmentSecretBindingV1Schema,
  environmentSecretBindingIdentityV1, DeploymentTextV1Schema } from './storedAppInputV1.js';

/** Only this non-content source/CAS reference crosses the Home storage boundary. */
export const DeploymentEnvironmentCopySourceV1Schema = lazyZodSchema(() => z.strictObject({ environmentId: id, expectedRevision: revision }));
export type DeploymentEnvironmentCopySourceV1 = z.infer<typeof DeploymentEnvironmentCopySourceV1Schema>;

const binding = () => ({ binding: EnvironmentSecretBindingIdentityV1Schema });
const secretChoice = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...binding(), kind: z.literal('omit') }),
  z.strictObject({ ...binding(), kind: z.literal('useSameReference') }),
  z.strictObject({ ...binding(), kind: z.literal('rebind'), source: DeploymentSecretBindingSourceV1Schema }),
]));
const valueChoice = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ ...binding(), kind: z.literal('omit') }),
  z.strictObject({ ...binding(), kind: z.literal('include') }),
  z.strictObject({ ...binding(), kind: z.literal('remap'), source: DeploymentNonSecretVariableBindingSourceV1Schema }),
]));
const dataChoice = lazyZodSchema(() => z.strictObject({ targetLinkId: id,
  kind: z.enum(['omit', 'reuse', 'createEmpty', 'restoreBackup']) }));

/** Decisions name every source row; source preparation checks completeness and row kinds. */
export const DeploymentEnvironmentCopyChoicesV1Schema = lazyZodSchema(() => z.strictObject({
  secrets: z.array(secretChoice), values: z.array(valueChoice), data: z.array(dataChoice),
  retainPreviousDeployments: z.optional(z.enum(['copy', 'default'])),
}).check(z.refine(choices => {
  const bindings = [...choices.secrets, ...choices.values].map(choice => environmentSecretBindingIdentityV1(choice.binding));
  return new Set(bindings).size === bindings.length
    && new Set(choices.data.map(choice => choice.targetLinkId)).size === choices.data.length;
}, { message: 'Each copied binding or data attachment has one explicit decision.' })));
export type DeploymentEnvironmentCopyChoicesV1 = z.infer<typeof DeploymentEnvironmentCopyChoicesV1Schema>;

export const DeploymentEnvironmentCopyFromV1Schema = lazyZodSchema(() => z.extend(DeploymentEnvironmentCopySourceV1Schema, {
  choices: DeploymentEnvironmentCopyChoicesV1Schema,
}));
export type DeploymentEnvironmentCopyFromV1 = z.infer<typeof DeploymentEnvironmentCopyFromV1Schema>;

/** Exact Action custody only. Fresh destination grants still belong to bindings.set. */
export const DeploymentEnvironmentCopyPlanV1Schema = lazyZodSchema(() => z.strictObject({
  bindings: z.array(EnvironmentSecretBindingV1Schema), sourceRuntimeTargetLinkId: z.optional(id),
}).check(z.refine(plan => new Set(plan.bindings.map(environmentSecretBindingIdentityV1)).size === plan.bindings.length,
  { message: 'Copied bindings retain unique purpose identities.' })));
export type DeploymentEnvironmentCopyPlanV1 = z.infer<typeof DeploymentEnvironmentCopyPlanV1Schema>;

/** Review describes decisions, never secret references, values, grants or provider credentials. */
export const DeploymentEnvironmentCopyReviewV1Schema = lazyZodSchema(() => z.strictObject({
  sourceEnvironmentId: id, sourceRevision: revision,
  omitted: z.array(DeploymentTextV1Schema), included: z.array(DeploymentTextV1Schema),
}));
export type DeploymentEnvironmentCopyReviewV1 = z.infer<typeof DeploymentEnvironmentCopyReviewV1Schema>;
