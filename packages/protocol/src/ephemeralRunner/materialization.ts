import { z } from '../zodRuntimePolicy.js';

import { RunnerResourceIdSchema, RunnerSha256CommitmentSchema } from './activation.js';
import { RunnerConsentV1Schema } from './consent.js';
import { RunnerReadinessV1Schema } from './readiness.js';
import { SessionOwnerMetadataEnvelopeV1Schema } from '../sessions/metadata/sessionMetadataSchemasV1.js';
import { SessionDisplayProjectionV1Schema } from '../sessions/metadata/sessionDisplaySchemasV1.js';
import { SessionOrganizationPlacementV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { SessionInitialAccessMaterializedV1Schema } from '../sessions/access/sessionInitialAccessDraftV1.js';
import { SessionTeamCredentialBindingIntentsV1Schema } from '../teams/credentials/sessionBindingIntentV1.js';
import { RunnerMachineContentKeyBindingV1Schema } from './machineContentKeyBindingSchema.js';
import {
  machineStoredContentMatchesAccountMode,
  isPlainMachineDataKeyMarker,
} from '../machines/machineStoredContent.js';

const BoundedStoredStringSchema = z.string().check(z.maxLength(4 * 1024 * 1024));

export const RunnerSessionMaterializationInputV1Schema = z.strictObject({
  tag: z.string().check(z.trim(), z.minLength(1), z.maxLength(191)),
  metadata: BoundedStoredStringSchema,
  ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
  displayProjectionV1: z.optional(z.nullable(SessionDisplayProjectionV1Schema)),
  agentState: z.nullable(BoundedStoredStringSchema),
  dataEncryptionKey: z.nullable(z.string().check(z.minLength(1), z.maxLength(4096))),
  requestedEncryptionMode: z.enum(['plain', 'e2ee']),
  requestedStorageState: z.optional(z.literal('machine_only')),
  organizationPlacement: z.optional(SessionOrganizationPlacementV1Schema),
  initialAccess: z.optional(SessionInitialAccessMaterializedV1Schema),
  primaryTeamId: z.optional(z.nullable(RunnerResourceIdSchema)),
  teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema),
});

export const RunnerMachineMaterializationInputV1Schema = z.strictObject({
  metadata: BoundedStoredStringSchema,
  dataEncryptionKey: z.string().check(z.minLength(1), z.maxLength(4096)),
  runnerContentKeyBinding: z.nullable(RunnerMachineContentKeyBindingV1Schema),
}).check(z.superRefine((value, context) => {
  const plain = isPlainMachineDataKeyMarker(value.dataEncryptionKey);
  if (plain !== (value.runnerContentKeyBinding === null)) {
    context.addIssue({ code: 'custom', path: ['runnerContentKeyBinding'], message: 'Runner Machine content mode and creator key binding must agree' });
  }
}));

export const RunnerMaterializationRequestV1Schema = z.strictObject({
  v: z.literal(1),
  activationId: z.string().check(z.uuid()),
  launchManifestCommitment: RunnerSha256CommitmentSchema,
  consent: RunnerConsentV1Schema,
  readiness: RunnerReadinessV1Schema,
  sealedBootstrap: z.string().check(z.minLength(1), z.maxLength(1024 * 1024)),
  session: RunnerSessionMaterializationInputV1Schema,
  machine: RunnerMachineMaterializationInputV1Schema,
  accessKeyData: BoundedStoredStringSchema,
}).check(z.superRefine((value, context) => {
  const machineIsPlain = isPlainMachineDataKeyMarker(value.machine.dataEncryptionKey);
  if (machineIsPlain !== (value.session.requestedEncryptionMode === 'plain')) {
    context.addIssue({ code: 'custom', path: ['machine', 'dataEncryptionKey'], message: 'Runner Session and Machine content modes must agree' });
  }
  if (!machineStoredContentMatchesAccountMode({
    mode: value.session.requestedEncryptionMode,
    metadata: value.machine.metadata,
    dataEncryptionKey: value.machine.dataEncryptionKey,
  })) {
    context.addIssue({ code: 'custom', path: ['machine', 'metadata'], message: 'Runner Machine stored content must match its Account mode' });
  }
  // A Runner bootstrap always mints a fresh Session key, so no legitimate Runner
  // producer can ask for E2EE without the creator's owner envelope. The shared
  // Session constructor still permits a keyless e2ee Session for released
  // owner-secret Sessions; the Runner request has no such mode and refuses here
  // rather than creating a transcript nobody can ever read.
  if (value.session.requestedEncryptionMode === 'e2ee' && value.session.dataEncryptionKey === null) {
    context.addIssue({ code: 'custom', path: ['session', 'dataEncryptionKey'], message: 'An E2EE Runner Session requires its creator owner envelope' });
  }
}));
export type RunnerMaterializationRequestV1 = z.infer<typeof RunnerMaterializationRequestV1Schema>;

export const RunnerMaterializationResultV1Schema = z.strictObject({
  v: z.literal(1),
  activationId: z.string().check(z.uuid()),
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
});
export type RunnerMaterializationResultV1 = z.infer<typeof RunnerMaterializationResultV1Schema>;

export const RunnerMaterializationResponseV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('materialized'), result: RunnerMaterializationResultV1Schema }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['activation_closed', 'activation_expired', 'creator_unavailable', 'consent_required', 'readiness_required']),
  }),
  z.strictObject({
    status: z.literal('conflict'),
    reason: z.enum([
      'binding_mismatch',
      'manifest_mismatch',
      'encryption_mismatch',
      'identity_taken',
      /**
       * The shared Session constructor refused the submitted request — an
       * organization placement, initial access or Team-credential binding that
       * is no longer valid. It is a typed refusal of the submission, not a
       * mismatch against the activation binding.
       */
      'session_create_rejected',
    ]),
  }),
]);
export type RunnerMaterializationResponseV1 = z.infer<typeof RunnerMaterializationResponseV1Schema>;
