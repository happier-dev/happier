import { z } from 'zod/mini';
import { MachinePresenceTransitionsV1Schema } from './machinePresenceTransitionsV1.js';
export { MachinePresenceTransitionsV1Schema, MachinePresenceReadInputV1Schema,
  type MachinePresenceTransitionsV1 } from './machinePresenceTransitionsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { PrincipalRefV1Schema } from '../teams/principal.js';
import { ContentPublicKeyFingerprintSchema } from './identity/contentPublicKeyFingerprint.js';
import { MachineInstallationPublicIdentityV1Schema } from './identity/installationKeySchemas.js';
import { SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1, SessionDataKeyEnvelopeBytesV1Schema, SessionDataKeyRecipientContentKeyV1Schema, SessionDataKeyEnvelopePageQueryV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';

/** Machine access wire epoch V1: every authority/mutation object is closed. */
export const MachineAccessRoleV1Schema = lazyZodSchema(() => z.enum(['use', 'manage']));
export const MachineAccessLevelV1Schema = lazyZodSchema(() => z.enum(['view', 'admin']));
export const MachineAccessReadinessV1Schema = lazyZodSchema(() => z.enum(['ready', 'key_pending', 'refused']));
export const MachineOwnerEnvelopeFingerprintV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^machine-owner-envelope-sha256:[a-f0-9]{64}$/u)));
export const MachineTargetV1Schema = lazyZodSchema(() => z.strictObject({ serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)) }));
export const MachineAccessRefusalCodeV1Schema = lazyZodSchema(() => z.enum([
  'access_denied', 'machine_unavailable', 'recipient_encryption_incompatible', 'recipient_key_pending',
  'encryption_material_unavailable', 'recipient_binding_changed', 'machine_key_changed',
  'invalid_recipient_envelope', 'principal_not_found', 'principal_ineligible', 'custodian_protected',
  'data_key_not_required', 'unsupported_operation', 'custodian_only', 'daemon_upgrade_required',
]));
export type MachineAccessRoleV1 = z.infer<typeof MachineAccessRoleV1Schema>;
export type MachineAccessLevelV1 = z.infer<typeof MachineAccessLevelV1Schema>;
export type MachineTargetV1 = z.infer<typeof MachineTargetV1Schema>;
export type MachineAccessRefusalCode = z.infer<typeof MachineAccessRefusalCodeV1Schema>;
export type MachineAccessRefusalCodeV1 = MachineAccessRefusalCode;

export const MachineCustodianV1Schema = lazyZodSchema(() => z.strictObject({ accountId: z.string().check(z.minLength(1)), displayName: z.string() }));
export const AccessibleMachineAccessV1Schema = lazyZodSchema(() => z.strictObject({
  custodian: MachineCustodianV1Schema, role: MachineAccessRoleV1Schema,
  resourceMode: z.enum(['plain', 'e2ee']), accessState: MachineAccessReadinessV1Schema,
}));
export const AccessibleMachineAccessStoredReadV1Schema = createStoredReadSchema(AccessibleMachineAccessV1Schema);
export type AccessibleMachineAccessV1 = z.infer<typeof AccessibleMachineAccessV1Schema>;

export const MachineAccessGrantV1Schema = lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.minLength(1)), principal: PrincipalRefV1Schema, level: MachineAccessLevelV1Schema }));
export const MachineAccessGrantStoredReadV1Schema = createStoredReadSchema(MachineAccessGrantV1Schema);
export type MachineAccessGrantV1 = z.infer<typeof MachineAccessGrantV1Schema>;
export const MachineAccessGrantsListInputV1Schema = MachineTargetV1Schema;
export const MachineAccessGrantSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineTargetV1Schema, { principal: PrincipalRefV1Schema, level: MachineAccessLevelV1Schema })));
export const MachineAccessGrantRemoveInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineTargetV1Schema, { principal: PrincipalRefV1Schema })));
export const MachineAccessLeaveInputV1Schema = MachineTargetV1Schema;
export const MachineAccessPrepareKeysInputV1Schema = MachineTargetV1Schema;
/** Same encoded-envelope page resource boundary; never a total Machine audience cap. */
export const MachineRecipientKeyEnvelopePageQueryV1Schema = SessionDataKeyEnvelopePageQueryV1Schema;
export type MachineRecipientKeyEnvelopePageQueryV1 = z.infer<typeof MachineRecipientKeyEnvelopePageQueryV1Schema>;
export type MachineAccessGrantsListInputV1 = z.infer<typeof MachineAccessGrantsListInputV1Schema>;
export type MachineAccessGrantSetInputV1 = z.infer<typeof MachineAccessGrantSetInputV1Schema>;
export type MachineAccessGrantRemoveInputV1 = z.infer<typeof MachineAccessGrantRemoveInputV1Schema>;
export type MachineAccessLeaveInputV1 = MachineTargetV1;
export type MachineAccessPrepareKeysInputV1 = MachineTargetV1;

