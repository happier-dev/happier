import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';

/** Shipped 0.2 input grammar, reused by the canonical authoring value readers. */
export const LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS = Object.freeze([
  'recentMachinePaths', 'lastUsedProfile', 'lastEngineSelectionsByScopeV1',
] as const);
export type LegacyAuthoringMemorySettingsKey = typeof LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS[number];

export const LegacyRecentMachinePathSchema = lazyZodSchema(() => z.object({
  machineId: z.string().min(1),
  path: z.string().min(1),
}).strip());

export const LegacyRecentMachinePathsSchema = lazyZodSchema(() => z.preprocess((value) => {
  if (!Array.isArray(value)) return [];
  const paths: Array<z.output<typeof LegacyRecentMachinePathSchema>> = [];
  for (const candidate of value) {
    const parsed = LegacyRecentMachinePathSchema.safeParse(candidate);
    if (!parsed.success) continue;
    paths.push(parsed.data);
  }
  return paths;
}, z.array(LegacyRecentMachinePathSchema)));

export const LegacyLastUsedProfileSchema = lazyZodSchema(() => z.string().nullable());
export const LegacyRememberedEngineSelectionsByScopeV1Schema = lazyZodSchema(() => z.record(
  // Engine carriers now belong to reserved rows, not the whole Settings
  // document. Its generic collection/depth budgets do not govern this domain.
  z.string(), StrictJsonValueSchema,
));
export type RetainedRememberedEngineSelectionsByScopeV1 = z.infer<typeof LegacyRememberedEngineSelectionsByScopeV1Schema>;
