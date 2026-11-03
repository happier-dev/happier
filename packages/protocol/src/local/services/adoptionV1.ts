import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DeploymentEnvironmentCreateBaseInputV1Schema, DeploymentEnvironmentCreateInputV1Schema } from '../../deployments/deploymentEnvironmentCreateV1.js';
import { DeploymentTextV1Schema, hasOneDeploymentProjectV1 } from '../../deployments/storedAppInputV1.js';
import { DeploymentRetainPreviousDeploymentsV1Schema } from '../../projects/deploymentCreationDefaultsV1.js';
import { DeploymentDigestV1Schema, EnvironmentVariableBindingV1Schema } from '../../deployments/storedAppInputV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
export const MachineServiceAdoptionDestinationV1Schema = lazyZodSchema(() => z.extend(z.pick(DeploymentEnvironmentCreateBaseInputV1Schema, {
  projectSourceId: true, newProject: true, protection: true, purpose: true, deployerMode: true,
  deployerPrincipals: true, controllerMachineId: true, buildMachineId: true, managedRetention: true,
}), {
  name: DeploymentTextV1Schema, controllerMachineId: z.optional(DeploymentEnvironmentCreateBaseInputV1Schema.shape.controllerMachineId),
  retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
}).check(z.refine(input => hasOneDeploymentProjectV1(input.projectSourceId, input.newProject),
  { message: 'Select an existing or reviewed new Project.' })));
export const MachineServiceAdoptionVariableV1Schema = lazyZodSchema(() => z.strictObject({
  name: EnvironmentVariableBindingV1Schema.shape.name, phase: z.literal('runtime'), required: z.boolean(), hasDefault: z.boolean(),
}));
export const MachineServiceAdoptInputV1Schema = lazyZodSchema(() => {
  const base = { serverId: id(), machineId: id(), serviceId: id(), expectedGeneration: id(),
    requestKey: id(), profiles: z.array(id()) };
  return z.discriminatedUnion('mode', [
    z.strictObject({ ...base, mode: z.literal('review') }),
    z.strictObject({ ...base, mode: z.literal('apply'), reviewedDigest: DeploymentDigestV1Schema,
      destination: MachineServiceAdoptionDestinationV1Schema,
      bindingsConfirmed: z.literal(true), bindings: z.array(EnvironmentVariableBindingV1Schema),
    }),
  ]);
});
export type MachineServiceAdoptInputV1 = z.infer<typeof MachineServiceAdoptInputV1Schema>;
export const MachineServiceAdoptResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('review'), reviewedDigest: DeploymentDigestV1Schema, originalProfiles: z.literal('unknown'),
    document: z.string(), variables: z.array(MachineServiceAdoptionVariableV1Schema), services: z.array(id()),
    profiles: z.array(id()), availableProfiles: z.array(id()),
  }),
  z.strictObject({ kind: z.literal('adopted'), environmentId: id(), revision: z.number().check(z.int(), z.nonnegative()), targetLinkId: id() }),
  z.strictObject({ kind: z.literal('partial'), environmentId: z.optional(id()), revision: z.optional(z.number().check(z.int(), z.nonnegative())),
    targetLinkId: z.optional(id()), errorCode: id(), preparedCreate: DeploymentEnvironmentCreateInputV1Schema,
  }),
]));
export type MachineServiceAdoptResultV1 = z.infer<typeof MachineServiceAdoptResultV1Schema>;
