import { z } from 'zod';

export const SessionRuntimeModeV1Schema = z.enum(['external', 'terminal', 'remote']);
export type SessionRuntimeModeV1 = z.infer<typeof SessionRuntimeModeV1Schema>;

export const HappierManagedSessionRuntimeModeV1Schema = z.enum(['terminal', 'remote']);
export type HappierManagedSessionRuntimeModeV1 = z.infer<typeof HappierManagedSessionRuntimeModeV1Schema>;

export const RuntimeModeSwitchReasonV1Schema = z.enum([
  'user_request',
  'incoming_ui_message',
  'terminal_unavailable',
  'remote_takeover',
  'host_recovery',
]);
export type RuntimeModeSwitchReasonV1 = z.infer<typeof RuntimeModeSwitchReasonV1Schema>;

export const SessionRuntimeModeTransitionPolicyV1Schema = z.object({
  backendId: z.string().trim().min(1).optional(),
  transitions: z.object({
    'terminal->remote': z.object({ supported: z.boolean(), requiresHook: z.boolean() }).nullable(),
    'remote->terminal': z.object({ supported: z.boolean(), requiresHook: z.boolean() }).nullable(),
  }).passthrough().optional(),
  externalToTerminal: z.boolean().optional(),
  externalToRemote: z.boolean().optional(),
  terminalToRemote: z.boolean().optional(),
  remoteToTerminal: z.boolean().optional(),
}).passthrough();
export type SessionRuntimeModeTransitionPolicyV1 = z.infer<typeof SessionRuntimeModeTransitionPolicyV1Schema>;

export const RuntimeModeChangeDetailV1Schema = z.object({
  kind: z.literal('runtime-mode-change'),
  from: SessionRuntimeModeV1Schema,
  to: SessionRuntimeModeV1Schema,
  reason: RuntimeModeSwitchReasonV1Schema,
  resumeId: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type RuntimeModeChangeDetailV1 = z.infer<typeof RuntimeModeChangeDetailV1Schema>;

export const RuntimeStatusChangeDetailV1Schema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  if (value.kind !== 'runtime-mode-change') {
    return;
  }

  const parsed = RuntimeModeChangeDetailV1Schema.safeParse(value);
  if (parsed.success) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'runtime-mode-change detail must satisfy RuntimeModeChangeDetailV1',
  });
});
export type RuntimeStatusChangeDetailV1 = z.infer<typeof RuntimeStatusChangeDetailV1Schema>;
