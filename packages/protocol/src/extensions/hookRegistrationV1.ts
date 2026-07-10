import { z } from 'zod';

import { HookCategoryV1Schema } from '../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
  isHookExecutionKindCompatibleWithCategoryV1,
  resolveHookExecutionKindForCategoryV1,
} from '../hooks/hookExecutionSemantics.js';
import { HookIdV1Schema } from '../hooks/hookIds.js';
import { HookScopeV1Schema } from '../hooks/hookScopes.js';

export const HookHandlerTargetsV1 = ['plugin'] as const;
export const HookHandlerTargetV1Schema = z.enum(HookHandlerTargetsV1);
export type HookHandlerTargetV1 = z.infer<typeof HookHandlerTargetV1Schema>;
export function isHookHandlerTargetV1(value: unknown): value is HookHandlerTargetV1 {
  return HookHandlerTargetV1Schema.safeParse(value).success;
}

export const HookRegistrationFilterV1Schema = z.object({
  agentId: z.string().trim().min(1).optional(),
  runtimeTargetId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  cwdPrefix: z.string().trim().min(1).optional(),
  machineId: z.string().trim().min(1).optional(),
  eventNames: z.array(z.string().trim().min(1)).optional(),
}).passthrough();
export type HookRegistrationFilterV1 = z.infer<typeof HookRegistrationFilterV1Schema>;

export const HookHandlerRefV1Schema = z.object({
  target: HookHandlerTargetV1Schema,
  exportName: z.string().trim().min(1).optional(),
}).passthrough();
export type HookHandlerRefV1 = z.infer<typeof HookHandlerRefV1Schema>;

const HookRegistrationV1RawSchema = z.object({
  hookApiVersion: z.literal(1).default(1),
  id: HookIdV1Schema,
  category: HookCategoryV1Schema,
  scope: HookScopeV1Schema,
  filters: HookRegistrationFilterV1Schema.optional(),
  executionKind: HookExecutionKindV1Schema,
  handler: HookHandlerRefV1Schema,
  priority: z.number().int().optional(),
  compatibility: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const HookRegistrationV1Schema = HookRegistrationV1RawSchema.superRefine((value, ctx) => {
  if (!isHookExecutionKindCompatibleWithCategoryV1({
    category: value.category,
    executionKind: value.executionKind,
  })) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executionKind'],
      message: 'Hook execution kind is incompatible with hook category',
    });
  }
});
export type HookRegistrationV1 = z.infer<typeof HookRegistrationV1Schema>;

const HookRegistrationV1CompatInputSchema = z.object({
  hookApiVersion: z.number().int().optional(),
  category: z.unknown().optional(),
  executionKind: z.unknown().optional(),
}).passthrough();

function normalizeHookRegistrationV1Input(value: unknown): unknown {
  const parsed = HookRegistrationV1CompatInputSchema.safeParse(value);
  if (!parsed.success) return value;

  const parsedValue = parsed.data;
  if (parsedValue.executionKind !== undefined) {
    return parsedValue;
  }

  const inferredExecutionKind = resolveHookExecutionKindForCategoryV1(parsedValue.category);
  if (!inferredExecutionKind) {
    return parsedValue;
  }

  return {
    ...parsedValue,
    executionKind: inferredExecutionKind,
  };
}

export function readHookRegistrationV1(value: unknown): HookRegistrationV1 | null {
  const normalized = normalizeHookRegistrationV1Input(value);
  const parsed = HookRegistrationV1Schema.safeParse(normalized);
  return parsed.success ? parsed.data : null;
}
