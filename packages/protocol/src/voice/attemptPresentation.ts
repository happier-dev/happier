import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Host-classified failure identities; provider-native codes remain diagnostic input only. */
export const VoiceAttemptFailureKindSchema = lazyZodSchema(() => z.enum([
  'mic_permission_denied', 'mic_unavailable', 'speech_recognition_unavailable', 'mic_permission_revoked',
  'mic_ended', 'mic_plateau', 'transport_disconnect', 'provider_error', 'provider_auth_invalid',
  'provider_setup_required', 'execution_machine_unavailable', 'audio_context_suspended',
  'stt_timeout', 'tts_failed', 'turn_aborted', 'authentication_required', 'session_unavailable',
  'unsupported_runtime', 'update_required', 'feature_unavailable', 'service_temporarily_unavailable',
]));
export type VoiceAttemptFailureKind = z.infer<typeof VoiceAttemptFailureKindSchema>;

export const VoiceAttemptRecoveryActionSchema = lazyZodSchema(() => z.enum([
  'retry', 'reconnect', 'open_settings', 'open_settings_then_reconnect', 'review_credentials',
  'select_execution_machine', 'select_speech_engine', 'connect_agent', 'install_agent_runtime',
  'update_agent_runtime', 'none',
]));
export type VoiceAttemptRecoveryAction = z.infer<typeof VoiceAttemptRecoveryActionSchema>;

const IdSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
/** Read-only presentation. No provider error prose, prompt, transcript or credential state. */
export const VoiceAttemptPresentationSchema = lazyZodSchema(() => z.strictObject({
  attemptId: z.nullable(IdSchema),
  surfaceState: z.enum(['idle', 'connecting', 'listening', 'transcribing', 'thinking', 'speaking',
    'reconnecting', 'permission_required', 'error', 'interrupted']),
  live: z.boolean(), muted: z.boolean(),
  canStart: z.boolean(), canStop: z.boolean(), canMute: z.boolean(), canCommitInput: z.boolean(),
  canDismissFailedAttempt: z.boolean(), canDismissEnded: z.boolean(),
  failureKind: z.nullable(VoiceAttemptFailureKindSchema), failureMessage: z.nullable(z.string()),
  failureTitle: z.optional(z.string()),
  recovery: z.nullable(z.strictObject({
    action: z.nullable(VoiceAttemptRecoveryActionSchema), label: z.string(),
    icon: z.enum(['microphone', 'gear', 'arrow-clockwise']),
    runtimeTarget: z.nullable(z.strictObject({
      agentId: IdSchema, pluginId: IdSchema, machineId: IdSchema, serverIdentityId: IdSchema,
    })),
  })),
}));
export type VoiceAttemptPresentation = z.infer<typeof VoiceAttemptPresentationSchema>;
