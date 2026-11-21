import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { SessionMetadataOwnerPatchV1Schema } from '../../sessions/metadata/sessionMetadataSchemasV1.js';
import { SessionMetadataInactiveModelIntentExpectationV1Schema } from '../../sessions/metadata/sessionMetadataSchemasV1.js';
import {
  SessionTeamCredentialBindingIntentsV1Schema,
} from './sessionBindingIntentV1.js';

export * from './sessionBindingIntentV1.js';

export const SessionTeamCredentialBindingMutationOperationV1Schema = lazyZodSchema(() => z.enum([
  'session.model.set',
  'session.connected_service.switch',
]));
export type SessionTeamCredentialBindingMutationOperationV1 = z.infer<
  typeof SessionTeamCredentialBindingMutationOperationV1Schema
>;

/**
 * Existing-Session selection commit. The owner metadata tuple and its
 * server-readable witness are one mutation; this is deliberately not a
 * witness-only operation.
 */
export const SessionTeamCredentialBindingMetadataPatchV1Schema =
  lazyZodSchema(() => z.extend(z.omit(SessionMetadataOwnerPatchV1Schema, { projectKey: true, activitySummaryV1: true, sharedActionConfirmationSummaryV1: true }), {
    mode: z.literal('owner_team_credential_binding'),
    operation: SessionTeamCredentialBindingMutationOperationV1Schema,
    teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.check(z.minLength(1)),
    /** Explicit UI consent to grant this Team the approved Edit/no-delegation Session access. */
    teamVisibilityGrantConsent: z.optional(z.strictObject({ teamId: z.string().check(z.minLength(1)) })),
    sessionExpectation: z.optional(SessionMetadataInactiveModelIntentExpectationV1Schema),
  }).check(z.superRefine((value, context) => {
    if (value.publisherPrecondition && value.sessionExpectation) {
      context.addIssue({ code: 'custom', path: ['publisherPrecondition'],
        message: 'Current publisher and inactive Session conditions are mutually exclusive.' });
    }
    const expectedOperation = value.teamCredentialBindings[0]?.slot.kind === 'provider_model'
      ? 'session.model.set'
      : 'session.connected_service.switch';
    if (value.operation !== expectedOperation) {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Operation does not match the selected Session credential slot.',
      });
    }
    if (value.teamCredentialBindings.some((binding) => (
      binding.slot.kind === 'provider_model'
        ? 'session.model.set'
        : 'session.connected_service.switch'
    ) !== expectedOperation)) {
      context.addIssue({
        code: 'custom',
        path: ['teamCredentialBindings'],
        message: 'One metadata mutation may update only one Session credential slot family.',
      });
    }
    if (value.sessionExpectation && value.operation !== 'session.model.set') {
      context.addIssue({
        code: 'custom',
        path: ['sessionExpectation'],
        message: 'Inactive model currentness applies only to Session model selection.',
      });
    }
  })));
export type SessionTeamCredentialBindingMetadataPatchV1 = z.infer<
  typeof SessionTeamCredentialBindingMetadataPatchV1Schema
>;

export * from './sessionBindingRejectionV1.js';
