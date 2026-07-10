import { z } from 'zod';

import { HookCategoryV1Schema } from '../hooks/hookCategories.js';
import { HookIdV1Schema } from '../hooks/hookIds.js';
import { HookScopeV1Schema } from '../hooks/hookScopes.js';

export const HookEventEnvelopeV1Schema = z.object({
  hookVersion: z.literal(1).default(1),
  eventId: HookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: HookScopeV1Schema,
  happySessionId: z.string().trim().min(1).optional(),
  agentSessionId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  backendTarget: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  turnId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  timestampMs: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
export type HookEventEnvelopeV1 = z.infer<typeof HookEventEnvelopeV1Schema>;

const HookEventEnvelopeV1CompatInputSchema = z.object({
  hookVersion: z.number().int().optional(),
  eventId: z.unknown().optional(),
  hookEventId: z.unknown().optional(),
}).passthrough();

function normalizeHookEventEnvelopeV1Input(value: unknown): unknown {
  const parsed = HookEventEnvelopeV1CompatInputSchema.safeParse(value);
  if (!parsed.success) return value;

  const parsedValue = parsed.data;
  const record = parsedValue as Record<string, unknown>;
  const canonicalEventId = typeof parsedValue.eventId === 'string' ? parsedValue.eventId.trim() : '';
  const legacyEventId = typeof parsedValue.hookEventId === 'string' ? parsedValue.hookEventId.trim() : '';
  const agentSessionId = typeof record.agentSessionId === 'string' ? record.agentSessionId.trim() : '';
  const legacyVendorSessionId = typeof record.vendorSessionId === 'string' ? record.vendorSessionId.trim() : ''; // legacy vendorSessionId read-compat
  const normalizedAgentSessionFields = record.vendorSessionId !== undefined // legacy vendorSessionId read-compat
    ? (() => {
        const { vendorSessionId: _legacyVendorSessionId, ...rest } = record; // legacy vendorSessionId read-compat
        if (agentSessionId || !legacyVendorSessionId) {
          return rest;
        }
        return {
          ...rest,
          agentSessionId: legacyVendorSessionId, // legacy vendorSessionId read-compat
        };
      })()
    : record;

  if (canonicalEventId.length > 0 && legacyEventId.length > 0 && canonicalEventId !== legacyEventId) {
    return null;
  }

  if (canonicalEventId.length > 0) {
    return normalizedAgentSessionFields === record ? parsedValue : normalizedAgentSessionFields;
  }

  if (legacyEventId.length > 0) {
    const { hookEventId: _hookEventId, ...rest } = normalizedAgentSessionFields;
    return {
      ...rest,
      eventId: legacyEventId,
    };
  }

  return normalizedAgentSessionFields === record ? parsedValue : normalizedAgentSessionFields;
}

export function readHookEventEnvelopeV1(value: unknown): HookEventEnvelopeV1 | null {
  const normalized = normalizeHookEventEnvelopeV1Input(value);
  const parsed = HookEventEnvelopeV1Schema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}
