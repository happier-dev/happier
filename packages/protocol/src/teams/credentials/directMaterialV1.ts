import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

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
const SourceVersionSchema = lazyZodSchema(() => z.string().min(1).max(256));
const MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES = 4_000_000;
const RecipientContentPublicKeySchema = lazyZodSchema(() => z.string().min(1).max(512).refine((value) => {
  try {
    const bytes = decodeBase64(value, 'base64');
    return bytes.byteLength === 32 && encodeBase64(bytes, 'base64') === value;
  } catch {
    return false;
  }
}, 'Expected a canonical base64 X25519 public key'));
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
  z.object({
    kind: z.literal('connected_account'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
    connectedAccountId: BoundedIdentitySchema,
  }).strict(),
  z.object({
    kind: z.literal('provider_credential_slot'),
    connectionId: ProviderConnectionIdSchema,
    credentialSlotId: ProviderLocalIdSchema,
  }).strict(),
]));
export type TeamCredentialSourceMemberV1 = z.infer<typeof TeamCredentialSourceMemberV1Schema>;

/**
 * The configuration is a source-resolved snapshot. It intentionally has no
 * Saved Secret ids or Account-scoped ciphertext, so a recipient cannot turn a
 * direct material row into a source configuration writer.
 */
export const TeamCredentialDirectConnectedAccountConfigurationV1Schema = lazyZodSchema(() => z.object({
  values: z.record(BoundedIdentitySchema, StrictJsonValueSchema).superRefine((values, context) => {
    if (Object.keys(values).length > 64) {
      context.addIssue({ code: 'custom', message: 'Connected-account configuration values exceed the field limit' });
    }
  }),
  secretValues: z.record(BoundedIdentitySchema, z.string().min(1).max(64 * 1024)).superRefine((values, context) => {
    if (Object.keys(values).length > 64) {
      context.addIssue({ code: 'custom', message: 'Connected-account configuration secrets exceed the field limit' });
    }
  }),
}).strict());
export type TeamCredentialDirectConnectedAccountConfigurationV1 = z.infer<
  typeof TeamCredentialDirectConnectedAccountConfigurationV1Schema
>;

const ConnectedAccountMaterialSchema = lazyZodSchema(() => z.object({
  kind: z.literal('qualified_connected_account'),
  credential: QualifiedConnectedAccountCredentialPayloadV1Schema,
  configuration: TeamCredentialDirectConnectedAccountConfigurationV1Schema.nullable(),
  authenticationModeId: BoundedIdentitySchema,
}).strict());

const ProviderMaterialSchema = lazyZodSchema(() => z.object({
  kind: z.literal('provider_api_key'),
  value: z.string().min(1).superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > ACCOUNT_SETTINGS_MAX_SAVED_SECRETS_BYTES) {
      context.addIssue({ code: 'custom', message: 'Provider credential exceeds the Saved Secret size limit' });
    }
  }),
  runtimeBinding: z.object({
    provider: z.object({
      identity: asProtocolZod(PluginContributionIdentityV1Schema),
      definitionRevision: z.number().int().nonnegative(),
    }).strict(),
    endpoint: z.object({
      endpointTemplateId: BoundedIdentitySchema,
      normalizedUrl: ProviderEndpointUrlSyntaxSchema,
      protocol: ProviderWireProtocolSchema,
      publicHeaders: z.record(z.string(), z.string()),
    }).strict(),
    credentialTransport: ProviderCredentialTransportV1Schema,
  }).strict(),
}).strict());

export const TeamCredentialDirectMaterialPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  domain: z.literal('happier.team-credential-direct-material'),
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().int().nonnegative(),
  recipientAccountId: BoundedIdentitySchema,
  sourceMember: TeamCredentialSourceMemberV1Schema,
  sourceVersion: SourceVersionSchema,
  material: z.union([ConnectedAccountMaterialSchema, ProviderMaterialSchema]),
}).strict());
export type TeamCredentialDirectMaterialPayloadV1 = z.infer<typeof TeamCredentialDirectMaterialPayloadV1Schema>;

