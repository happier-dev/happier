import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createValidatedLaunchSnapshotV1Schema } from './managedMachineV1.js';

/** Structural projection of the CLI supplier's already-selected image installation. */
export const ManagedGuestCliBuildInputV1Schema = lazyZodSchema(() => z.strictObject({
  identity: z.string(),
  versionId: z.string(),
  binaryPath: z.string(),
  installScript: z.string(),
  files: z.array(z.strictObject({ path: z.string(), contentsBase64: z.string() })),
}));
type ParsedManagedGuestCliBuildInputV1 = z.infer<typeof ManagedGuestCliBuildInputV1Schema>;
export type ManagedGuestCliBuildInputV1 = Readonly<Omit<ParsedManagedGuestCliBuildInputV1, 'files'> & {
  files: readonly Readonly<ParsedManagedGuestCliBuildInputV1['files'][number]>[];
}>;

/** Provider roles specialize their owned choices while sharing the closed build envelope. */
export function createManagedMachinePresetPreparationBuildInputV1Schema<Choices extends z.core.$ZodType>(choices: Choices) {
  return z.strictObject({
    launch: z.pick(createValidatedLaunchSnapshotV1Schema(choices),
      { provider: true, schemaVersion: true, choices: true }),
    cli: ManagedGuestCliBuildInputV1Schema,
    setupScript: z.optional(z.string()),
  });
}

/** Portable native-build boundary: no preset name, credential selector or cold setup body. */
export const ManagedMachinePresetPreparationBuildInputV1Schema = lazyZodSchema(() =>
  createManagedMachinePresetPreparationBuildInputV1Schema(PluginJsonValueV2Schema));
export type ManagedMachinePresetPreparationBuildInputV1 = Readonly<
  Omit<z.infer<typeof ManagedMachinePresetPreparationBuildInputV1Schema>, 'cli'> & {
    cli: ManagedGuestCliBuildInputV1;
  }
>;
