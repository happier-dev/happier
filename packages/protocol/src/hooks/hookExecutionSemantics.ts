import { z } from 'zod';
import { HookCategoryV1Schema, type HookCategoryV1 } from './hookCategories.js';

export const HOOK_EXECUTION_KIND_V1_VALUES = ['integrate', 'observe', 'augment', 'decide'] as const;

export const HookExecutionKindV1Schema = z.enum(HOOK_EXECUTION_KIND_V1_VALUES);
export type HookExecutionKindV1 = z.infer<typeof HookExecutionKindV1Schema>;

export const HOOK_CATEGORY_TO_EXECUTION_KIND_V1: Readonly<Record<HookCategoryV1, HookExecutionKindV1>> = {
  integration: 'integrate',
  lifecycle: 'observe',
  augmentation: 'augment',
  decision: 'decide',
};

export function resolveHookExecutionKindForCategoryV1(category: unknown): HookExecutionKindV1 | null {
  const parsedCategory = HookCategoryV1Schema.safeParse(category);
  if (!parsedCategory.success) {
    return null;
  }
  return HOOK_CATEGORY_TO_EXECUTION_KIND_V1[parsedCategory.data];
}

export function isHookExecutionKindCompatibleWithCategoryV1(params: Readonly<{
  category: unknown;
  executionKind: unknown;
}>): boolean {
  const parsedExecutionKind = HookExecutionKindV1Schema.safeParse(params.executionKind);
  if (!parsedExecutionKind.success) {
    return false;
  }
  const expectedExecutionKind = resolveHookExecutionKindForCategoryV1(params.category);
  return expectedExecutionKind === parsedExecutionKind.data;
}
