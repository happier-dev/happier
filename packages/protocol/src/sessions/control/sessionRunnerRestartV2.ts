import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { readSessionRunnerRestartIdentityGuardV1, RestartSessionRunnerRequestV1Schema, SessionRunnerRestartModeV1Schema, type RestartSessionRunnerResultV1 } from './sessionRunnerRestartV1.js';

import { SessionProviderBindingSecurityChangeConfirmationV1Schema, type SessionProviderBindingSecurityChangeConfirmationV1 } from '../../providers/sessions/bindingMetadataV1.js';
import { SessionRunnerProcessIdentityV2Schema, type SessionRunnerProcessIdentityV2 } from './sessionRunnerRuntimeV2.js';
import type { SessionRunnerRuntimeStateV1 } from './sessionRunnerRuntimeV1.js';

const SessionRunnerSessionIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerIdentityV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerPidV2Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));

/**
 * Additive, recovery-only restart contract. V1 remains the predecessor-exact
 * ordinary restart wire and must not gain these fields or reason values.
 */
export const RestartSessionRunnerRequestV2Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(2),
    sessionId: SessionRunnerSessionIdV2Schema,
    mode: z.literal('force_current_cli'),
    reason: z.literal('provider_binding_change_recovery'),
    expectedRunnerPid: SessionRunnerPidV2Schema,
    expectedProcessCommandHash: SessionRunnerIdentityV2Schema,
    expectedRunnerEntrypointIdentity: SessionRunnerIdentityV2Schema,
    expectedRunnerProcessIdentity: SessionRunnerProcessIdentityV2Schema,
    providerBindingSecurityChangeConfirmationV1:
      z.optional(SessionProviderBindingSecurityChangeConfirmationV1Schema),
  }).check(z.superRefine((value, ctx) => {
    if (value.expectedRunnerPid !== value.expectedRunnerProcessIdentity.pid) {
      ctx.addIssue({
        code: "custom",
        path: ['expectedRunnerProcessIdentity', 'pid'],
        message: 'Expected runner process identity must match the guarded runner PID',
      });
    }
    const confirmation = value.providerBindingSecurityChangeConfirmationV1;
    if (confirmation && confirmation.sessionId !== value.sessionId) {
      ctx.addIssue({
        code: "custom",
        path: ['providerBindingSecurityChangeConfirmationV1', 'sessionId'],
        message: 'Provider binding confirmation must target the restarted session',
      });
    }
  })));
export type RestartSessionRunnerRequestV2 = z.infer<typeof RestartSessionRunnerRequestV2Schema>;

/** The public Action keeps ordinary stale refresh as its default operation. */
export const SessionRunnerRuntimeRefreshActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionRunnerSessionIdV2Schema,
  machineId: SessionRunnerIdentityV2Schema,
  serverId: z.optional(SessionRunnerIdentityV2Schema),
  mode: z.optional(SessionRunnerRestartModeV1Schema),
  providerBindingSecurityChangeConfirmationV1: z.optional(SessionProviderBindingSecurityChangeConfirmationV1Schema),
}).check(z.superRefine((value, ctx) => {
  const confirmation = value.providerBindingSecurityChangeConfirmationV1;
  if (confirmation && (value.mode !== 'force_current_cli' || confirmation.sessionId !== value.sessionId)) {
    ctx.addIssue({ code: 'custom', path: ['providerBindingSecurityChangeConfirmationV1'],
      message: 'Binding confirmation requires a forced restart of the same Session' });
  }
})));
export type SessionRunnerRuntimeRefreshActionInputV1 = z.infer<typeof SessionRunnerRuntimeRefreshActionInputV1Schema>;

/** Both Action hosts use the same exact-process recovery request. Binding continuity stays at spawn admission. */
export function buildSessionRunnerProviderBindingRestartRequestV2(input: Readonly<{
  runtimeState: SessionRunnerRuntimeStateV1;
  runnerProcessIdentity: SessionRunnerProcessIdentityV2 | null;
  providerBindingSecurityChangeConfirmationV1?: SessionProviderBindingSecurityChangeConfirmationV1;
}>): RestartSessionRunnerRequestV2 | RestartSessionRunnerResultV1 {
  const guard = readSessionRunnerRestartIdentityGuardV1(input.runtimeState);
  if ('ok' in guard) return guard;
  if (!input.runnerProcessIdentity) return { ok: false, sessionId: input.runtimeState.sessionId,
    status: 'version_unknown', reasonCode: 'runner_generation_unattested' };
  if (guard.expectedRunnerPid !== input.runnerProcessIdentity.pid) {
    return { ok: false, sessionId: input.runtimeState.sessionId, status: 'runner_identity_changed' };
  }
  return RestartSessionRunnerRequestV2Schema.parse({ v: 2, sessionId: input.runtimeState.sessionId,
    mode: 'force_current_cli', reason: 'provider_binding_change_recovery', ...guard,
    expectedRunnerProcessIdentity: input.runnerProcessIdentity,
    ...(input.providerBindingSecurityChangeConfirmationV1
      ? { providerBindingSecurityChangeConfirmationV1: input.providerBindingSecurityChangeConfirmationV1 } : {}),
  });
}

/** Explicit consent changes the operation, while both predecessor request shapes remain unchanged. */
export const RestartSessionRunnerConfirmedBackgroundRequestSchema = lazyZodSchema(() => z.union([
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerRequestV2Schema,
]));
export type RestartSessionRunnerConfirmedBackgroundRequest = z.infer<typeof RestartSessionRunnerConfirmedBackgroundRequestSchema>;
