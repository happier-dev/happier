import { z } from 'zod';

import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import {
  PluginJsonValueV2Schema,
} from '../plugins/contributions/publicTypes.js';
import {
  PluginConnectedAccountAuthenticationModeV2Schema,
  PluginConnectedAccountDescriptorContributionV2Schema,
} from './pluginConnectedAccountAuthenticationV2.js';
import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  type BuiltInLegacyConnectedAccountOperation,
} from './generatedBuiltInLegacyConnectedAccountCompatibility.js';
import {
  QualifiedConnectedAccountProfileV4Schema,
  QualifiedConnectedAccountRefSchema,
} from './qualifiedConnectedAccountsV4.js';
import { ConnectedServiceIdSchema } from './connectedServiceBindings.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

type ReadonlyArrayProperties<T> = T extends object
  ? {
      readonly [TKey in keyof T]:
        T[TKey] extends (infer TItem)[]
          ? readonly TItem[]
          : T[TKey];
    }
  : T;

type ReadonlyControlResponse<T> =
  T extends { configuration: infer TConfiguration }
    ? Omit<ReadonlyArrayProperties<T>, 'configuration'> & {
        readonly configuration:
          ReadonlyArrayProperties<TConfiguration>;
      }
    : ReadonlyArrayProperties<T>;

export const CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD =
  'daemon.connectedAccounts.authentication.command';
export const CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD =
  'daemon.connectedAccounts.control.command';

const BoundedIdentitySchema = z.string().trim().min(1).max(256);
const ExpectedConfigurationRevisionSchema =
  z.string().trim().min(1).max(256);
const BuiltInLegacyConnectedAccountOperations = new Set<string>(
  Object.values(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  ).flatMap((compatibility) => [
    ...compatibility.peerOperations.exactV0_2_1,
    ...compatibility.peerOperations.revisionedV2V3,
  ]),
);
const BuiltInLegacyConnectedAccountOperationSchema =
  BoundedIdentitySchema.refine(
    (operation): operation is BuiltInLegacyConnectedAccountOperation =>
      BuiltInLegacyConnectedAccountOperations.has(operation),
    'Unknown built-in legacy Connected Account operation',
  );
const ManualFieldsSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().max(64 * 1024),
).superRefine((fields, context) => {
  if (Object.keys(fields).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account manual fields exceed the bounded field count',
    });
  }
});
const ConfigurationValuesSchema = z.record(
  z.string().trim().min(1).max(128),
  PluginJsonValueV2Schema,
).superRefine((values, context) => {
  if (Object.keys(values).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account configuration values exceed the bounded field count',
    });
  }
});
const SecretValuesSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().min(1).max(64 * 1024),
).superRefine((values, context) => {
  if (Object.keys(values).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account secret replacements exceed the bounded field count',
    });
  }
});

