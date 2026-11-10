import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { SessionSpawnNewInputV2 } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { SessionSpawnNewSelectionV2Schema } from '../sessions/creation/sessionSpawnNewSelectionV2.js';

export const DiscussionModelParticipantLaunchV1Schema = lazyZodSchema(() => SessionSpawnNewSelectionV2Schema);
export type DiscussionModelParticipantLaunchV1 = z.infer<typeof DiscussionModelParticipantLaunchV1Schema>;

/** Project the actual admitted ordinary input; no consumer copies selection keys. */
export function projectDiscussionModelParticipantLaunchV1(input: SessionSpawnNewInputV2): DiscussionModelParticipantLaunchV1 {
  return DiscussionModelParticipantLaunchV1Schema.parse(Object.fromEntries(Object.entries(input)
    .filter(([key]) => Object.hasOwn(DiscussionModelParticipantLaunchV1Schema.shape, key))));
}
