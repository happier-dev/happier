import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ManagedEnrollmentCorrelationV1Schema } from './managed/actionsV1.js';

const id = () => z.string().check(z.minLength(1));

/** Compose owns this native service; its accepted deployment owns enrollment admission. */
export const DeploymentAppEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('deploymentApp'), homeId: id(), environmentId: id(), deploymentId: id(),
  actionOperationId: id(), controller: z.strictObject({ machineId: id(), installationId: id() }),
}));
export type DeploymentAppEnrollmentCorrelationV1 = z.infer<typeof DeploymentAppEnrollmentCorrelationV1Schema>;

export const DeploymentAppEnrollmentAdmissionInputV1Schema = lazyZodSchema(() => z.extend(DeploymentAppEnrollmentCorrelationV1Schema, {
  pairingPublicKey: z.optional(id()), existingMachineId: z.optional(id()),
}));

/** Public receipt provenance only; service identity stays in Account-mode Machine metadata. */
export const DeploymentAppMachineAssociationV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id(), deploymentId: id(), targetLinkId: id(),
  controller: z.strictObject({ machineId: id(), installationId: id() }),
}));
export type DeploymentAppMachineAssociationV1 = z.infer<typeof DeploymentAppMachineAssociationV1Schema>;

/** The existing ordinary registration carrier accepts either source, without changing managed custody. */
export const MachineEnrollmentCorrelationV1Schema = lazyZodSchema(() => z.union([
  ManagedEnrollmentCorrelationV1Schema, DeploymentAppEnrollmentCorrelationV1Schema,
]));
export type MachineEnrollmentCorrelationV1 = z.infer<typeof MachineEnrollmentCorrelationV1Schema>;

export function isDeploymentAppEnrollmentCorrelationV1(
  value: MachineEnrollmentCorrelationV1,
): value is DeploymentAppEnrollmentCorrelationV1 {
  return 'source' in value && value.source === 'deploymentApp';
}

export const DeploymentAppEnrollmentAdmissionResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true), enrollment: DeploymentAppEnrollmentCorrelationV1Schema,
  enrollmentAccountId: id(), machineId: z.optional(id()),
}));
