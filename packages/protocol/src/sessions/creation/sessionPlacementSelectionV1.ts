import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ManagedMachinePresetV1Schema } from '../../machines/managed/managedMachinePresetV1.js';
import { MachineIsolationConfiguredSandboxV1Schema, MachineIsolationSandboxWorkChoiceV1Schema, SessionProjectFilesV1Schema } from '../../machines/machineIsolationV1.js';
export { SessionProjectFilesV1Schema, type SessionProjectFilesV1 } from '../../machines/machineIsolationV1.js';
import { SessionExecutionTargetV1Schema } from './sessionExecutionTargetV1.js';
import { SessionProjectFilesSourceV1Schema } from './sessionProjectFilesSourceV1.js';
export { SessionProjectFilesSourceV1Schema, type SessionProjectFilesSourceV1 } from './sessionProjectFilesSourceV1.js';

export const SessionMachinePlacementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('machine'), target: SessionExecutionTargetV1Schema,
  projectFiles: z.optional(SessionProjectFilesV1Schema),
  projectFilesSource: z.optional(SessionProjectFilesSourceV1Schema),
}));
export const SessionPresetPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('preset'), homeId: ManagedMachinePresetV1Schema.shape.homeId, presetId: ManagedMachinePresetV1Schema.shape.id,
  projectFiles: z.optional(SessionProjectFilesV1Schema),
  projectFilesSource: z.optional(SessionProjectFilesSourceV1Schema),
}));

/** Files for the managed creation selected in this same authoring submission, without a second target. */
export const SessionManagedPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('managed'),
  projectFiles: z.optional(SessionProjectFilesV1Schema),
  projectFilesSource: z.optional(SessionProjectFilesSourceV1Schema),
}));

/** The saved selection retains the owning Machine's qualified configured entry. */
export const SessionConfiguredSandboxSelectionV1Schema = lazyZodSchema(() => z.extend(
  MachineIsolationSandboxWorkChoiceV1Schema, MachineIsolationConfiguredSandboxV1Schema.shape,
));

/** Shared by Session authoring and admitted Workflow host placement; absent means Machine policy. */
export const SessionPlacementSelectionV1Schema = lazyZodSchema(() => z.union([
  z.extend(SessionMachinePlacementV1Schema, { configuredSandbox: z.optional(SessionConfiguredSandboxSelectionV1Schema) }),
  SessionPresetPlacementV1Schema,
  SessionManagedPlacementV1Schema,
]));
export type SessionPlacementSelectionV1 = z.infer<typeof SessionPlacementSelectionV1Schema>;
