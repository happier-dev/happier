import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';

import {
  computeCanonicalDomainSeparatedDigest,
} from '../../crypto/canonicalDigest.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import {
  BOX_BUNDLE_MIN_BYTES,
  openBoxBundle,
  sealBoxBundle,
} from '../../crypto/boxBundle.js';
import {
  QualifiedConnectedAccountCredentialPayloadV1Schema,
  type QualifiedConnectedAccountCredentialPayloadV1,
} from '../../connect/qualifiedConnectedAccountContentEnvelope.js';
import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { ProviderConnectionIdSchema, ProviderLocalIdSchema } from '../../providers/ids.js';
import { ProviderCredentialTransportV1Schema } from '../../providers/credentials/v1.js';
import { ProviderEndpointUrlSyntaxSchema } from '../../providers/endpointUrlSchema.js';
import { ProviderWireProtocolSchema } from '../../providers/capabilities/v1.js';
import { ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES } from '../../account/settings/catalog/accountSettingBounds.js';
import { TeamCredentialSourceBindingV1Schema } from './sourceBindingV1.js';
import { TeamCredentialDirectMaterialIdentityV1Schema } from './directMaterialCensusV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountRefSchema } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '../../connect/pluginConnectedAccountAuthenticationV2.js';
import { MachineInstallationProofV1Schema } from '../../machines/identity/installationIdentity.js';
import { SessionTeamCredentialNativeDeliveryV1Schema } from './sessionBindingIntentV1.js';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from './resourceV1.js';
import { DaemonProviderNativeSourceV1Schema } from '../../rpc/providers.js';
export {
  TeamCredentialDirectMaterialReconcileInputV1Schema,
  TeamCredentialDirectMaterialReconcileOutputV1Schema,
} from './directMaterialReconcileV1.js';
export type {
  TeamCredentialDirectMaterialReconcileInputV1,
  TeamCredentialDirectMaterialReconcileOutputV1,
} from './directMaterialReconcileV1.js';
export {
  TeamCredentialDirectMaterialCensusInputV1Schema,
  TeamCredentialDirectMaterialCensusOutputV1Schema,
} from './directMaterialCensusV1.js';
export type {
  TeamCredentialDirectMaterialCensusInputV1,
  TeamCredentialDirectMaterialCensusOutputV1,
} from './directMaterialCensusV1.js';

const BoundedIdentitySchema = TeamCredentialDirectMaterialIdentityV1Schema;

/** Installed-guest-only arm of the existing private binding read transport.
 * This carries a client placeholder, never the controller's source ticket. */
