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
  providerSessionId: z.string().trim().min(1).optional(),
  providerId: z.string().trim().min(1).optional(),
  backendId: z.string().trim().min(1).optional(),
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
  const providerSessionId = typeof record.providerSessionId === 'string' ? record.providerSessionId.trim() : '';
  const legacyVendorSessionId = typeof record.vendorSessionId === 'string' ? record.vendorSessionId.trim() : '';
  const normalizedProviderSessionFields = record.vendorSessionId !== undefined
    ? (() => {
        const { vendorSessionId: _legacyVendorSessionId, ...rest } = record;
        if (providerSessionId || !legacyVendorSessionId) {
          return rest;
        }
        return {
          ...rest,
          providerSessionId: legacyVendorSessionId, // legacy vendorSessionId read-compat
        };
      })()
    : record;

  if (canonicalEventId.length > 0 && legacyEventId.length > 0 && canonicalEventId !== legacyEventId) {
    return null;
  }

  if (canonicalEventId.length > 0) {
    return normalizedProviderSessionFields === record ? parsedValue : normalizedProviderSessionFields;
  }

  if (legacyEventId.length > 0) {
    const { hookEventId: _hookEventId, ...rest } = normalizedProviderSessionFields;
    return {
      ...rest,
      eventId: legacyEventId,
    };
  }

  return normalizedProviderSessionFields === record ? parsedValue : normalizedProviderSessionFields;
}

export function readHookEventEnvelopeV1(value: unknown): HookEventEnvelopeV1 | null {
  const normalized = normalizeHookEventEnvelopeV1Input(value);
  const parsed = HookEventEnvelopeV1Schema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}
