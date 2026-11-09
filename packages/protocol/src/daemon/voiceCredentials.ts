import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { ConnectedAccountHttpHeadersRequestSchema } from '../connect/connectedAccountPurposes.js';
import {
  QualifiedConnectedAccountPurposeBindingTargetV1Schema,
} from '../connect/connectedAccountPurposeBindings.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../connect/connectedServiceSchemas.js';
import {
  VoiceCredentialAccessPhaseSchema,
  VoiceRawCredentialGrantDeclarationSchema,
} from '../plugins/contributions/voiceProviders.js';
import {
  PluginPermissionGrantAuthoritySourceV1Schema,
  PluginPermissionGrantRequestV1Schema,
  PluginPermissionSubjectV1Schema,
} from '../plugins/permissions/grants.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { PluginPermissionCapabilityV1Schema } from '../plugins/permissions/capabilityV1.js';
import { DaemonPluginReactNativeBundleCacheIdentityV1Schema } from './contributionRegistryProjection.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { VoiceRealtimeJsonValueSchema } from '../voice/realtime/events.js';

export const DaemonVoiceClientCredentialSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  platform: z.enum(['web', 'ios', 'android']),
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
}));
export type DaemonVoiceClientCredentialSelectionV1 = z.infer<
  typeof DaemonVoiceClientCredentialSelectionV1Schema
>;

export const DaemonVoiceClientRawCredentialMaterializeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  platform: z.enum(['web', 'ios', 'android']),
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  phase: z.enum(['settings', 'prepare', 'connection']),
  /**
   * Host-private opaque callback fence. Its `csr_` wire shape is retained for
   * compatibility, but it is source-neutral and never identifies a secret or
   * Connected Account to the caller.
   */
  expectedCredentialRevision: z.optional(z.nullable(ConnectedServiceCredentialRevisionV1Schema)),
  request: ConnectedAccountHttpHeadersRequestSchema,
}));
export type DaemonVoiceClientRawCredentialMaterializeRequestV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialMaterializeRequestV1Schema
>;

const DaemonVoiceCredentialErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'plugin_voice_provider_result_invalid',
  'plugin_voice_credential_access_unavailable',
  'plugin_voice_provider_operation_failed',
]));

export const DaemonVoiceClientRawCredentialMaterializeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    materialization: z.strictObject({
      kind: z.literal('httpHeaders'),
      headers: z.record(z.string(), z.string()),
    }),
    /** Source-neutral host-private receipt; public Voice access never exposes it. */
    credentialRevision: z.optional(z.nullable(ConnectedServiceCredentialRevisionV1Schema)),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialErrorCodeV1Schema,
  }),
]));
export type DaemonVoiceClientRawCredentialMaterializeResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialMaterializeResponseV1Schema
>;

/**
 * The calling runtime's activation descriptor. This retained client wire field
 * is not an attestation: account-operation authorization belongs to the machine's
 * current registered declaration, exact operation/phase, binding and lifecycle.
 */
export const DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('projected'),
    cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  }),
  z.strictObject({
    kind: z.literal('bundled'),
  }),
]));
export type DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1 = z.infer<
  typeof DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1Schema
>;

export const DaemonVoiceClientAccountOperationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  platform: z.enum(['web', 'ios', 'android']),
  phase: z.enum(['settings', 'prepare', 'connection']),
  operationId: asProtocolZod(PluginContributionLocalIdSchema),
  parameters: z._default(z.record(z.string(), VoiceRealtimeJsonValueSchema), {}),
  declarationAuthority: DaemonVoiceClientMediatedCredentialDeclarationAuthorityV1Schema,
  /**
   * The Connected Account selection the caller captured with the credential
   * authority this operation runs under. The daemon resolves its own current
   * selection independently, so without it a daemon that has already moved to
   * Account B answers a caller still holding Account A and both sides stay
   * internally consistent while minting with the wrong account's credentials.
   */
  expectedSelection: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
}));
export type DaemonVoiceClientAccountOperationRequestV1 = z.infer<
  typeof DaemonVoiceClientAccountOperationRequestV1Schema
>;

export const DaemonVoiceClientAccountOperationResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    response: z.strictObject({
      status: z.number().check(z.int(), z.minimum(200), z.maximum(299)),
      finalUrl: z.string().check(z.url()),
      headers: z.record(z.string(), z.string()),
      bodyBase64: z.string(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialErrorCodeV1Schema,
  }),
]));
export type DaemonVoiceClientAccountOperationResponseV1 = z.infer<
  typeof DaemonVoiceClientAccountOperationResponseV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema = lazyZodSchema(() => z.strictObject({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  rawGrant: VoiceRawCredentialGrantDeclarationSchema,
}));
export type DaemonVoiceClientRawCredentialAuthorizationRequestV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema
>;

const DaemonVoiceClientRawCredentialDisclosureSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('savedSecret'),
    secretKinds: z.array(z.enum(['apiKey', 'token', 'password', 'other'])),
  }),
  z.strictObject({
    kind: z.literal('connectedAccount'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
  }),
]));

export const DaemonVoiceClientRawCredentialDisclosureV1Schema = lazyZodSchema(() => z.strictObject({
  sourceClass: DaemonVoiceClientRawCredentialDisclosureSourceV1Schema,
  realm: z.enum(['web', 'ios', 'android', 'daemon']),
  phase: VoiceCredentialAccessPhaseSchema,
  materialization: z.enum(['httpHeaders', 'environment', 'files']),
  origin: z.optional(z.string().check(z.url())),
  destination: z.string().check(z.trim(), z.minLength(1)),
}));
export type DaemonVoiceClientRawCredentialDisclosureV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialDisclosureV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: z.string().check(z.trim(), z.minLength(1)),
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: z.strictObject({ kind: z.literal('account') }),
  subject: PluginPermissionSubjectV1Schema,
  /**
   * The machine installation this authorization belongs to. Grants and pending
   * requests are Account-scoped, so a client deciding or reading one has to
   * know which installation's approval it is looking at.
   */
  authoritySource: PluginPermissionGrantAuthoritySourceV1Schema,
  /**
   * `linked`: the person's own selected Saved Secret; the link is the grant and
   * no review is asked. An older daemon omits this and keeps asking.
   */
  grantRequirement: z._default(z.optional(z.enum(['linked', 'approval_required'])), 'approval_required'),
  disclosures: z.array(DaemonVoiceClientRawCredentialDisclosureV1Schema),
}));
export type DaemonVoiceClientRawCredentialAuthorizationV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationV1Schema
>;

export const DaemonVoiceClientRawCredentialReviewV1Schema = lazyZodSchema(() => z.strictObject({
  plugin: z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    name: z.string().check(z.trim(), z.minLength(1)),
    version: z.string().check(z.trim(), z.minLength(1)),
  }),
  package: z.strictObject({
    identity: z.string().check(z.trim(), z.minLength(1)),
  }),
  distribution: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('bundled') }),
    z.strictObject({ kind: z.literal('unavailable') }),
    z.strictObject({ kind: z.literal('path'), development: z.boolean() }),
    z.strictObject({ kind: z.literal('archive') }),
    z.strictObject({
      kind: z.literal('npm'),
      packageName: z.string().check(z.trim(), z.minLength(1)),
      registryOrigin: z.string().check(z.url()),
    }),
  ]),
  publisher: z.union([
    z.strictObject({
      status: z.literal('bundled_first_party'),
      identity: z.literal('Happier'),
    }),
    z.strictObject({ status: z.literal('unavailable') }),
  ]),
  contribution: z.strictObject({
    identity: asProtocolZod(PluginContributionIdentityV1Schema),
    name: z.string().check(z.trim(), z.minLength(1)),
  }),
  credentialSlot: z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1)),
    name: z.string().check(z.trim(), z.minLength(1)),
    purpose: z.string().check(z.trim(), z.minLength(1)),
  }),
}));
export type DaemonVoiceClientRawCredentialReviewV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialReviewV1Schema
>;

const DaemonVoiceCredentialAuthorizationErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'unavailable',
  'request_failed',
  'internal_error',
]));

export const DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    authorization: DaemonVoiceClientRawCredentialAuthorizationV1Schema,
    review: DaemonVoiceClientRawCredentialReviewV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialAuthorizationErrorCodeV1Schema,
  }),
]));
export type DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    authorization: DaemonVoiceClientRawCredentialAuthorizationV1Schema,
    review: DaemonVoiceClientRawCredentialReviewV1Schema,
    pendingRequest: PluginPermissionGrantRequestV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialAuthorizationErrorCodeV1Schema,
  }),
]));
export type DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema
>;
