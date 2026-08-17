import { z } from 'zod';

import {
  StrictJsonValueSchema,
  type JsonValue,
} from '../json/strictJsonValue.js';

const AUTH_REFRESH_CODE_MAX = 256;
const AUTH_REFRESH_MESSAGE_MAX = 4_096;
const AUTH_REFRESH_NAME_MAX = 128;

export type AgentSessionAuthRefreshJsonObjectV1 = Readonly<{
  [key: string]: JsonValue;
}>;

function jsonObjectSchema(label: string): z.ZodType<AgentSessionAuthRefreshJsonObjectV1> {
  return StrictJsonValueSchema.refine(
    (value): value is AgentSessionAuthRefreshJsonObjectV1 => (
      value !== null && typeof value === 'object' && !Array.isArray(value)
    ),
    `${label} must be a bounded JSON object`,
  ) as z.ZodType<AgentSessionAuthRefreshJsonObjectV1>;
}

export const AgentSessionAuthRefreshSelectionV1Schema = jsonObjectSchema(
  'Runtime authentication selection',
);
export type AgentSessionAuthRefreshSelectionV1 = z.infer<
  typeof AgentSessionAuthRefreshSelectionV1Schema
>;

export const AgentSessionAuthRefreshClassificationV1Schema = jsonObjectSchema(
  'Runtime authentication classification',
);
export type AgentSessionAuthRefreshClassificationV1 = z.infer<
  typeof AgentSessionAuthRefreshClassificationV1Schema
>;

export const AgentSessionAuthRefreshPayloadV1Schema = StrictJsonValueSchema;
export type AgentSessionAuthRefreshPayloadV1 = JsonValue;

export const AgentSessionAuthRefreshRecoveryV1Schema = jsonObjectSchema(
  'Runtime authentication recovery',
);
export type AgentSessionAuthRefreshRecoveryV1 = z.infer<
  typeof AgentSessionAuthRefreshRecoveryV1Schema
>;

export const AgentSessionAuthRefreshErrorV1Schema = z.object({
  name: z.string().trim().min(1).max(AUTH_REFRESH_NAME_MAX).optional(),
  message: z.string().trim().min(1).max(AUTH_REFRESH_MESSAGE_MAX),
  code: z.string().trim().min(1).max(AUTH_REFRESH_CODE_MAX).optional(),
  details: StrictJsonValueSchema.optional(),
}).strict();
export type AgentSessionAuthRefreshErrorV1 = z.infer<
  typeof AgentSessionAuthRefreshErrorV1Schema
>;

export function normalizeAgentSessionAuthRefreshErrorV1(
  error: unknown,
): AgentSessionAuthRefreshErrorV1 {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string'
      ? error.code.trim().slice(0, AUTH_REFRESH_CODE_MAX)
      : '';
    return AgentSessionAuthRefreshErrorV1Schema.parse({
      ...(error.name.trim() ? { name: error.name.slice(0, AUTH_REFRESH_NAME_MAX) } : {}),
      message: (error.message.trim() || 'Runtime authentication refresh failed')
        .slice(0, AUTH_REFRESH_MESSAGE_MAX),
      ...(code ? { code } : {}),
    });
  }
  if (typeof error === 'string' && error.trim()) {
    return { message: error.trim().slice(0, AUTH_REFRESH_MESSAGE_MAX) };
  }
  return { message: 'Runtime authentication refresh failed' };
}

export const ProviderTranscriptDispatchRequestV1Schema = z.object({
  body: StrictJsonValueSchema,
  meta: z.record(z.string(), StrictJsonValueSchema).optional(),
}).strict();
export type ProviderTranscriptDispatchRequestV1 = z.infer<
  typeof ProviderTranscriptDispatchRequestV1Schema
>;
