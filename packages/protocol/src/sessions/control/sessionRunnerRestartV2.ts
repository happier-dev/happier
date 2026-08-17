import { z } from 'zod';

import { SessionProviderBindingSecurityChangeConfirmationV1Schema } from '../../providers/sessions/bindingMetadataV1.js';
import { SessionRunnerProcessIdentityV2Schema } from './sessionRunnerRuntimeV2.js';

const SessionRunnerSessionIdV2Schema = z.string().trim().min(1);
const SessionRunnerIdentityV2Schema = z.string().trim().min(1);
const SessionRunnerPidV2Schema = z.number().int().positive();

/**
 * Additive, recovery-only restart contract. V1 remains the predecessor-exact
 * ordinary restart wire and must not gain these fields or reason values.
 */
export const RestartSessionRunnerRequestV2Schema = z
  .object({
    v: z.literal(2),
    sessionId: SessionRunnerSessionIdV2Schema,
    mode: z.literal('force_current_cli'),
    reason: z.literal('provider_binding_change_recovery'),
    expectedRunnerPid: SessionRunnerPidV2Schema,
    expectedProcessCommandHash: SessionRunnerIdentityV2Schema,
    expectedRunnerEntrypointIdentity: SessionRunnerIdentityV2Schema,
    expectedRunnerProcessIdentity: SessionRunnerProcessIdentityV2Schema,
    providerBindingSecurityChangeConfirmationV1:
      SessionProviderBindingSecurityChangeConfirmationV1Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedRunnerPid !== value.expectedRunnerProcessIdentity.pid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedRunnerProcessIdentity', 'pid'],
        message: 'Expected runner process identity must match the guarded runner PID',
      });
    }
    const confirmation = value.providerBindingSecurityChangeConfirmationV1;
    if (confirmation && confirmation.sessionId !== value.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerBindingSecurityChangeConfirmationV1', 'sessionId'],
        message: 'Provider binding confirmation must target the restarted session',
      });
    }
  });
export type RestartSessionRunnerRequestV2 = z.infer<typeof RestartSessionRunnerRequestV2Schema>;