export const TeamCredentialNativeBindingReadBodyV1Schema = lazyZodSchema(() => z.strictObject({
  purpose: z.literal('vendor_native_binding'),
  homeId: BoundedIdentitySchema, teamId: BoundedIdentitySchema, resourceId: BoundedIdentitySchema,
  sessionId: BoundedIdentitySchema, managedId: BoundedIdentitySchema, bindingKey: BoundedIdentitySchema,
  expectedResourceRevision: z.int().check(z.gte(0)),
  expectedSourceRevision: BoundedIdentitySchema, expectedProviderTicket: BoundedIdentitySchema,
  machineId: BoundedIdentitySchema, installationId: BoundedIdentitySchema,
}));
export const TeamCredentialNativeBindingReadRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...TeamCredentialNativeBindingReadBodyV1Schema.shape, proof: MachineInstallationProofV1Schema,
}));
export type TeamCredentialNativeBindingReadRequestV1 = z.infer<typeof TeamCredentialNativeBindingReadRequestV1Schema>;
export function computeTeamCredentialNativeBindingReadDigestV1(input: z.infer<typeof TeamCredentialNativeBindingReadBodyV1Schema>): string {
  const body = TeamCredentialNativeBindingReadBodyV1Schema.parse(input);
  return computeCanonicalDomainSeparatedDigest('happier.team-credential.native-binding-read.v1', [
    body.homeId, body.teamId, body.resourceId, body.sessionId, body.managedId, body.bindingKey,
    String(body.expectedResourceRevision), body.expectedSourceRevision, body.expectedProviderTicket,
    body.machineId, body.installationId,
  ]);
}
export const TeamCredentialNativeBindingReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('prepared'), binding: SessionTeamCredentialNativeDeliveryV1Schema }),
  z.strictObject({ status: z.literal('ready'), binding: SessionTeamCredentialNativeDeliveryV1Schema,
    model: TeamCredentialProviderModelCatalogEntryV1Schema,
    endpoint: DaemonProviderNativeSourceV1Schema.shape.endpoint,
    credentialTransport: DaemonProviderNativeSourceV1Schema.shape.credentialTransport,
    placeholder: z.string().check(z.minLength(1)),
  }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['binding_unavailable', 'installation_unknown']) }),
]));
export type TeamCredentialNativeBindingReadResponseV1 = z.infer<typeof TeamCredentialNativeBindingReadResponseV1Schema>;
const SourceVersionSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
const MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES = 4_000_000;
const RecipientContentPublicKeySchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(512), z.refine((value) => {
  try {
    const bytes = decodeBase64(value, 'base64');
    return bytes.byteLength === 32 && encodeBase64(bytes, 'base64') === value;
  } catch {
    return false;
  }
}, 'Expected a canonical base64 X25519 public key')));
const DirectMaterialUnavailableReasonSchema = lazyZodSchema(() => z.enum([
  'preparing',
  'source_changed',
  'recipient_binding_changed',
  'access_removed',
  'disabled',
  'temporarily_unavailable',
  'unsupported_direct_source',
  'invalid_material',
  'resource_corrupt',
]));

// Use a regular union here because PluginContributionIdentityV1Schema is a
// protocol-composable schema whose internal definition is intentionally not
// exposed as a Zod discriminant to callers.
export const TeamCredentialSourceMemberV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('connected_account'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
    connectedAccountId: BoundedIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal('provider_credential_slot'),
    connectionId: ProviderConnectionIdSchema,
    credentialSlotId: ProviderLocalIdSchema,
  }),
]));
export type TeamCredentialSourceMemberV1 = z.infer<typeof TeamCredentialSourceMemberV1Schema>;

/**
 * The configuration is a source-resolved snapshot. It intentionally has no
 * Saved Secret ids or Account-scoped ciphertext, so a recipient cannot turn a
 * direct material row into a source configuration writer.
 */
export const TeamCredentialDirectConnectedAccountConfigurationV1Schema = lazyZodSchema(() => z.strictObject({
  values: z.record(BoundedIdentitySchema, StrictJsonValueSchema).check(z.superRefine((values, context) => {
    if (Object.keys(values).length > 64) {
      context.addIssue({ code: 'custom', message: 'Connected-account configuration values exceed the field limit' });
    }
  })),
  secretValues: z.record(BoundedIdentitySchema, z.string().check(z.minLength(1), z.maxLength(64 * 1024))).check(z.superRefine((values, context) => {
    if (Object.keys(values).length > 64) {
      context.addIssue({ code: 'custom', message: 'Connected-account configuration secrets exceed the field limit' });
    }
  })),
}));
export type TeamCredentialDirectConnectedAccountConfigurationV1 = z.infer<
  typeof TeamCredentialDirectConnectedAccountConfigurationV1Schema
>;

const ConnectedAccountMaterialSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('qualified_connected_account'),
  credential: QualifiedConnectedAccountCredentialPayloadV1Schema,
  configuration: z.nullable(TeamCredentialDirectConnectedAccountConfigurationV1Schema),
  authenticationModeId: BoundedIdentitySchema,
}));

const ProviderMaterialSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('provider_api_key'),
  value: z.string().check(z.minLength(1), z.superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES) {
      context.addIssue({ code: 'custom', message: 'Provider credential exceeds the Saved Secret size limit' });
    }
  })),
  runtimeBinding: z.strictObject({
    provider: z.strictObject({
      identity: asProtocolZod(PluginContributionIdentityV1Schema),
      definitionRevision: z.number().check(z.int(), z.nonnegative()),
    }),
    endpoint: z.strictObject({
      endpointTemplateId: BoundedIdentitySchema,
      normalizedUrl: ProviderEndpointUrlSyntaxSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: z.record(z.string(), z.string()),
    }),
    credentialTransport: ProviderCredentialTransportV1Schema,
  }),
}));

export const TeamCredentialDirectMaterialPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  domain: z.literal('happier.team-credential-direct-material'),
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().check(z.int(), z.nonnegative()),
  recipientAccountId: BoundedIdentitySchema,
  sourceMember: TeamCredentialSourceMemberV1Schema,
  sourceVersion: SourceVersionSchema,
  material: z.union([ConnectedAccountMaterialSchema, ProviderMaterialSchema]),
}));
export type TeamCredentialDirectMaterialPayloadV1 = z.infer<typeof TeamCredentialDirectMaterialPayloadV1Schema>;

export const TeamCredentialDirectMaterialStoredV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({
    t: z.literal('plain'),
    v: TeamCredentialDirectMaterialPayloadV1Schema,
  }),
  z.strictObject({
    t: z.literal('encrypted'),
    c: z.string().check(z.minLength(1), z.maxLength(5_500_000), z.refine((value) => {
      try {
        const bytes = decodeBase64(value, 'base64');
        return bytes.byteLength >= BOX_BUNDLE_MIN_BYTES
          && bytes.byteLength <= MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES + BOX_BUNDLE_MIN_BYTES
          && encodeBase64(bytes, 'base64') === value;
      } catch {
        return false;
      }
    }, 'Expected canonical padded base64 box bundle')),
  }),
]));
export type TeamCredentialDirectMaterialStoredV1 = z.infer<typeof TeamCredentialDirectMaterialStoredV1Schema>;

export const TeamCredentialDirectMaterialRouteParamsV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
}));

export const TeamCredentialDirectMaterialReadQueryV1Schema = lazyZodSchema(() => z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('readiness') }),
  z.strictObject({
    view: z.literal('preparation'),
    sourceMemberKey: SourceVersionSchema,
    cursor: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  }),
  z.strictObject({
    view: z.literal('census'),
    cursor: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  }),
]));

export const TeamCredentialDirectMaterialConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: BoundedIdentitySchema }),
  z.strictObject({
    kind: z.literal('execution_run'),
    executionRunId: BoundedIdentitySchema,
    workerMachineId: BoundedIdentitySchema,
  }),
]));
export type TeamCredentialDirectMaterialConsumerV1 = z.infer<
  typeof TeamCredentialDirectMaterialConsumerV1Schema
>;

const TeamCredentialProviderModelDirectMaterialUseV1Schema = lazyZodSchema(() => z.strictObject({
    resourceId: BoundedIdentitySchema,
    slot: z.strictObject({ kind: z.literal('provider_model') }),
    sourceMemberKey: SourceVersionSchema,
  }));
const TeamCredentialConnectedServiceDirectMaterialUseV1Schema = lazyZodSchema(() => z.strictObject({
    resourceId: BoundedIdentitySchema,
    slot: z.strictObject({
      kind: z.literal('connected_service_purpose'),
      purpose: QualifiedConnectedAccountPurposeV1Schema,
    }),
    disclosedMember: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }));
export const TeamCredentialDirectMaterialUseV1Schema = lazyZodSchema(() => z.union([
  TeamCredentialProviderModelDirectMaterialUseV1Schema,
  TeamCredentialConnectedServiceDirectMaterialUseV1Schema,
]));
export type TeamCredentialDirectMaterialUseV1 = z.infer<
  typeof TeamCredentialDirectMaterialUseV1Schema
>;

export const TeamCredentialDirectMaterialOpenRequestV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TeamCredentialProviderModelDirectMaterialUseV1Schema, {
    consumer: TeamCredentialDirectMaterialConsumerV1Schema,
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TeamCredentialConnectedServiceDirectMaterialUseV1Schema, {
    consumer: TeamCredentialDirectMaterialConsumerV1Schema,
  })),
]));
export type TeamCredentialDirectMaterialOpenRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialOpenRequestV1Schema
>;

