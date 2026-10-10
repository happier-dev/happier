import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  compilePluginJsonSchema,
  describePluginJsonSchemaValueIssues,
  isValidPluginJsonSchemaValue,
  normalizePluginJsonSchema,
  type PluginJsonSchemaValueIssue,
} from '../../plugins/actions/jsonSchemaValidation.js';
import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import type { PluginJsonSchemaV2 } from '../../plugins/contributions/jsonSchema.js';
import type { ExecutionRunResultContractV1 } from './resultContractV1.js';

const DecisionResultSchema = lazyZodSchema(() => z.union([
  z.string(),
  z.object({ decision: z.string(), reason: z.string().optional() }).strict(),
]));

export type ExecutionRunProfileResultContract =
  | ExecutionRunResultContractV1
  | Readonly<{ kind: 'json'; schema: PluginJsonSchemaV2 }>;

export function normalizeExecutionRunProfileResultContract(
  contract: ExecutionRunProfileResultContract | undefined,
): ExecutionRunProfileResultContract | undefined {
  if (!contract) return undefined;
  if (contract.kind !== 'json') return contract;
  return { kind: 'json', schema: normalizePluginJsonSchema(contract.schema) };
}

export function buildExecutionRunResultContractPrompt(
  contract: ExecutionRunProfileResultContract | undefined,
): string | null {
  if (!contract || contract.kind === 'text') return null;
  if (contract.kind === 'decision') {
    return [
      'Return only one strict JSON string, or a strict JSON object with required "decision" and optional string "reason" (no other fields). The decision must be one of these required values:',
      JSON.stringify(contract.decisions),
    ].join('\n');
  }
  return [
    'Return only one strict JSON value that satisfies this required result schema:',
    JSON.stringify(contract.schema),
  ].join('\n');
}

export type ExecutionRunResultDecodeResult =
  | Readonly<{ ok: true; value: JsonValue | string }>
  | Readonly<{
      ok: false;
      reason: 'not_text' | 'not_json' | 'not_strict_json' | 'decision_not_permitted' | 'schema_mismatch' | 'schema_unavailable';
      issues?: readonly PluginJsonSchemaValueIssue[];
    }>;

export type ExecutionRunResultObservation =
  | Readonly<{ encoding: 'raw_text'; value: string }>
  | Readonly<{ encoding: 'typed'; value: JsonValue }>;

/** Interprets exact text once, or validates a value already decoded by its execution owner. */
export function decodeExecutionRunResultObservation(
  observation: ExecutionRunResultObservation,
  contract: ExecutionRunProfileResultContract | undefined,
): ExecutionRunResultDecodeResult {
  return observation.encoding === 'raw_text'
    ? decodeExecutionRunProfileResult(observation.value, contract)
    : validateExecutionRunProfileResult(observation.value, contract);
}

/** Validates a result that the canonical Execution Run owner already decoded. */
export function validateExecutionRunProfileResult(
  value: JsonValue | string,
  contract: ExecutionRunProfileResultContract | undefined,
): ExecutionRunResultDecodeResult {
  if (!contract || contract.kind === 'text') {
    return typeof value === 'string' ? { ok: true, value } : { ok: false, reason: 'not_text' };
  }
  const strictJson = StrictJsonValueSchema.safeParse(value);
  if (!strictJson.success) return { ok: false, reason: 'not_strict_json' };
  if (contract.kind === 'decision') {
    const decision = DecisionResultSchema.safeParse(strictJson.data);
    return decision.success && contract.decisions.includes(typeof decision.data === 'string' ? decision.data : decision.data.decision)
      ? { ok: true, value: strictJson.data }
      : { ok: false, reason: 'decision_not_permitted' };
  }
  try {
    const validates = compilePluginJsonSchema(contract.schema);
    return isValidPluginJsonSchemaValue(validates, strictJson.data)
      ? { ok: true, value: strictJson.data }
      : { ok: false, reason: 'schema_mismatch', issues: describePluginJsonSchemaValueIssues(validates) };
  } catch {
    return { ok: false, reason: 'schema_unavailable' };
  }
}

export function decodeExecutionRunProfileResult(
  rawText: string,
  contract: ExecutionRunProfileResultContract | undefined,
): ExecutionRunResultDecodeResult {
  if (!contract || contract.kind === 'text') return { ok: true, value: rawText };
  const exactText = rawText.trim();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(exactText);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const strictJson = StrictJsonValueSchema.safeParse(parsedJson);
  if (!strictJson.success) return { ok: false, reason: 'not_strict_json' };
  return validateExecutionRunProfileResult(strictJson.data, contract);
}
