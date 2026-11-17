import { describe, expect, it } from 'vitest';

import { BashResultV2Schema } from '../tools/v2/schemas.js';
import { PET_ANIMATION_STATES_V1 } from './constants.js';
import { projectHatchPetProgressPlanV1, readHatchPetProgressFromToolResultV1 } from './hatchPetProgressV1.js';

function snapshot() {
  return {
    kind: 'hatch_pet_progress_v1', petName: 'Capy',
    steps: { gettingReady: { status: 'completed' }, mainLook: { status: 'completed' },
      poses: { status: 'in_progress' }, hatching: { status: 'pending' } },
    poses: Object.fromEntries(PET_ANIMATION_STATES_V1.map((state, index) =>
      [state, { status: index < 5 ? 'drawn' : index === 5 ? 'drawing' : 'pending' }])),
  };
}

describe('Hatch pet progress in an existing command result', () => {
  it('reads the final stdout snapshot and projects four steps with the real drawn pose count', () => {
    const input = snapshot();
    const result = BashResultV2Schema.parse({ stdout: `Prepared a row\n${JSON.stringify(input)}\n`, exit_code: 0 });
    const progress = readHatchPetProgressFromToolResultV1(result);
    expect(progress).toEqual(input);
    if (!progress) throw new Error('Expected the command progress');
    const plan = projectHatchPetProgressPlanV1(progress);
    expect(plan.steps.map(step => step.label)).toEqual([
      'Getting Capy ready', "Imagining Capy's main look", "Picturing Capy's poses · 5 of 9", 'Hatching Capy',
    ]);
    expect(plan.steps.map(step => step.status)).toEqual(['completed', 'completed', 'in_progress', 'pending']);
    expect(plan.poses.failed).toEqual({ status: 'drawing' });
    expect(plan.drawnPoseCount).toBe(5);
    expect(plan.totalPoseCount).toBe(PET_ANIMATION_STATES_V1.length);
  });

  it('preserves failed step and pose details from a command that failed', () => {
    const input = snapshot();
    const failure = { message: 'Image generation failed', details: 'The image tool returned unavailable.' };
    const value = { ...input, steps: { ...input.steps, poses: { status: 'failed', failure } },
      poses: { ...input.poses, failed: { status: 'failed', failure } } };
    const progress = readHatchPetProgressFromToolResultV1({ stdout: JSON.stringify(value), exit_code: 1 });
    expect(progress).toEqual(value);
    if (!progress) throw new Error('Expected the failed command progress');
    expect(projectHatchPetProgressPlanV1(progress).steps[2]).toMatchObject({ status: 'failed', failure });
    expect(progress.poses.failed).toEqual({ status: 'failed', failure });
  });

  it('rejects unrelated output, incomplete poses, failed entries without details and a stale earlier snapshot', () => {
    const input = snapshot();
    for (const stdout of [
      'ordinary command output',
      JSON.stringify({ ...input, kind: 'another_result' }),
      JSON.stringify({ ...input, poses: { idle: { status: 'drawn' } } }),
      JSON.stringify({ ...input, steps: { ...input.steps, poses: { status: 'failed' } } }),
      `${JSON.stringify(input)}\nA later command message`,
    ]) expect(readHatchPetProgressFromToolResultV1({ stdout })).toBeNull();
  });
});
