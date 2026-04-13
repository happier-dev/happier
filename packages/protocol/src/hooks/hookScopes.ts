import { z } from 'zod';

export const HOOK_SCOPE_V1_VALUES = ['machine', 'project', 'session', 'backend'] as const;

export const HookScopeV1Schema = z.enum(HOOK_SCOPE_V1_VALUES);
export type HookScopeV1 = z.infer<typeof HookScopeV1Schema>;