export const ConnectedAccountDaemonCommandSchema =
  z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('beginConnect'),
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      modeId: BoundedIdentitySchema,
      expectedConfigurationRevision:
        ExpectedConfigurationRevisionSchema.optional(),
    }).strict(),
    z.object({
      operation: z.literal('beginReconnect'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      expectedConfigurationRevision:
        ExpectedConfigurationRevisionSchema.optional(),
    }).strict(),
    z.object({
      operation: z.literal('continueConnect'),
      attemptId: BoundedIdentitySchema,
      expectedConfigurationRevision:
        ExpectedConfigurationRevisionSchema.optional(),
    }).strict(),
    z.object({
      operation: z.literal('submitManual'),
      attemptId: BoundedIdentitySchema,
      fields: ManualFieldsSchema,
    }).strict(),
    z.object({
      operation: z.literal('completeOAuth'),
      attemptId: BoundedIdentitySchema,
      completion: z.object({
        code: z.string().min(1).max(32 * 1024),
        callbackUrl: z.url().max(2_048),
        state: z.string().min(1).max(4_096),
      }).strict(),
    }).strict(),
    z.object({
      operation: z.literal('pollDevice'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      operation: z.literal('resumeDevice'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      operation: z.literal('reconcile'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      operation: z.literal('cancel'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      operation: z.literal('read'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
  ]);
export type ConnectedAccountDaemonCommand =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountDaemonCommandSchema>
  >;

export const ConnectedAccountAuthenticationCommandRequestSchema =
  z.object({
    v: z.literal(1),
    machineId: BoundedIdentitySchema,
    command: ConnectedAccountDaemonCommandSchema,
  }).strict();
export type ConnectedAccountAuthenticationCommandRequest =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountAuthenticationCommandRequestSchema>
  >;

export const ConnectedAccountControlTargetSchema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('service'),
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      kind: z.literal('account'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    }).strict(),
    z.object({
      kind: z.literal('attempt'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
  ]);
export type ConnectedAccountControlTarget =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountControlTargetSchema>
  >;

export const ConnectedAccountPeerOperationTransportSchema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('v4'),
    }).strict(),
    z.object({
      kind: z.literal('legacy'),
      peerClass: z.enum(['exact_v0_2_1', 'revisioned_v2_v3']),
      serviceId: ConnectedServiceIdSchema,
    }).strict(),
  ]);
export type ConnectedAccountPeerOperationTransport =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountPeerOperationTransportSchema>
  >;

export const ConnectedAccountDaemonControlCommandSchema =
  z.discriminatedUnion('operation', [
    z.object({
      operation: z.literal('describeService'),
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      requiredOperation:
        BuiltInLegacyConnectedAccountOperationSchema.optional(),
    }).strict(),
    z.object({
      operation: z.literal('readConfiguration'),
      target: ConnectedAccountControlTargetSchema,
    }).strict(),
    z.object({
      operation: z.literal('replaceConfiguration'),
      target: ConnectedAccountControlTargetSchema,
      expectedRevision: ExpectedConfigurationRevisionSchema.nullable(),
      values: ConfigurationValuesSchema,
      secretValues: SecretValuesSchema,
    }).strict(),
    z.object({
      operation: z.literal('revokeAccount'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      cleanupGroupReferences: z.boolean(),
    }).strict(),
  ]);
export type ConnectedAccountDaemonControlCommand =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountDaemonControlCommandSchema>
  >;

export const ConnectedAccountControlCommandRequestSchema =
  z.object({
    v: z.literal(1),
    machineId: BoundedIdentitySchema,
    command: ConnectedAccountDaemonControlCommandSchema,
  }).strict();
export type ConnectedAccountControlCommandRequest =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountControlCommandRequestSchema>
  >;

export const ConnectedAccountConfigurationTargetSchema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('service'),
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      kind: z.literal('account'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      modeId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      kind: z.literal('attempt'),
      attemptId: BoundedIdentitySchema,
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }).strict(),
  ]);
export type ConnectedAccountConfigurationTarget =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountConfigurationTargetSchema>
  >;