export const TeamCredentialDirectMaterialStoredV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('plain'),
    v: TeamCredentialDirectMaterialPayloadV1Schema,
  }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1).max(5_500_000).refine((value) => {
      try {
        const bytes = decodeBase64(value, 'base64');
        return bytes.byteLength >= BOX_BUNDLE_MIN_BYTES
          && bytes.byteLength <= MAX_DIRECT_MATERIAL_PLAINTEXT_BYTES + BOX_BUNDLE_MIN_BYTES
          && encodeBase64(bytes, 'base64') === value;
      } catch {
        return false;
      }
    }, 'Expected canonical padded base64 box bundle'),
  }).strict(),
]));
export type TeamCredentialDirectMaterialStoredV1 = z.infer<typeof TeamCredentialDirectMaterialStoredV1Schema>;

export const TeamCredentialDirectMaterialRouteParamsV1Schema = lazyZodSchema(() => z.object({
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
}).strict());

export const TeamCredentialDirectMaterialReadQueryV1Schema = lazyZodSchema(() => z.discriminatedUnion('view', [
  z.object({
    view: z.literal('preparation'),
    sourceMemberKey: SourceVersionSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
  }).strict(),
  z.object({
    view: z.literal('census'),
    cursor: z.string().trim().min(1).max(512).optional(),
  }).strict(),
]));

export const TeamCredentialDirectMaterialConsumerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: BoundedIdentitySchema }).strict(),
  z.object({
    kind: z.literal('execution_run'),
    executionRunId: BoundedIdentitySchema,
    workerMachineId: BoundedIdentitySchema,
  }).strict(),
]));
export type TeamCredentialDirectMaterialConsumerV1 = z.infer<
  typeof TeamCredentialDirectMaterialConsumerV1Schema
>;

const TeamCredentialProviderModelDirectMaterialUseV1Schema = lazyZodSchema(() => z.object({
    resourceId: BoundedIdentitySchema,
    slot: z.object({ kind: z.literal('provider_model') }).strict(),
    sourceMemberKey: SourceVersionSchema,
  }).strict());
const TeamCredentialConnectedServiceDirectMaterialUseV1Schema = lazyZodSchema(() => z.object({
    resourceId: BoundedIdentitySchema,
    slot: z.object({
      kind: z.literal('connected_service_purpose'),
      purpose: QualifiedConnectedAccountPurposeV1Schema,
    }).strict(),
    disclosedMember: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }).strict());
export const TeamCredentialDirectMaterialUseV1Schema = lazyZodSchema(() => z.union([
  TeamCredentialProviderModelDirectMaterialUseV1Schema,
  TeamCredentialConnectedServiceDirectMaterialUseV1Schema,
]));
export type TeamCredentialDirectMaterialUseV1 = z.infer<
  typeof TeamCredentialDirectMaterialUseV1Schema
>;

export const TeamCredentialDirectMaterialOpenRequestV1Schema = lazyZodSchema(() => z.union([
  TeamCredentialProviderModelDirectMaterialUseV1Schema.extend({
    consumer: TeamCredentialDirectMaterialConsumerV1Schema,
  }).strict(),
  TeamCredentialConnectedServiceDirectMaterialUseV1Schema.extend({
    consumer: TeamCredentialDirectMaterialConsumerV1Schema,
  }).strict(),
]));
export type TeamCredentialDirectMaterialOpenRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialOpenRequestV1Schema
>;

const TeamCredentialDirectMaterialExpectedV1Schema = lazyZodSchema(() => z.object({
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().int().nonnegative(),
  recipientAccountId: BoundedIdentitySchema,
  sourceMemberKey: SourceVersionSchema,
  sourceVersion: SourceVersionSchema,
}).strict());

export const TeamCredentialDirectMaterialMineResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    recipientMode: z.enum(['plain', 'e2ee']),
    stored: TeamCredentialDirectMaterialStoredV1Schema,
    expected: TeamCredentialDirectMaterialExpectedV1Schema,
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    reason: DirectMaterialUnavailableReasonSchema,
  }).strict(),
]));
export type TeamCredentialDirectMaterialMineResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialMineResponseV1Schema
>;

