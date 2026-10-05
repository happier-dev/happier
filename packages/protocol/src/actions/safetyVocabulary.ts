import { z } from 'zod';

/** Authoring schemas consume the vocabulary without initializing host Action policy. */
export const ActionSafetySchema = z.enum(['safe', 'danger']);
export type ActionSafety = z.infer<typeof ActionSafetySchema>;
