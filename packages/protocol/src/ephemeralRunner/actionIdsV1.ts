import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const EPHEMERAL_RUNNER_ACTION_IDS_V1 = [
  'sessions.runner.activation.create',
  'sessions.runner.activation.get',
  'sessions.runner.activation.cancel',
] as const;
export type EphemeralRunnerActionIdV1 = typeof EPHEMERAL_RUNNER_ACTION_IDS_V1[number];
export const EphemeralRunnerActionIdV1Schema = lazyZodSchema(() => z.enum(EPHEMERAL_RUNNER_ACTION_IDS_V1));