export const MachineAccessRefusalV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('refused'), code: MachineAccessRefusalCodeV1Schema }));
export type MachineAccessRefusalV1 = z.infer<typeof MachineAccessRefusalV1Schema>;
export const MachinePresenceReadResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('present'), machineId: z.string().check(z.minLength(1)),
    transitions: z.nullable(MachinePresenceTransitionsV1Schema) }),
  MachineAccessRefusalV1Schema,
]));
export const MachineAccessGrantRowV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineAccessGrantV1Schema, {
  display: z.strictObject({ name: z.nullable(z.string()) }),
  readiness: MachineAccessReadinessV1Schema,
  /** Current member facts; a Team's aggregate refusal does not refuse its eligible members. */
  audience: z.array(z.strictObject({ accountId: z.string().check(z.minLength(1)), displayName: z.string(),
    readiness: MachineAccessReadinessV1Schema, reason: z.nullable(MachineAccessRefusalCodeV1Schema),
    canPrepareKeys: z.boolean(),
  })),
  removal: z.strictObject({ losesAccessAccountIds: z.array(z.string().check(z.minLength(1))) }),
})));
export type MachineAccessGrantRowV1 = z.infer<typeof MachineAccessGrantRowV1Schema>;
export const MachineAccessGrantsListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)), custodian: MachineCustodianV1Schema, access: AccessibleMachineAccessV1Schema,
  canManage: z.boolean(), grants: z.array(MachineAccessGrantRowV1Schema), ownDirectGrant: z.boolean(),
  ownAccessSources: z.array(z.strictObject({ principal: PrincipalRefV1Schema, displayName: z.nullable(z.string()) })),
  /** Safe display only; absent for Use recipients and pre-extension responses. */
  currentRequesterDisplayIdentities: z.optional(z.array(MachineCustodianV1Schema)),
}));
export type MachineAccessGrantsListResponseV1 = z.infer<typeof MachineAccessGrantsListResponseV1Schema>;
export const MachineAccessGrantsListResultV1Schema = lazyZodSchema(() => z.union([MachineAccessGrantsListResponseV1Schema, MachineAccessRefusalV1Schema]));
export type MachineAccessGrantsListResultV1 = z.infer<typeof MachineAccessGrantsListResultV1Schema>;

export const MachineAccessMutationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), grant: MachineAccessGrantV1Schema, readiness: MachineAccessReadinessV1Schema,
    canPrepareKeys: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('removed'), effectiveAccess: z.enum(['none', 'use', 'manage']) }),
  z.strictObject({ kind: z.literal('left'), effectiveAccess: z.enum(['none', 'use', 'manage']) }),
  z.strictObject({ kind: z.literal('inherited_access_remains'), role: MachineAccessRoleV1Schema }),
  MachineAccessRefusalV1Schema,
]));
export type MachineAccessMutationResultV1 = z.infer<typeof MachineAccessMutationResultV1Schema>;
export const MachineKeyPreparationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared') }), z.strictObject({ kind: z.literal('pending_holder') }),
  z.strictObject({ kind: z.literal('recipient_incompatible') }),
  z.strictObject({ kind: z.literal('unavailable'), code: MachineAccessRefusalCodeV1Schema }),
]));
export type MachineKeyPreparationResultV1 = z.infer<typeof MachineKeyPreparationResultV1Schema>;

/** Internal result only; no public parser can mint an admission. */
export type MachineAdmission =
  | Readonly<{ kind: 'admitted'; actorAccountId: string; custodianAccountId: string; machineId: string; installationId: string; role: MachineAccessRoleV1; encryptionMode: 'plain' | 'e2ee' }>
  | Readonly<{ kind: 'denied'; code: MachineAccessRefusalCode }>;