const TeamCredentialDirectMaterialExpectedV1Schema = lazyZodSchema(() => z.strictObject({
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().check(z.int(), z.nonnegative()),
  recipientAccountId: BoundedIdentitySchema,
  sourceMemberKey: SourceVersionSchema,
  sourceVersion: SourceVersionSchema,
}));

export const TeamCredentialDirectMaterialMineResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    recipientMode: z.enum(['plain', 'e2ee']),
    stored: createStoredReadSchema(TeamCredentialDirectMaterialStoredV1Schema),
    expected: TeamCredentialDirectMaterialExpectedV1Schema,
    /** Admission-owned presentation only; omission leaves the resource label unknown. */
    admittedResource: z.optional(z.strictObject({
      displayName: z.string().check(z.trim(), z.minLength(1), z.maxLength(120)),
      teamId: BoundedIdentitySchema,
    })),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: DirectMaterialUnavailableReasonSchema,
  }),
]));
export type TeamCredentialDirectMaterialMineResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialMineResponseV1Schema
>;

export const TeamCredentialDirectMaterialPreparationRecipientV1Schema = lazyZodSchema(() => z.strictObject({
  recipientAccountId: BoundedIdentitySchema,
  recipientMode: z.enum(['plain', 'e2ee']),
  recipientContentPublicKeyFingerprint: z.nullable(SourceVersionSchema),
  recipientContentPublicKey: z.nullable(RecipientContentPublicKeySchema),
  expectedStoredSourceVersion: z.nullable(SourceVersionSchema),
  /**
   * The Home's census answer for the stored tuple: bound to the published
   * source version and to the recipient's current encryption binding. The
   * source adapter alone knows whether its own version moved on, so it
   * prepares a recipient only when this is false or the version changed.
   */
  storedTupleCurrent: z.boolean(),
}));

export const TeamCredentialDirectMaterialPreparationResponseV1Schema = lazyZodSchema(() => z.strictObject({
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().check(z.int(), z.nonnegative()),
  source: TeamCredentialSourceBindingV1Schema,
  sourceMember: TeamCredentialSourceMemberV1Schema,
  /** Home-owned credential-row lifetime for Connected Account material. */
  sourceCredentialIncarnation: z.nullable(BoundedIdentitySchema),
  publishedSourceVersion: z.nullable(SourceVersionSchema),
  recipients: z.array(TeamCredentialDirectMaterialPreparationRecipientV1Schema).check(z.maxLength(100)),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));
export type TeamCredentialDirectMaterialPreparationResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialPreparationResponseV1Schema
>;

export const TeamCredentialDirectMaterialUpsertRequestV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    recipientAccountId: BoundedIdentitySchema,
    sourceMemberKey: SourceVersionSchema,
    sourceVersion: SourceVersionSchema,
    expectedPublishedSourceVersion: z.nullable(SourceVersionSchema),
    recipientMode: z.enum(['plain', 'e2ee']),
    recipientContentPublicKeyFingerprint: z.nullable(SourceVersionSchema),
    stored: TeamCredentialDirectMaterialStoredV1Schema,
    expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
    expectedStoredSourceVersion: z.nullable(SourceVersionSchema),
  })).check(z.minLength(1), z.maxLength(100)),
}));
export type TeamCredentialDirectMaterialUpsertRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialUpsertRequestV1Schema
>;

export const TeamCredentialDirectMaterialWithdrawRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sourceMemberKey: SourceVersionSchema,
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  expectedPublishedSourceVersion: SourceVersionSchema,
}));
export type TeamCredentialDirectMaterialWithdrawRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialWithdrawRequestV1Schema
>;
export const TeamCredentialDirectMaterialWithdrawResponseV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('withdrawn'),
}));
export type TeamCredentialDirectMaterialWithdrawResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialWithdrawResponseV1Schema
>;