export const ConnectedAccountAttemptResponseSchema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('starting'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('awaitingManual'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('awaitingOAuth'),
      attemptId: BoundedIdentitySchema,
      authorizationUrl: z.url().max(8_192).optional(),
      callbackUrl: z.url().max(2_048),
      expiresAtMs: z.number().int().nonnegative().optional(),
    }).strict(),
    z.object({
      status: z.literal('awaitingDeviceAuthorization'),
      attemptId: BoundedIdentitySchema,
      verificationUri: z.url().max(8_192).optional(),
      verificationUriComplete: z.url().max(8_192).optional(),
      userCode: z.string().min(1).max(4_096).optional(),
      expiresAtMs: z.number().int().nonnegative().optional(),
      pollIntervalMs:
        z.number().int().positive().max(3_600_000).optional(),
    }).strict(),
    z.object({
      status: z.literal('configurationRequired'),
      attemptId: BoundedIdentitySchema.optional(),
      target: ConnectedAccountConfigurationTargetSchema,
      missingFieldIds: z.array(BoundedIdentitySchema).max(64),
    }).strict(),
    z.object({
      status: z.literal('pending'),
      attemptId: BoundedIdentitySchema,
      retryAfterMs: z.number().int().positive().max(3_600_000),
    }).strict(),
    z.object({
      status: z.literal('outcomeUnknown'),
      attemptId: BoundedIdentitySchema,
      diagnostic: z.unknown(),
    }).strict(),
    z.object({
      status: z.literal('reconnectRequired'),
      attemptId: BoundedIdentitySchema,
      code: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('connected'),
      attemptId: BoundedIdentitySchema,
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    }).strict(),
    z.object({
      status: z.literal('cancelled'),
      attemptId: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('cleanupPending'),
      attemptId: BoundedIdentitySchema,
      code: z.literal('connected_account_attempt_cleanup_pending'),
    }).strict(),
    z.object({
      status: z.literal('rejected'),
      attemptId: BoundedIdentitySchema.optional(),
      code: BoundedIdentitySchema,
      diagnostic: z.unknown().optional(),
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      attemptId: BoundedIdentitySchema.optional(),
      code: BoundedIdentitySchema,
      diagnostic: z.unknown().optional(),
    }).strict(),
    z.object({
      status: z.literal('conflict'),
      attemptId: BoundedIdentitySchema.optional(),
      code: BoundedIdentitySchema,
      diagnostic: z.unknown().optional(),
    }).strict(),
  ]);
export type ConnectedAccountAttemptResponse =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountAttemptResponseSchema>
  >;

const ConnectedAccountConfigurationControlViewSchema = z.object({
  status: z.enum(['ready', 'configurationRequired']),
  revision: ExpectedConfigurationRevisionSchema.nullable(),
  values: ConfigurationValuesSchema,
  configuredSecretFieldIds: z.array(BoundedIdentitySchema).max(64),
  missingFieldIds: z.array(BoundedIdentitySchema).max(64),
}).strict();

export const ConnectedAccountDaemonControlResponseSchema =
  z.discriminatedUnion('status', [
    z.object({
      status: z.literal('described'),
      service: asProtocolZod(PluginContributionIdentityV1Schema),
      descriptor: PluginConnectedAccountDescriptorContributionV2Schema,
      generation: BoundedIdentitySchema,
      immutableGenerationId: z.string().min(1).max(512),
      // Relayed from the same server list as the V4 accounts response, which is
      // bounded at its writer rather than in the projection it produces.
      accounts: z.array(QualifiedConnectedAccountProfileV4Schema),
      operationTransport:
        ConnectedAccountPeerOperationTransportSchema.optional(),
    }).strict(),
    z.object({
      status: z.literal('configuration'),
      target: ConnectedAccountConfigurationTargetSchema,
      mode: PluginConnectedAccountAuthenticationModeV2Schema,
      generation: BoundedIdentitySchema,
      immutableGenerationId: z.string().min(1).max(512),
      configuration: ConnectedAccountConfigurationControlViewSchema,
    }).strict(),
    z.object({
      status: z.literal('configurationCommitted'),
      target: ConnectedAccountConfigurationTargetSchema,
      mode: PluginConnectedAccountAuthenticationModeV2Schema,
      generation: BoundedIdentitySchema,
      immutableGenerationId: z.string().min(1).max(512),
      configuration: ConnectedAccountConfigurationControlViewSchema,
    }).strict(),
    z.object({
      status: z.literal('conflict'),
      code: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('unavailable'),
      code: BoundedIdentitySchema,
    }).strict(),
    z.object({
      status: z.literal('revoked'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      remoteStatus: z.enum([
        'remoteRevoked',
        'remoteUnsupported',
      ]),
    }).strict(),
    z.object({
      status: z.literal('outcomeUnknown'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    }).strict(),
  ]);
export type ConnectedAccountDaemonControlResponse =
  ReadonlyControlResponse<
    z.infer<typeof ConnectedAccountDaemonControlResponseSchema>
  >;