export const MachineRecipientKeyEnvelopeInputV1Schema = lazyZodSchema(() => z.strictObject({
  recipientAccountId: z.string().check(z.minLength(1)), encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
  recipientContentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema,
}));
export type MachineRecipientKeyEnvelopeInputV1 = z.infer<typeof MachineRecipientKeyEnvelopeInputV1Schema>;
export const MachineRecipientKeyEnvelopeCommitInputV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)), expectedMachineOwnerEnvelopeFingerprint: MachineOwnerEnvelopeFingerprintV1Schema,
  expectedCallerDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
  expectedMetadataVersion: z.number().check(z.int(), z.nonnegative()), expectedDaemonStateVersion: z.number().check(z.int(), z.nonnegative()),
  recipientKeyEnvelopes: z.array(MachineRecipientKeyEnvelopeInputV1Schema).check(z.maxLength(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1), z.refine(items => new Set(items.map(item => item.recipientAccountId)).size === items.length, 'Duplicate recipientAccountId')),
}));
export type MachineRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof MachineRecipientKeyEnvelopeCommitInputV1Schema>;
export const MachineRecipientKeyEnvelopeCommitResponseV1Schema = lazyZodSchema(() => z.strictObject({ appliedRecipientAccountIds: z.array(z.string().check(z.minLength(1))), skippedRecipientAccountIds: z.array(z.string().check(z.minLength(1))) }));
export type MachineRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof MachineRecipientKeyEnvelopeCommitResponseV1Schema>;
export const MachineAccessRecipientCensusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.minLength(1)), custodianAccountId: z.string().check(z.minLength(1)), encryptionMode: z.enum(['plain', 'e2ee']),
  machineOwnerEnvelopeFingerprint: z.nullable(MachineOwnerEnvelopeFingerprintV1Schema),
  callerDataEncryptionKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
  nextCursor: z.nullable(SessionDataKeyEnvelopePageQueryV1Schema.shape.cursor._zod.def.innerType),
  content: z.strictObject({ metadata: z.string(), metadataVersion: z.number().check(z.int(), z.nonnegative()), daemonState: z.nullable(z.string()), daemonStateVersion: z.number().check(z.int(), z.nonnegative()) }),
  recipients: z.array(z.strictObject({ recipientAccountId: z.string().check(z.minLength(1)), contentKey: SessionDataKeyRecipientContentKeyV1Schema,
    contentPublicKeyFingerprint: z.nullable(ContentPublicKeyFingerprintSchema), encryptedDataKey: z.nullable(SessionDataKeyEnvelopeBytesV1Schema),
    recipientContentPublicKeyFingerprint: z.nullable(ContentPublicKeyFingerprintSchema),
  })),
}));
export type MachineAccessRecipientCensusResponseV1 = z.infer<typeof MachineAccessRecipientCensusResponseV1Schema>;

/** Home-stamped transport facts; the receiving installation still verifies current access with the Home. */
export const SocketRpcMachineAdmissionContextV1Schema = lazyZodSchema(() => z.strictObject({
  actorAccountId: z.string().check(z.minLength(1)),
  custodianAccountId: z.string().check(z.minLength(1)),
  machineId: z.string().check(z.minLength(1)),
  installationId: z.string().check(z.minLength(1)),
  role: MachineAccessRoleV1Schema,
  encryptionMode: z.enum(['plain', 'e2ee']),
}));
export type SocketRpcMachineAdmissionContextV1 = Readonly<z.infer<typeof SocketRpcMachineAdmissionContextV1Schema>>;

export const MachineAdmissionVerifyResponseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), ok: z.literal(true),
  destinationInstallation: z.optional(MachineInstallationPublicIdentityV1Schema),
  receivingMachineAdmission: z.optional(SocketRpcMachineAdmissionContextV1Schema),
}));

/** Internal Home-to-installation custody request; routing identities are transport-owned. */
export const MachineAccessLossCustodyRequestV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ v: z.literal(1), subjectAccountId: z.string().check(z.minLength(1)),
    /** Home's remaining Use authority withdraws only Machine-custody interactive access. */
    remainingRole: z.optional(z.literal('use')) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('requesters') }),
]));
export type MachineAccessLossCustodyRequestV1 = Readonly<z.infer<typeof MachineAccessLossCustodyRequestV1Schema>>;
export const MachineAccessLossCustodyResponseV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['settled', 'incomplete']),
}));
export type MachineAccessLossCustodyResponseV1 = Readonly<z.infer<typeof MachineAccessLossCustodyResponseV1Schema>>;
/** Private reconnect census; subjects are observations, never permission or cleanup authority. */
export const MachineAccessLossRequesterCensusResponseV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requesters'), accountIds: z.array(z.string().check(z.minLength(1))), coverage: z.enum(['complete', 'unknown']),
}));
export type MachineAccessLossRequesterCensusResponseV1 = Readonly<z.infer<typeof MachineAccessLossRequesterCensusResponseV1Schema>>;
