import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The one launch step the activation projection cannot already express.
 *
 * `connected`, `waiting_for_approval`, `installing_agent` and `creating_session`
 * are derived by the creator from `state`/`review`/`readiness`, so the endpoint
 * reports only the AI-access check, which happens strictly between consent and
 * readiness and changes no durable column.
 */
export const RunnerActivationProgressPhaseV1Schema = lazyZodSchema(() => z.enum(['checking_ai_access']));
export type RunnerActivationProgressPhaseV1 = z.infer<typeof RunnerActivationProgressPhaseV1Schema>;
