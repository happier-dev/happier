import { z } from 'zod';

/**
 * Bounded result for the passive Codex Voice setup probe. It intentionally
 * contains no provider account, app-server, or credential material.
 */
export const CodexPassiveRealtimeSetupStatusV1Schema = z.enum([
  'ready',
  'runtime_incompatible',
  'authentication_required',
  'feature_disabled',
  'unavailable',
]);
export type CodexPassiveRealtimeSetupStatusV1 = z.infer<
  typeof CodexPassiveRealtimeSetupStatusV1Schema
>;

export const CodexPassiveRealtimeSetupResultV1Schema = z.object({
  v: z.literal(1),
  status: CodexPassiveRealtimeSetupStatusV1Schema,
}).strict();
export type CodexPassiveRealtimeSetupResultV1 = z.infer<
  typeof CodexPassiveRealtimeSetupResultV1Schema
>;