export const TeamCredentialDirectMaterialPreparationRecipientV1Schema = lazyZodSchema(() => z.object({
  recipientAccountId: BoundedIdentitySchema,
  recipientMode: z.enum(['plain', 'e2ee']),
  recipientContentPublicKeyFingerprint: SourceVersionSchema.nullable(),
  recipientContentPublicKey: RecipientContentPublicKeySchema.nullable(),
  expectedStoredSourceVersion: SourceVersionSchema.nullable(),
  /**
   * The Home's census answer for the stored tuple: bound to the published
   * source version and to the recipient's current encryption binding. The
   * source adapter alone knows whether its own version moved on, so it
   * prepares a recipient only when this is false or the version changed.
   */
  storedTupleCurrent: z.boolean(),
}).strict());

export const TeamCredentialDirectMaterialPreparationResponseV1Schema = lazyZodSchema(() => z.object({
  homeServerIdentityId: BoundedIdentitySchema,
  teamId: BoundedIdentitySchema,
  resourceId: BoundedIdentitySchema,
  resourceRevision: z.number().int().nonnegative(),
  source: TeamCredentialSourceBindingV1Schema,
  sourceMember: TeamCredentialSourceMemberV1Schema,
  /** Home-owned credential-row lifetime for Connected Account material. */
  sourceCredentialIncarnation: BoundedIdentitySchema.nullable(),
  publishedSourceVersion: SourceVersionSchema.nullable(),
  recipients: z.array(TeamCredentialDirectMaterialPreparationRecipientV1Schema).max(100),
  nextCursor: z.string().trim().min(1).max(512).nullable(),
}).strict());
export type TeamCredentialDirectMaterialPreparationResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialPreparationResponseV1Schema
>;

export const TeamCredentialDirectMaterialUpsertRequestV1Schema = lazyZodSchema(() => z.object({
  items: z.array(z.object({
    recipientAccountId: BoundedIdentitySchema,
    sourceMemberKey: SourceVersionSchema,
    sourceVersion: SourceVersionSchema,
    expectedPublishedSourceVersion: SourceVersionSchema.nullable(),
    recipientMode: z.enum(['plain', 'e2ee']),
    recipientContentPublicKeyFingerprint: SourceVersionSchema.nullable(),
    stored: TeamCredentialDirectMaterialStoredV1Schema,
    expectedResourceRevision: z.number().int().nonnegative(),
    expectedStoredSourceVersion: SourceVersionSchema.nullable(),
  }).strict()).min(1).max(100),
}).strict());
export type TeamCredentialDirectMaterialUpsertRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialUpsertRequestV1Schema
>;

export const TeamCredentialDirectMaterialWithdrawRequestV1Schema = lazyZodSchema(() => z.object({
  sourceMemberKey: SourceVersionSchema,
  expectedResourceRevision: z.number().int().nonnegative(),
  expectedPublishedSourceVersion: SourceVersionSchema,
}).strict());
export type TeamCredentialDirectMaterialWithdrawRequestV1 = z.infer<
  typeof TeamCredentialDirectMaterialWithdrawRequestV1Schema
>;
export const TeamCredentialDirectMaterialWithdrawResponseV1Schema = lazyZodSchema(() => z.object({
  status: z.literal('withdrawn'),
}).strict());
export type TeamCredentialDirectMaterialWithdrawResponseV1 = z.infer<
  typeof TeamCredentialDirectMaterialWithdrawResponseV1Schema
>;

export const TeamCredentialDirectMaterialUpsertResponseV1Schema = lazyZodSchema(() => z.object({
  results: z.array(z.discriminatedUnion('status', [
    z.object({
      status: z.literal('stored'),
      recipientAccountId: BoundedIdentitySchema,
      sourceMemberKey: SourceVersionSchema,
      sourceVersion: SourceVersionSchema,
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      recipientAccountId: BoundedIdentitySchema,
      sourceMemberKey: SourceVersionSchema,
      reason: DirectMaterialUnavailableReasonSchema,
    }).strict(),
  ])).max(100),
}).strict());
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
    const parsed = TeamCredentialDirectMaterialPayloadV1Schema.parse(JSON.parse(new TextDecoder().decode(opened)));
    return expectedMatches(parsed, params.expected) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTeamCredentialDirectMaterialStoredV1(input: unknown): TeamCredentialDirectMaterialStoredV1 {
  return TeamCredentialDirectMaterialStoredV1Schema.parse(input);
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