export const TeamCredentialDirectMaterialUpsertResponseV1Schema = lazyZodSchema(() => z.strictObject({
  results: z.array(z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('stored'),
      recipientAccountId: BoundedIdentitySchema,
      sourceMemberKey: SourceVersionSchema,
      sourceVersion: SourceVersionSchema,
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      recipientAccountId: BoundedIdentitySchema,
      sourceMemberKey: SourceVersionSchema,
      reason: DirectMaterialUnavailableReasonSchema,
    }),
  ])).check(z.maxLength(100)),
}));
export type TeamCredentialDirectMaterialUpsertResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialUpsertResponseV1Schema
>;

type TeamCredentialDirectMaterialExpectedFields = Pick<
  TeamCredentialDirectMaterialPayloadV1,
  'homeServerIdentityId' | 'teamId' | 'resourceId' | 'resourceRevision' | 'recipientAccountId' | 'sourceVersion'
>;
export type TeamCredentialDirectMaterialExpected = Readonly<
  TeamCredentialDirectMaterialExpectedFields & { sourceMemberKey: string }
>;

function encodePayload(payload: TeamCredentialDirectMaterialPayloadV1): Uint8Array {
  const parsed = TeamCredentialDirectMaterialPayloadV1Schema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  if (bytes.byteLength > MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES) {
    throw new Error('Team credential direct material exceeds the bounded payload size');
  }
  return bytes;
}

function sourceMemberParts(member: TeamCredentialSourceMemberV1): readonly string[] {
  return member.kind === 'connected_account'
    ? ['connected_account', member.service.pluginId, member.service.localId, member.connectedAccountId]
    : ['provider_credential_slot', member.connectionId, member.credentialSlotId];
}

/**
 * The first direct-delivery capability is deliberately narrow: a manual
 * Connected Account is a read-only snapshot and never grants the recipient a
 * refresh or mutation owner. Both the source daemon and Home use this closed
 * contract identity when deriving currentness.
 */
export const TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1 =
  CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1;

/** Stable tuple identity; mutable pool rows and display names never participate. */
export function computeTeamCredentialSourceMemberKeyV1(member: TeamCredentialSourceMemberV1): string {
  const parsed = TeamCredentialSourceMemberV1Schema.parse(member);
  return computeCanonicalDomainSeparatedDigest(
    'happier.team-credential-source-member.v1',
    sourceMemberParts(parsed),
  );
}

const CompoundSourceVersionPrefix = 'v1:';
const CompoundSourceVersionPartsSchema = lazyZodSchema(() => z.tuple([SourceVersionSchema, SourceVersionSchema]));

/** Home verifies the basis; only the source materializer can verify private configuration. */
export function composeTeamCredentialSourceVersionV1(input: Readonly<{
  sourceBasisVersion: string;
  privateConfigurationFingerprint?: string | null;
}>): string {
  const basis = SourceVersionSchema.parse(input.sourceBasisVersion);
  if (input.privateConfigurationFingerprint == null) return basis;
  return SourceVersionSchema.parse(CompoundSourceVersionPrefix + JSON.stringify(
    CompoundSourceVersionPartsSchema.parse([basis, input.privateConfigurationFingerprint]),
  ));
}

export function parseTeamCredentialSourceVersionV1(version: string): Readonly<{
  sourceBasisVersion: string;
  privateConfigurationFingerprint: string | null;
}> {
  const parsed = SourceVersionSchema.parse(version);
  if (!parsed.startsWith(CompoundSourceVersionPrefix)) {
    return { sourceBasisVersion: parsed, privateConfigurationFingerprint: null };
  }
  const [sourceBasisVersion, privateConfigurationFingerprint] = CompoundSourceVersionPartsSchema.parse(
    JSON.parse(parsed.slice(CompoundSourceVersionPrefix.length)),
  );
  if (composeTeamCredentialSourceVersionV1({ sourceBasisVersion, privateConfigurationFingerprint }) !== parsed) {
    throw new Error('Noncanonical Team credential source version');
  }
  return { sourceBasisVersion, privateConfigurationFingerprint };
}

