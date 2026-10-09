import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ManagedMachineV1Schema } from './managedMachineV1.js';

/** Recovery facts only: launch choices and captured credentials never enter removal review. */
export const ManagedResourceDependencyV1Schema = lazyZodSchema(() => z.object({
  managedId: ManagedMachineV1Schema.shape.id,
  homeId: ManagedMachineV1Schema.shape.homeId,
  custodianAccountId: ManagedMachineV1Schema.shape.custodianAccountId,
  intentRevision: ManagedMachineV1Schema.shape.intentRevision,
  controller: ManagedMachineV1Schema.shape.controller,
  provider: ManagedMachineV1Schema.shape.launch.shape.provider,
  allocation: ManagedMachineV1Schema.shape.allocation,
  resource: ManagedMachineV1Schema.shape.resource,
  nativeOperationRef: ManagedMachineV1Schema.shape.nativeOperationRef,
  recovery: ManagedMachineV1Schema.shape.recovery,
  observation: ManagedMachineV1Schema.shape.observation,
  cleanup: ManagedMachineV1Schema.shape.cleanup,
}).strict());
export type ManagedResourceDependencyV1 = z.infer<typeof ManagedResourceDependencyV1Schema>;

/** Acknowledges the exact reviewed resource; this is not native cleanup authorization. */
export const ManagedResourceDispositionV1Schema = lazyZodSchema(() => z.object({
  managedId: ManagedMachineV1Schema.shape.id,
  expectedIntentRevision: ManagedMachineV1Schema.shape.intentRevision,
  expectedAllocation: ManagedMachineV1Schema.shape.allocation,
  expectedResource: ManagedMachineV1Schema.shape.resource,
  expectedNativeOperationRef: ManagedMachineV1Schema.shape.nativeOperationRef,
  expectedRecovery: ManagedMachineV1Schema.shape.recovery,
  responsibility: z.literal('manual'),
}).strict());
export type ManagedResourceDispositionV1 = z.infer<typeof ManagedResourceDispositionV1Schema>;
