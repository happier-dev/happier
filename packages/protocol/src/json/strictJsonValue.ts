import { z } from 'zod';

import {
  cloneStrictPluginJsonValue,
  measureSerializedStrictPluginJsonUtf8Bytes,
} from '../plugins/contributions/strictJsonValue.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from '../runtime/agentSessionLimitsV1.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function normalizeStrictJsonValue(input: unknown): JsonValue {
  const normalized = cloneStrictPluginJsonValue(input, 'value') as JsonValue;
  const maximumBytes = LIMITS.p0MeasuredCandidates.jsonValueMaxJsonBytes;
  if (measureSerializedStrictPluginJsonUtf8Bytes(
    normalized,
    'value',
    maximumBytes,
  ) > maximumBytes) {
    throw new Error('JSON aggregate byte limit exceeded');
  }
  return normalized;
}

export const StrictJsonValueSchema = z.unknown().transform((value, context): JsonValue => {
  try {
    return normalizeStrictJsonValue(value);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid strict JSON value',
    });
    return z.NEVER;
  }
});
