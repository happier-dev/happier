import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { NonBlankOpaqueIdentifierSchema } from '../strings/opaqueIdentifier.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';

export function exactString(max: number) {
  return z.string().check(z.minLength(1), maxCodeUnits(max), z.refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace'));
}

export function opaqueNonBlankString(max: number) {
  return lazyZodSchema(() => NonBlankOpaqueIdentifierSchema.check(maxCodeUnits(max)));
}

export const HostIdSchema = lazyZodSchema(() => exactString(LIMITS.hostIndexedIdMaxCodeUnits));
/**
 * Identifiers the Agent mints — session, turn, tool-call, message, edit and
 * observation ids. Happier correlates and replays them, never re-canonicalizes
 * them, so they are validated for presence and carried byte for byte.
 */
export const ProviderIdSchema = lazyZodSchema(() => opaqueNonBlankString(LIMITS.providerIdMaxCodeUnits));
export const SafeIntegerSchema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(LIMITS.safeIntegerMax)));
