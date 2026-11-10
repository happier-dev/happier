import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const SessionRuntimeModeV1Schema = lazyZodSchema(() => z.enum(['external', 'terminal', 'remote']));
export type SessionRuntimeModeV1 = z.infer<typeof SessionRuntimeModeV1Schema>;

export const HappierManagedSessionRuntimeModeV1Schema = lazyZodSchema(() => z.enum(['terminal', 'remote']));
export type HappierManagedSessionRuntimeModeV1 = z.infer<typeof HappierManagedSessionRuntimeModeV1Schema>;

export const RuntimeModeSwitchReasonV1Schema = lazyZodSchema(() => z.enum([
  'user_request',
  'incoming_ui_message',
  'terminal_unavailable',
  'remote_takeover',
  'host_recovery',
]));
export type RuntimeModeSwitchReasonV1 = z.infer<typeof RuntimeModeSwitchReasonV1Schema>;

export const SessionRuntimeModeTransitionPolicyV1Schema = lazyZodSchema(() => z.looseObject({
  backendId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  transitions: z.optional(z.looseObject({
    'terminal->remote': z.nullable(z.object({ supported: z.boolean(), requiresHook: z.boolean() })),
    'remote->terminal': z.nullable(z.object({ supported: z.boolean(), requiresHook: z.boolean() })),
  })),
  externalToTerminal: z.optional(z.boolean()),
  externalToRemote: z.optional(z.boolean()),
  terminalToRemote: z.optional(z.boolean()),
  remoteToTerminal: z.optional(z.boolean()),
}));
export type SessionRuntimeModeTransitionPolicyV1 = z.infer<typeof SessionRuntimeModeTransitionPolicyV1Schema>;

export const RuntimeModeChangeDetailV1Schema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('runtime-mode-change'),
  from: SessionRuntimeModeV1Schema,
  to: SessionRuntimeModeV1Schema,
  reason: RuntimeModeSwitchReasonV1Schema,
  resumeId: z.optional(z.nullable(z.string())),
  metadata: z.optional(z.record(z.string(), z.unknown())),
}));
export type RuntimeModeChangeDetailV1 = z.infer<typeof RuntimeModeChangeDetailV1Schema>;

export const RuntimeStatusChangeDetailV1Schema = lazyZodSchema(() => z.record(z.string(), z.unknown()).check(z.superRefine((value, ctx) => {
  if (value.kind !== 'runtime-mode-change') {
    return;
  }

  const parsed = RuntimeModeChangeDetailV1Schema.safeParse(value);
  if (parsed.success) {
    return;
  }

  ctx.addIssue({
    code: "custom",
    message: 'runtime-mode-change detail must satisfy RuntimeModeChangeDetailV1',
  });
})));
export type RuntimeStatusChangeDetailV1 = z.infer<typeof RuntimeStatusChangeDetailV1Schema>;
