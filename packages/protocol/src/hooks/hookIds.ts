import { z } from 'zod';

export const HookIdV1Schema = z.string().trim().min(1);
export type HookIdV1 = z.infer<typeof HookIdV1Schema>;