export function matchesTeamCredentialSourceVersionBasisV1(version: string, sourceBasisVersion: string): boolean {
  try {
    return parseTeamCredentialSourceVersionV1(version).sourceBasisVersion === sourceBasisVersion;
  } catch {
    return false;
  }
}

/**
 * Complete currentness for one Connected Account snapshot. Configuration
 * and authentication-only changes deliberately invalidate material even when
 * credential bytes retain their revision.
 */
export function computeTeamCredentialConnectedAccountSourceVersionV1(input: Readonly<{
  sourceAccountId: string;
  credentialIncarnation: string;
  sourceMember: Extract<TeamCredentialSourceMemberV1, { kind: 'connected_account' }>;
  credentialRevision: string;
  configurationRevision: string | null;
  authenticationModeId: string;
  contributionContractVersion: string;
  privateConfigurationFingerprint?: string | null;
}>): string {
  const member = TeamCredentialSourceMemberV1Schema.parse(input.sourceMember);
  if (member.kind !== 'connected_account') throw new Error('Expected a Connected Account source member');
  const sourceBasisVersion = computeCanonicalDomainSeparatedDigest(
    'happier.team-credential-connected-account-source-version.v1',
    [
      input.sourceAccountId,
      input.credentialIncarnation,
      computeTeamCredentialSourceMemberKeyV1(member),
      input.credentialRevision,
      input.configurationRevision ?? 'no-configuration',
      input.authenticationModeId,
      input.contributionContractVersion,
    ],
  );
  return composeTeamCredentialSourceVersionV1({ sourceBasisVersion, privateConfigurationFingerprint: input.privateConfigurationFingerprint });
}

export function computeTeamCredentialPoolMemberSourceVersionV1(input: Readonly<{
  connectedAccountSourceVersion: string;
  poolIncarnation: string;
  memberEnabled: boolean;
}>): string {
  const connected = parseTeamCredentialSourceVersionV1(input.connectedAccountSourceVersion);
  const sourceBasisVersion = computeCanonicalDomainSeparatedDigest(
    'happier.team-credential-pool-member-source-version.v1',
    [
      connected.sourceBasisVersion,
      BoundedIdentitySchema.parse(input.poolIncarnation),
      input.memberEnabled ? 'enabled' : 'disabled',
    ],
  );
  return composeTeamCredentialSourceVersionV1({ sourceBasisVersion, privateConfigurationFingerprint: connected.privateConfigurationFingerprint });
}

export function computeTeamCredentialProviderCredentialSlotSourceVersionV1(input: Readonly<{
  sourceAccountId: string;
  sourceMember: Extract<TeamCredentialSourceMemberV1, { kind: 'provider_credential_slot' }>;
  providerConnectionRevision: string;
  machineBinding: string;
  savedSecretFingerprint: string;
  credentialTransport: 'api_key';
}>): string {
  const member = TeamCredentialSourceMemberV1Schema.parse(input.sourceMember);
  if (member.kind !== 'provider_credential_slot') throw new Error('Expected a Provider credential slot source member');
  return computeCanonicalDomainSeparatedDigest(
    'happier.team-credential-provider-slot-source-version.v1',
    [
      BoundedIdentitySchema.parse(input.sourceAccountId),
      computeTeamCredentialSourceMemberKeyV1(member),
      SourceVersionSchema.parse(input.providerConnectionRevision),
      BoundedIdentitySchema.parse(input.machineBinding),
      SourceVersionSchema.parse(input.savedSecretFingerprint),
      input.credentialTransport,
    ],
  );
}


