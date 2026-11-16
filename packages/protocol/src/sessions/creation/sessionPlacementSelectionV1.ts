import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ManagedMachinePresetV1Schema } from '../../machines/managed/managedMachinePresetV1.js';
import { MachineIsolationConfiguredSandboxV1Schema, MachineIsolationSandboxWorkChoiceV1Schema } from '../../machines/machineIsolationV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';

export const SessionMachinePlacementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machine'), target: SessionExecutionTargetV1Schema,
}));
export const SessionPresetPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preset'), homeId: ManagedMachinePresetV1Schema.shape.homeId, presetId: ManagedMachinePresetV1Schema.shape.id,
}));

/** The saved selection retains the owning Machine's qualified configured entry. */
export const SessionConfiguredSandboxSelectionV1Schema = lazyZodSchema(() => z.extend(
  MachineIsolationSandboxWorkChoiceV1Schema, MachineIsolationConfiguredSandboxV1Schema.shape,
));

/** Shared by Session authoring and admitted Workflow host placement; absent means Machine policy. */
export const SessionPlacementSelectionV1Schema = lazyZodSchema(() => z.union([
  z.extend(SessionMachinePlacementV1Schema, { configuredSandbox: z.optional(SessionConfiguredSandboxSelectionV1Schema) }),
  SessionPresetPlacementV1Schema,
]));
export type SessionPlacementSelectionV1 = z.infer<typeof SessionPlacementSelectionV1Schema>;
