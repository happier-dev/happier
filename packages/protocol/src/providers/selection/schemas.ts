import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '../ids.js';
import { TeamCredentialRouteV1Schema, SessionTeamCredentialNativeDeliveryV1Schema } from '../../teams/credentials/deliveryV1.js';

/** Canonical retained and source-qualified model carriers shared by versioned entry points. */
const NativeModelRefSchema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: z.null(),
  modelId: NonBlankOpaqueIdentifierSchema,
}));
const ConnectionModelRefSchema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}));
export const ProviderBoundModelRefSchema = lazyZodSchema(() => z.union([NativeModelRefSchema, ConnectionModelRefSchema]));
export type ProviderBoundModelRef = z.infer<typeof ProviderBoundModelRefSchema>;

export const SessionModelSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  ref: ProviderBoundModelRefSchema,
  updatedAt: z.number().check(z.nonnegative()),
}));
export type SessionModelSelectionV1 = z.infer<typeof SessionModelSelectionV1Schema>;

export const NativeSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('native'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: NonBlankOpaqueIdentifierSchema,
}));

export const AccountProviderConnectionSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('account_provider_connection'),
  agentTargetKey: ProviderAgentTargetKeySchema,
  providerConnectionId: ProviderConnectionIdSchema,
  modelId: ProviderModelIdSchema,
}));

export const TeamResourceSessionModelRefV2Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('team_resource'),
  resourceId: z.string().check(z.minLength(1)),
  teamId: z.string().check(z.minLength(1)),
  expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
  deliveryMode: TeamCredentialRouteV1Schema,
  nativeDelivery: z.optional(SessionTeamCredentialNativeDeliveryV1Schema),
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
}).check(z.superRefine((selection, context) => {
  if (selection.nativeDelivery && selection.deliveryMode !== 'vendor-native') {
    context.addIssue({ code: 'custom', path: ['nativeDelivery'], message: 'Native references require native delivery' });
  }
})));

export const SessionModelRefV2Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  NativeSessionModelRefV2Schema,
  AccountProviderConnectionSessionModelRefV2Schema,
  TeamResourceSessionModelRefV2Schema,
]));
export type SessionModelRefV2 = z.infer<typeof SessionModelRefV2Schema>;

/** Ref-only consumers accept the same source variants as the Session launch carrier. */
export const SessionModelRefSchema = lazyZodSchema(() => z.union([
  SessionModelRefV2Schema, ProviderBoundModelRefSchema,
]));
export type SessionModelRef = z.infer<typeof SessionModelRefSchema>;

const SessionModelSelectionV2BaseShape = {
  v: z.literal(2),
  updatedAt: z.number().check(z.nonnegative()),
} as const;

export const TeamResourceSessionModelSelectionV2Schema = lazyZodSchema(() => z.strictObject({
  ...SessionModelSelectionV2BaseShape,
  ref: TeamResourceSessionModelRefV2Schema,
}));

export const SessionModelSelectionV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ...SessionModelSelectionV2BaseShape,
    ref: NativeSessionModelRefV2Schema,
  }),
  z.strictObject({
    ...SessionModelSelectionV2BaseShape,
    ref: AccountProviderConnectionSessionModelRefV2Schema,
  }),
  TeamResourceSessionModelSelectionV2Schema,
]));
export type SessionModelSelectionV2 = z.infer<typeof SessionModelSelectionV2Schema>;

/** Current Session launch carrier; retained V1 inputs keep their original source. */
export const SessionModelSelectionSchema = lazyZodSchema(() => z.union([
  SessionModelSelectionV2Schema, SessionModelSelectionV1Schema,
]));
export type SessionModelSelection = z.infer<typeof SessionModelSelectionSchema>;
