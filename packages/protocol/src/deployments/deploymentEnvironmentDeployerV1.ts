import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';

/** Exact chosen identities; membership and Source access are always resolved at admission. */
export const DeploymentEnvironmentDeployerPrincipalV1Schema = lazyZodSchema(() => z.strictObject({
  principalKind: z.enum(['account', 'teamGroup']), principalId: DeploymentIdentifierV1Schema,
}));
export type DeploymentEnvironmentDeployerPrincipalV1 = z.infer<typeof DeploymentEnvironmentDeployerPrincipalV1Schema>;
export const DeploymentEnvironmentDeployerPrincipalsV1Schema = lazyZodSchema(() => z.array(DeploymentEnvironmentDeployerPrincipalV1Schema).check(
  z.refine(principals => new Set(principals.map(principal => JSON.stringify([principal.principalKind, principal.principalId]))).size === principals.length,
    { message: 'Chosen deployer principals must be unique.' })));
