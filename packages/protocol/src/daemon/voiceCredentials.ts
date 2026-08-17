import { z } from 'zod';

import { ConnectedAccountHttpHeadersRequestSchema } from '../connect/connectedAccountPurposes.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../connect/connectedServiceSchemas.js';
import {
  VoiceCredentialAccessPhaseSchema,
} from '../plugins/contributions/voiceProviders.js';
import {
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

export const DaemonVoiceClientCredentialSelectionV1Schema = z.object({
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
}).strict();
export type DaemonVoiceClientCredentialSelectionV1 = z.infer<
  typeof DaemonVoiceClientCredentialSelectionV1Schema
>;

export const DaemonVoiceClientRawCredentialMaterializeRequestV1Schema = z.object({
  cacheIdentity: DaemonPluginReactNativeBundleCacheIdentityV1Schema,
  phase: z.enum(['settings', 'prepare', 'connection']),
  /** Host-private callback fence; omitted by older UI callers. */
  expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema.nullable().optional(),
  request: ConnectedAccountHttpHeadersRequestSchema,
}).strict();
export type DaemonVoiceClientRawCredentialMaterializeRequestV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialMaterializeRequestV1Schema
>;

const DaemonVoiceCredentialErrorCodeV1Schema = z.enum([
  'plugin_voice_provider_result_invalid',
  'plugin_voice_credential_access_unavailable',
  'plugin_voice_provider_operation_failed',
]);

export const DaemonVoiceClientRawCredentialMaterializeResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    materialization: z.object({
      kind: z.literal('httpHeaders'),
      headers: z.record(z.string(), z.string()),
    }).strict(),
    /** Host-private receipt; public Voice credential access never exposes it. */
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema.nullable().optional(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialErrorCodeV1Schema,
  }).strict(),
]);
export type DaemonVoiceClientRawCredentialMaterializeResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialMaterializeResponseV1Schema
>;

export const DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema = z.object({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  platform: z.enum(['web', 'ios', 'android']),
  phase: z.enum(['settings', 'prepare', 'connection']),
  operationId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type DaemonVoiceClientMediatedCredentialMaterializeRequestV1 = z.infer<
  typeof DaemonVoiceClientMediatedCredentialMaterializeRequestV1Schema
>;

export const DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    headers: z.record(z.string(), z.string()),
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialErrorCodeV1Schema,
  }).strict(),
]);
export type DaemonVoiceClientMediatedCredentialMaterializeResponseV1 = z.infer<
  typeof DaemonVoiceClientMediatedCredentialMaterializeResponseV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema = z.object({
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
}).strict();
export type DaemonVoiceClientRawCredentialAuthorizationRequestV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationRequestV1Schema
>;

const DaemonVoiceClientRawCredentialDisclosureSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('savedSecret'),
    secretKinds: z.array(z.enum(['apiKey', 'token', 'password', 'other'])),
  }).strict(),
  z.object({
    kind: z.literal('connectedAccount'),
    service: asProtocolZod(PluginContributionIdentityV1Schema),
  }).strict(),
]);

export const DaemonVoiceClientRawCredentialDisclosureV1Schema = z.object({
  sourceClass: DaemonVoiceClientRawCredentialDisclosureSourceV1Schema,
  realm: z.enum(['web', 'ios', 'android', 'daemon']),
  phase: VoiceCredentialAccessPhaseSchema,
  materialization: z.enum(['httpHeaders', 'environment', 'files']),
  origin: z.string().url().optional(),
  destination: z.string().trim().min(1),
}).strict();
export type DaemonVoiceClientRawCredentialDisclosureV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialDisclosureV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  capability: PluginPermissionCapabilityV1Schema,
  targetScope: z.object({ kind: z.literal('account') }).strict(),
  subject: PluginPermissionSubjectV1Schema,
  disclosures: z.array(DaemonVoiceClientRawCredentialDisclosureV1Schema),
}).strict();
export type DaemonVoiceClientRawCredentialAuthorizationV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationV1Schema
>;

export const DaemonVoiceClientRawCredentialReviewV1Schema = z.object({
  plugin: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
  }).strict(),
  package: z.object({
    identity: z.string().trim().min(1),
  }).strict(),
  distribution: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bundled') }).strict(),
    z.object({ kind: z.literal('unavailable') }).strict(),
    z.object({ kind: z.literal('path'), development: z.boolean() }).strict(),
    z.object({ kind: z.literal('archive') }).strict(),
    z.object({
      kind: z.literal('npm'),
      packageName: z.string().trim().min(1),
      registryOrigin: z.string().url(),
    }).strict(),
  ]),
  publisher: z.union([
    z.object({
      status: z.literal('bundled_first_party'),
      identity: z.literal('Happier'),
    }).strict(),
    z.object({
      status: z.literal('unverified'),
      id: z.string().trim().min(1),
      displayName: z.string().trim().min(1),
    }).strict(),
    z.object({ status: z.literal('unavailable') }).strict(),
  ]),
  packageSignature: z.union([
    z.object({ status: z.literal('verified'), keyId: z.string().trim().min(1) }).strict(),
    z.object({ status: z.literal('unavailable') }).strict(),
  ]),
  contribution: z.object({
    identity: asProtocolZod(PluginContributionIdentityV1Schema),
    name: z.string().trim().min(1),
  }).strict(),
  credentialSlot: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    purpose: z.string().trim().min(1),
  }).strict(),
}).strict();
export type DaemonVoiceClientRawCredentialReviewV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialReviewV1Schema
>;

const DaemonVoiceCredentialAuthorizationErrorCodeV1Schema = z.enum([
  'invalid_request',
  'unavailable',
  'request_failed',
  'internal_error',
]);

export const DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    authorization: DaemonVoiceClientRawCredentialAuthorizationV1Schema,
    review: DaemonVoiceClientRawCredentialReviewV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialAuthorizationErrorCodeV1Schema,
  }).strict(),
]);
export type DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema
>;

export const DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    authorization: DaemonVoiceClientRawCredentialAuthorizationV1Schema,
    review: DaemonVoiceClientRawCredentialReviewV1Schema,
    pendingRequest: PluginPermissionGrantRequestV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonVoiceCredentialAuthorizationErrorCodeV1Schema,
  }).strict(),
]);
export type DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1 = z.infer<
  typeof DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema
>;
