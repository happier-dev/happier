import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
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
  lazyZodSchema(() => SessionMetadataOwnerPatchV1Schema.omit({ publisherPrecondition: true, activitySummaryV1: true }).extend({
    mode: z.literal('owner_team_credential_binding'),
    operation: SessionTeamCredentialBindingMutationOperationV1Schema,
    teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.min(1),
    /** Explicit UI consent to grant this Team the approved Edit/no-delegation Session access. */
    teamVisibilityGrantConsent: z.object({ teamId: z.string().min(1) }).strict().optional(),
    sessionExpectation: SessionMetadataInactiveModelIntentExpectationV1Schema.optional(),
  }).superRefine((value, context) => {
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
  }));
export type SessionTeamCredentialBindingMetadataPatchV1 = z.infer<
  typeof SessionTeamCredentialBindingMetadataPatchV1Schema
>;

export const SessionTeamCredentialBindingRejectionV1Schema = lazyZodSchema(() => z.enum([
  'invalid_input',
  'feature_disabled',
  'session_missing',
  'session_owner_mismatch',
  'resource_missing',
  'resource_changed',
  'access_removed',
  'disabled',
  'resource_corrupt',
  'source_owner_required',
  'source_replaced_or_missing',
  'team_context_required',
  'team_visibility_required',
  'broker_unavailable',
  'update_required',
  'authentication_required',
  'authentication_unavailable',
]));
export type SessionTeamCredentialBindingRejectionV1 = z.infer<
  typeof SessionTeamCredentialBindingRejectionV1Schema
>;

export const SessionTeamCredentialBindingMutationRejectionV1Schema = lazyZodSchema(() => z.object({
  code: z.literal('session_team_credential_binding_rejected'),
  reason: SessionTeamCredentialBindingRejectionV1Schema,
}).strict());
