import { z } from 'zod';

import {
  cloneStrictPluginJsonValue,
  measureSerializedValidatedStrictPluginJsonUtf8Bytes,
} from '../plugins/contributions/strictJsonValue.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from '../runtime/agentSessionLimitsV1.js';

/**
 * The one Protocol-owned strict JSON value: data that has already passed
 * `normalizeStrictJsonValue`, so it carries the prototype, accessor,
 * dense-array, well-formed-Unicode, and aggregate-byte guarantees that owner
 * enforces. It is immutable because it names a normalized result rather than
 * authoring input. Every other strict spelling in this repository is an alias
 * of this type (`ProtocolJsonValue`) or a declaration-neutral SDK projection
 * of it; the mutable pre-normalization vocabulary is `PluginJsonValueV2` in
 * `plugins/contributions/jsonSchema.ts`.
 */
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
  if (measureSerializedValidatedStrictPluginJsonUtf8Bytes(
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