function expectedMatches(payload: TeamCredentialDirectMaterialPayloadV1, expected: TeamCredentialDirectMaterialExpected): boolean {
  if (!expected || typeof expected !== 'object') return false;
  // What makes prepared material current is the identity of what it carries:
  // the Home, the Team, the resource, the recipient and the exact source
  // member and version it was produced from. `resourceRevision` is the
  // resource's whole authority revision, which a policy-only edit advances
  // without invalidating any material — the Home keeps the rows and its
  // readiness census keeps reporting them ready, so requiring equality here
  // would make an opener the only party that disagrees. It stays in the
  // payload and the expectation as the preparation's provenance, and the
  // upload CAS still uses it.
  for (const key of ['homeServerIdentityId', 'teamId', 'resourceId', 'recipientAccountId', 'sourceVersion'] as const) {
    if (payload[key] !== expected[key]) return false;
  }
  return computeTeamCredentialSourceMemberKeyV1(payload.sourceMember) === expected.sourceMemberKey;
}

export function sealTeamCredentialDirectMaterialV1(params: Readonly<{
  payload: TeamCredentialDirectMaterialPayloadV1;
  recipientContentPublicKey: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): string {
  return encodeBase64(sealBoxBundle({
    plaintext: encodePayload(params.payload),
    recipientPublicKey: params.recipientContentPublicKey,
    randomBytes: params.randomBytes,
  }));
}

export function openTeamCredentialDirectMaterialV1(params: Readonly<{
  envelope: string;
  recipientSecretKeyOrSeed: Uint8Array;
  expected: TeamCredentialDirectMaterialExpected;
}>): TeamCredentialDirectMaterialPayloadV1 | null {
  let bundle: Uint8Array;
  try {
    bundle = decodeBase64(params.envelope, 'base64');
  } catch {
    return null;
  }
  const opened = openBoxBundle({ bundle, recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed });
  if (!opened || opened.byteLength > MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES) return null;
  try {
    const parsed = createStoredReadSchema(TeamCredentialDirectMaterialPayloadV1Schema).parse(JSON.parse(new TextDecoder().decode(opened)));
    return expectedMatches(parsed, params.expected) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTeamCredentialDirectMaterialStoredV1(input: unknown): TeamCredentialDirectMaterialStoredV1 {
  return createStoredReadSchema(TeamCredentialDirectMaterialStoredV1Schema).parse(input);
}

export function materializeTeamCredentialDirectMaterialV1(params: Readonly<{
  stored: unknown;
  recipientMode: 'plain' | 'e2ee';
  recipientSecretKeyOrSeed?: Uint8Array;
  expected: TeamCredentialDirectMaterialExpected;
}>): TeamCredentialDirectMaterialPayloadV1 | null {
  let stored: TeamCredentialDirectMaterialStoredV1;
  try {
    stored = parseTeamCredentialDirectMaterialStoredV1(params.stored);
  } catch {
    return null;
  }
  if (params.recipientMode === 'plain') {
    if (stored.t !== 'plain' || !expectedMatches(stored.v, params.expected)) return null;
    return stored.v;
  }
  if (stored.t !== 'encrypted' || params.recipientSecretKeyOrSeed === undefined) return null;
  return openTeamCredentialDirectMaterialV1({
    envelope: stored.c,
    recipientSecretKeyOrSeed: params.recipientSecretKeyOrSeed,
    expected: params.expected,
  });
}

export function createTeamCredentialDirectMaterialStoredV1(params: Readonly<{
  payload: TeamCredentialDirectMaterialPayloadV1;
  recipientMode: 'plain' | 'e2ee';
  recipientContentPublicKey?: Uint8Array;
  randomBytes?: (length: number) => Uint8Array;
}>): TeamCredentialDirectMaterialStoredV1 {
  const payload = TeamCredentialDirectMaterialPayloadV1Schema.parse(params.payload);
  if (params.recipientMode === 'plain') return { t: 'plain', v: payload };
  if (!params.recipientContentPublicKey || !params.randomBytes) {
    throw new Error('E2EE direct material requires recipient content key and randomness');
  }
  return {
    t: 'encrypted',
    c: sealTeamCredentialDirectMaterialV1({
      payload,
      recipientContentPublicKey: params.recipientContentPublicKey,
      randomBytes: params.randomBytes,
    }),
  };
}

export type { JsonValue, PluginContributionIdentityV1, QualifiedConnectedAccountCredentialPayloadV1 };
