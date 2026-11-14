import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ManagedMachineFullV1Schema, ManagedOpaquePresetMachineV1Schema } from './managedMachineV1.js';

function managedResourceDependencyStructuralFieldsV1() {
  return {
    managedId: ManagedMachineFullV1Schema.shape.id,
    homeId: ManagedMachineFullV1Schema.shape.homeId,
    custodianAccountId: ManagedMachineFullV1Schema.shape.custodianAccountId,
    intentRevision: ManagedMachineFullV1Schema.shape.intentRevision,
    controller: ManagedMachineFullV1Schema.shape.controller,
    allocation: ManagedMachineFullV1Schema.shape.allocation,
    resource: ManagedMachineFullV1Schema.shape.resource,
    nativeOperationRef: ManagedMachineFullV1Schema.shape.nativeOperationRef,
    recovery: ManagedMachineFullV1Schema.shape.recovery,
    observation: ManagedMachineFullV1Schema.shape.observation,
    cleanup: ManagedMachineFullV1Schema.shape.cleanup,
  };
}

function managedOpaquePresetDependencyStructuralFieldsV1() {
  return {
    managedId: ManagedOpaquePresetMachineV1Schema.shape.id,
    homeId: ManagedOpaquePresetMachineV1Schema.shape.homeId,
    custodianAccountId: ManagedOpaquePresetMachineV1Schema.shape.custodianAccountId,
    intentRevision: ManagedOpaquePresetMachineV1Schema.shape.intentRevision,
    controller: ManagedOpaquePresetMachineV1Schema.shape.controller,
    allocation: ManagedOpaquePresetMachineV1Schema.shape.allocation,
    observation: ManagedOpaquePresetMachineV1Schema.shape.observation,
    cleanup: ManagedOpaquePresetMachineV1Schema.shape.cleanup,
  };
}

/** Recovery facts only: launch choices and captured credentials never enter removal review. */
export const ManagedResourceDependencyV1Schema = lazyZodSchema(() => {
  const structural = managedResourceDependencyStructuralFieldsV1();
  const opaqueStructural = managedOpaquePresetDependencyStructuralFieldsV1();
  return z.union([
    z.strictObject({
      ...structural,
      provider: ManagedMachineFullV1Schema.shape.launch.shape.provider,
    }),
    // Preset launch/setup and native provider payload remain opaque to Home.
    // Account retirement can still review structural custody/lifecycle facts.
    z.strictObject({
      ...opaqueStructural,
      opaquePreset: z.literal(true),
    }),
  ]);
});
export type ManagedResourceDependencyV1 = z.infer<typeof ManagedResourceDependencyV1Schema>;
export type ManagedOpaquePresetResourceDependencyV1 = Extract<ManagedResourceDependencyV1, Readonly<{ opaquePreset: true }>>;

export function isManagedOpaquePresetResourceDependencyV1(
  value: ManagedResourceDependencyV1,
): value is ManagedOpaquePresetResourceDependencyV1 {
  return 'opaquePreset' in value;
}

/** Acknowledges the reviewed lifecycle; opaque presets cannot disclose native identity. */
export const ManagedResourceDispositionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    managedId: ManagedMachineFullV1Schema.shape.id,
    expectedIntentRevision: ManagedMachineFullV1Schema.shape.intentRevision,
    expectedAllocation: ManagedMachineFullV1Schema.shape.allocation,
    expectedResource: ManagedMachineFullV1Schema.shape.resource,
    expectedNativeOperationRef: ManagedMachineFullV1Schema.shape.nativeOperationRef,
    expectedRecovery: ManagedMachineFullV1Schema.shape.recovery,
    responsibility: z.literal('manual'),
  }),
  z.strictObject({
    managedId: ManagedOpaquePresetMachineV1Schema.shape.id,
    expectedIntentRevision: ManagedOpaquePresetMachineV1Schema.shape.intentRevision,
    expectedAllocation: ManagedOpaquePresetMachineV1Schema.shape.allocation,
    opaquePreset: z.literal(true),
    responsibility: z.literal('manual'),
  }),
]));
export type ManagedResourceDispositionV1 = z.infer<typeof ManagedResourceDispositionV1Schema>;
export type ManagedOpaquePresetResourceDispositionV1 = Extract<ManagedResourceDispositionV1, Readonly<{ opaquePreset: true }>>;

export function isManagedOpaquePresetResourceDispositionV1(
  value: ManagedResourceDispositionV1,
): value is ManagedOpaquePresetResourceDispositionV1 {
  return 'opaquePreset' in value;
}
