import { lazyZodSchema } from '../lazyZodSchema.js';
import { BashResultV2Schema } from '../tools/v2/schemas.js';
import { z } from '../zodRuntimePolicy.js';
import { PET_ANIMATION_STATES_V1 } from './constants.js';

export const HATCH_PET_STEP_IDS_V1 = ['gettingReady', 'mainLook', 'poses', 'hatching'] as const;
export type HatchPetStepIdV1 = typeof HATCH_PET_STEP_IDS_V1[number];

const FailureSchema = lazyZodSchema(() => z.strictObject({
  message: z.string().check(z.minLength(1)),
  details: z.optional(z.string()),
}));
const StepSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['pending', 'in_progress', 'completed']) }),
  z.strictObject({ status: z.literal('failed'), failure: FailureSchema }),
]));
const PoseSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.enum(['pending', 'drawing', 'drawn']) }),
  z.strictObject({ status: z.literal('failed'), failure: FailureSchema }),
]));

/** A snapshot in an ordinary phase command's final stdout line, never an Artifact. */
export const HatchPetProgressV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('hatch_pet_progress_v1'),
  petName: z.string().check(z.minLength(1)),
  steps: z.record(z.enum(HATCH_PET_STEP_IDS_V1), StepSchema),
  poses: z.record(z.enum(PET_ANIMATION_STATES_V1), PoseSchema),
}));
export type HatchPetProgressV1 = z.infer<typeof HatchPetProgressV1Schema>;
export type HatchPetProgressPlanV1 = Readonly<{
  petName: string;
  steps: ReadonlyArray<Readonly<{
    id: HatchPetStepIdV1;
    label: string;
  }> & HatchPetProgressV1['steps'][HatchPetStepIdV1]>;
  poses: HatchPetProgressV1['poses'];
  drawnPoseCount: number;
  totalPoseCount: number;
}>;

/** Parse the existing canonical command result and its final progress line at the boundary. */
export function readHatchPetProgressFromToolResultV1(result: unknown): HatchPetProgressV1 | null {
  const command = BashResultV2Schema.safeParse(result);
  if (!command.success || !command.data.stdout) return null;
  const line = command.data.stdout.trimEnd().split('\n').at(-1);
  if (!line) return null;
  try {
    const parsed = HatchPetProgressV1Schema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Derive the checklist from the snapshot; counts are never separately stored. */
export function projectHatchPetProgressPlanV1(progress: HatchPetProgressV1): HatchPetProgressPlanV1 {
  const drawnPoseCount = PET_ANIMATION_STATES_V1.filter(state => progress.poses[state].status === 'drawn').length;
  const totalPoseCount = PET_ANIMATION_STATES_V1.length;
  const labels: Record<HatchPetStepIdV1, string> = {
    gettingReady: `Getting ${progress.petName} ready`,
    mainLook: `Imagining ${progress.petName}'s main look`,
    poses: `Picturing ${progress.petName}'s poses · ${drawnPoseCount} of ${totalPoseCount}`,
    hatching: `Hatching ${progress.petName}`,
  };
  return {
    petName: progress.petName,
    steps: HATCH_PET_STEP_IDS_V1.map(id => ({ id, label: labels[id], ...progress.steps[id] })),
    poses: progress.poses,
    drawnPoseCount,
    totalPoseCount,
  };
}
