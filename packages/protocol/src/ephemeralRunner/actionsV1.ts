import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { RunnerActivationCreateRequestV1Schema } from './activation.js';
import { RunnerActivationProjectionV1Schema } from './projection.js';
import { EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1 } from './routes.js';
import { EPHEMERAL_RUNNER_ACTION_IDS_V1, type EphemeralRunnerActionIdV1 } from './actionIdsV1.js';
export { EPHEMERAL_RUNNER_ACTION_IDS_V1, EphemeralRunnerActionIdV1Schema, type EphemeralRunnerActionIdV1 } from './actionIdsV1.js';

const ActivationIdentityInputV1Schema = lazyZodSchema(() => z.object({ activationId: z.string().uuid() }).strict());
export const EphemeralRunnerActionInputSchemasV1 = {
  'sessions.runner.activation.create': RunnerActivationCreateRequestV1Schema,
  'sessions.runner.activation.get': ActivationIdentityInputV1Schema,
  'sessions.runner.activation.cancel': ActivationIdentityInputV1Schema,
} as const satisfies Readonly<Record<EphemeralRunnerActionIdV1, z.ZodTypeAny>>;

export const EphemeralRunnerActivationCancelResultV1Schema = lazyZodSchema(() => z.object({
  activationId: z.string().uuid(),
  closed: z.literal(true),
}).strict());
export const EphemeralRunnerActionOutputSchemasV1 = {
  'sessions.runner.activation.create': RunnerActivationProjectionV1Schema,
  'sessions.runner.activation.get': RunnerActivationProjectionV1Schema,
  'sessions.runner.activation.cancel': EphemeralRunnerActivationCancelResultV1Schema,
} as const satisfies Readonly<Record<EphemeralRunnerActionIdV1, z.ZodTypeAny>>;

/**
 * The exact registered creator routes for the three activation intents, derived
 * from the canonical Runner route owner. `get` and `cancel` address one member
 * of the activations collection, so they carry the same `:activationId` segment
 * the Home registers; the bound domain adapter substitutes the real id.
 */
export const EPHEMERAL_RUNNER_ACTION_TRANSPORTS_V1: Readonly<Record<
  EphemeralRunnerActionIdV1,
  Readonly<{ method: 'POST' | 'GET' | 'DELETE'; path: string }>
>> = {
  'sessions.runner.activation.create': { method: 'POST', path: EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1 },
  'sessions.runner.activation.get': { method: 'GET', path: `${EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1}/:activationId` },
  'sessions.runner.activation.cancel': { method: 'DELETE', path: `${EPHEMERAL_RUNNER_ACTIVATIONS_PATH_V1}/:activationId` },
};
