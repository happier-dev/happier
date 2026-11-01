import { lazyZodSchema } from '../lazyZodSchema.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { z } from 'zod/mini';

import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
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
} from './qualifiedConnectedAccountProjectionsV4.js';
import { QualifiedConnectedAccountRefSchema, ConnectedAccountServiceIdentityV1Schema, ConnectedAccountSourceCustodyV1Schema } from './qualifiedConnectedAccountPersistence.js';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from './connectedServiceBindings.js';
import { ConnectedServiceCredentialRevisionV1Schema } from './connectedServiceSchemas.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { SharedSavedSecretReferenceSelectionV1Schema } from '../account/settings/savedSecretReferenceV1.js';

import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../machines/managed/managedDependencyV1.js';

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
          Omit<ReadonlyArrayProperties<TConfiguration>, 'values'> & {
            readonly values: Readonly<Record<string, JsonValue>>;
          };
      }
    : ReadonlyArrayProperties<T>;

export const CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD =
  'daemon.connectedAccounts.authentication.command';
export const CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD =
  'daemon.connectedAccounts.control.command';

const BoundedIdentitySchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const ExpectedConfigurationRevisionSchema =
  lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const BuiltInLegacyConnectedAccountOperations = new Set<string>(
  Object.values(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  ).flatMap((compatibility) => [
    ...compatibility.peerOperations.exactV0_2_1,
    ...compatibility.peerOperations.revisionedV2V3,
  ]),
);
const BuiltInLegacyConnectedAccountOperationSchema =
  lazyZodSchema(() => z.pipe(BoundedIdentitySchema, z.custom<BuiltInLegacyConnectedAccountOperation, string>((operation) =>
      typeof operation === 'string' && BuiltInLegacyConnectedAccountOperations.has(operation),
      'Unknown built-in legacy Connected Account operation')));
const ManualFieldsSchema = lazyZodSchema(() => z.record(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  z.string().check(z.maxLength(64 * 1024)),
).check(z.superRefine((fields, context) => {
  if (Object.keys(fields).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account manual fields exceed the bounded field count',
    });
  }
})));
const ConfigurationValuesSchema = lazyZodSchema(() => z.record(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  PluginJsonValueV2Schema,
).check(z.superRefine((values, context) => {
  if (Object.keys(values).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account configuration values exceed the bounded field count',
    });
  }
})));
const SecretValuesSchema = lazyZodSchema(() => z.record(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  z.string().check(z.minLength(1), z.maxLength(64 * 1024)),
).check(z.superRefine((values, context) => {
  if (Object.keys(values).length > 64) {
    context.addIssue({
      code: 'custom',
      message:
        'Connected-account secret replacements exceed the bounded field count',
    });
  }
})));

/** Exact command schemas shared by daemon ingress and its admitted Actions. */
export const ConnectedAccountAuthenticationCommandSchemas = {
    beginConnect: lazyZodSchema(() => z.strictObject({
      operation: z.literal('beginConnect'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      modeId: BoundedIdentitySchema,
      expectedConfigurationRevision:
        z.optional(ExpectedConfigurationRevisionSchema),
    })),
    beginReconnect: lazyZodSchema(() => z.strictObject({
      operation: z.literal('beginReconnect'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      expectedConfigurationRevision:
        z.optional(ExpectedConfigurationRevisionSchema),
    })),
    continueConnect: lazyZodSchema(() => z.strictObject({
      operation: z.literal('continueConnect'),
      attemptId: BoundedIdentitySchema,
      expectedConfigurationRevision:
        z.optional(ExpectedConfigurationRevisionSchema),
    })),
    submitManual: lazyZodSchema(() => z.strictObject({
      operation: z.literal('submitManual'),
      attemptId: BoundedIdentitySchema,
      fields: ManualFieldsSchema,
      selectedSecrets: z.optional(z.record(z.string(), SharedSavedSecretReferenceSelectionV1Schema)),
    })),
    completeOAuth: lazyZodSchema(() => z.strictObject({
      operation: z.literal('completeOAuth'),
      attemptId: BoundedIdentitySchema,
      completion: z.strictObject({
        code: z.string().check(z.minLength(1), z.maxLength(32 * 1024)),
        callbackUrl: z.url().check(z.maxLength(2_048)),
        state: z.string().check(z.minLength(1), z.maxLength(4_096)),
        iss: z.optional(z.string()),
      }),
    })),
    pollDevice: lazyZodSchema(() => z.strictObject({
      operation: z.literal('pollDevice'),
      attemptId: BoundedIdentitySchema,
    })),
    resumeDevice: lazyZodSchema(() => z.strictObject({
      operation: z.literal('resumeDevice'),
      attemptId: BoundedIdentitySchema,
    })),
    reconcile: lazyZodSchema(() => z.strictObject({
      operation: z.literal('reconcile'),
      attemptId: BoundedIdentitySchema,
    })),
    cancel: lazyZodSchema(() => z.strictObject({
      operation: z.literal('cancel'),
      attemptId: BoundedIdentitySchema,
    })),
    read: lazyZodSchema(() => z.strictObject({
      operation: z.literal('read'),
      attemptId: BoundedIdentitySchema,
      waitForProviderStart: z.optional(z.boolean()),
    })),
} as const;
export const ConnectedAccountDaemonCommandSchema =
  lazyZodSchema(() => z.discriminatedUnion('operation', [
    ConnectedAccountAuthenticationCommandSchemas.beginConnect,
    ConnectedAccountAuthenticationCommandSchemas.beginReconnect,
    ConnectedAccountAuthenticationCommandSchemas.continueConnect,
    ConnectedAccountAuthenticationCommandSchemas.submitManual,
    ConnectedAccountAuthenticationCommandSchemas.completeOAuth,
    ConnectedAccountAuthenticationCommandSchemas.pollDevice,
    ConnectedAccountAuthenticationCommandSchemas.resumeDevice,
    ConnectedAccountAuthenticationCommandSchemas.reconcile,
    ConnectedAccountAuthenticationCommandSchemas.cancel,
    ConnectedAccountAuthenticationCommandSchemas.read,
  ]));
export type ConnectedAccountDaemonCommand =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountDaemonCommandSchema>
  >;

export const ConnectedAccountAuthenticationCommandRequestSchema =
  lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: BoundedIdentitySchema,
    command: ConnectedAccountDaemonCommandSchema,
  }));
export type ConnectedAccountAuthenticationCommandRequest =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountAuthenticationCommandRequestSchema>
  >;

export const ConnectedAccountControlTargetSchema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('service'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }),
    z.strictObject({
      kind: z.literal('account'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    }),
    z.strictObject({
      kind: z.literal('attempt'),
      attemptId: BoundedIdentitySchema,
    }),
  ]));
export type ConnectedAccountControlTarget =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountControlTargetSchema>
  >;

export const ConnectedAccountPeerOperationTransportSchema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('v4'),
    }),
    z.strictObject({
      kind: z.literal('legacy'),
      peerClass: z.enum(['exact_v0_2_1', 'revisioned_v2_v3']),
      serviceId: ConnectedServiceIdSchema,
    }),
  ]));
export type ConnectedAccountPeerOperationTransport =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountPeerOperationTransportSchema>
  >;

export const ConnectedAccountRevokeCommandV1Schema = lazyZodSchema(() => z.strictObject({
  operation: z.literal('revokeAccount'),
  account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  expectedCredentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
  cleanupGroupReferences: z.boolean(),
  emergencyRevoke: z.optional(z.boolean()),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));

export const ConnectedAccountDaemonControlCommandSchema =
  lazyZodSchema(() => z.discriminatedUnion('operation', [
    z.strictObject({
      operation: z.literal('listPendingAttempts'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
    }),
    z.strictObject({
      operation: z.literal('describeService'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      requiredOperation:
        z.optional(BuiltInLegacyConnectedAccountOperationSchema),
    }),
    z.strictObject({
      operation: z.literal('readConfiguration'),
      target: ConnectedAccountControlTargetSchema,
    }),
    z.strictObject({
      operation: z.literal('replaceConfiguration'),
      target: ConnectedAccountControlTargetSchema,
      expectedRevision: z.nullable(ExpectedConfigurationRevisionSchema),
      values: ConfigurationValuesSchema,
      secretValues: SecretValuesSchema,
    }),
    ConnectedAccountRevokeCommandV1Schema,
  ]));
export type ConnectedAccountDaemonControlCommand =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountDaemonControlCommandSchema>
  >;

export const ConnectedAccountControlCommandRequestSchema =
  lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: BoundedIdentitySchema,
    command: ConnectedAccountDaemonControlCommandSchema,
  }));
export type ConnectedAccountControlCommandRequest =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountControlCommandRequestSchema>
  >;

export const ConnectedAccountConfigurationTargetSchema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('service'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }),
    z.strictObject({
      kind: z.literal('account'),
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
      modeId: BoundedIdentitySchema,
    }),
    z.strictObject({
      kind: z.literal('attempt'),
      attemptId: BoundedIdentitySchema,
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      modeId: BoundedIdentitySchema,
    }),
  ]));
export type ConnectedAccountConfigurationTarget =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountConfigurationTargetSchema>
  >;

export const ConnectedAccountAttemptResponseSchema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('starting'),
      attemptId: BoundedIdentitySchema,
    }),
    z.strictObject({
      status: z.literal('awaitingManual'),
      attemptId: BoundedIdentitySchema,
    }),
    z.strictObject({
      status: z.literal('awaitingOAuth'),
      attemptId: BoundedIdentitySchema,
      authorizationUrl: z.optional(z.url().check(z.maxLength(8_192))),
      callbackUrl: z.url().check(z.maxLength(2_048)),
      expiresAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    }),
    z.strictObject({
      status: z.literal('awaitingDeviceAuthorization'),
      attemptId: BoundedIdentitySchema,
      verificationUri: z.optional(z.url().check(z.maxLength(8_192))),
      verificationUriComplete: z.optional(z.url().check(z.maxLength(8_192))),
      userCode: z.optional(z.string().check(z.minLength(1), z.maxLength(4_096))),
      expiresAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
      pollIntervalMs:
        z.optional(z.number().check(z.int(), z.positive(), z.maximum(3_600_000))),
    }),
    z.strictObject({
      status: z.literal('configurationRequired'),
      attemptId: z.optional(BoundedIdentitySchema),
      target: ConnectedAccountConfigurationTargetSchema,
      missingFieldIds: z.array(BoundedIdentitySchema).check(z.maxLength(64)),
    }),
    z.strictObject({
      status: z.literal('pending'),
      attemptId: BoundedIdentitySchema,
      retryAfterMs: z.number().check(z.int(), z.positive(), z.maximum(3_600_000)),
    }),
    z.strictObject({
      status: z.literal('outcomeUnknown'),
      attemptId: BoundedIdentitySchema,
      diagnostic: z.unknown(),
    }),
    z.strictObject({
      status: z.literal('reconnectRequired'),
      attemptId: BoundedIdentitySchema,
      code: BoundedIdentitySchema,
    }),
    z.strictObject({
      status: z.literal('connected'),
      attemptId: BoundedIdentitySchema,
      account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    }),
    z.strictObject({
      status: z.literal('cancelled'),
      attemptId: BoundedIdentitySchema,
    }),
    z.strictObject({
      status: z.literal('cleanupPending'),
      attemptId: BoundedIdentitySchema,
      code: z.literal('connected_account_attempt_cleanup_pending'),
    }),
    z.strictObject({
      status: z.literal('rejected'),
      attemptId: z.optional(BoundedIdentitySchema),
      code: BoundedIdentitySchema,
      diagnostic: z.optional(z.unknown()),
      failureClass: z.optional(z.literal('rateLimit')),
      retryNotBeforeMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      attemptId: z.optional(BoundedIdentitySchema),
      code: BoundedIdentitySchema,
      diagnostic: z.optional(z.unknown()),
      failureClass: z.optional(z.literal('rateLimit')),
      retryNotBeforeMs: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
    }),
    z.strictObject({
      status: z.literal('conflict'),
      attemptId: z.optional(BoundedIdentitySchema),
      code: BoundedIdentitySchema,
      diagnostic: z.optional(z.unknown()),
    }),
  ]).check(z.superRefine((value, context) => {
    if ((value.status === 'rejected' || value.status === 'unavailable')
      && value.retryNotBeforeMs !== undefined
      && value.failureClass !== 'rateLimit') {
      context.addIssue({
        code: 'custom',
        path: ['retryNotBeforeMs'],
        message: 'retryNotBeforeMs requires rate-limit failure evidence',
      });
    }
  })));
export type ConnectedAccountAttemptResponse =
  ReadonlyArrayProperties<
    z.infer<typeof ConnectedAccountAttemptResponseSchema>
  >;

const ConnectedAccountConfigurationControlViewSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'configurationRequired']),
  revision: z.nullable(ExpectedConfigurationRevisionSchema),
  values: ConfigurationValuesSchema,
  configuredSecretFieldIds: z.array(BoundedIdentitySchema).check(z.maxLength(64)),
  missingFieldIds: z.array(BoundedIdentitySchema).check(z.maxLength(64)),
}));

export const ConnectedAccountRevokedResponseV1Schema = lazyZodSchema(() => z.strictObject({
    status: z.literal('revoked'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    remoteStatus: z.enum(['remoteRevoked', 'remoteUnsupported', 'remoteNotAttempted']),
  }));

export const ConnectedAccountRevokeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('conflict'), code: BoundedIdentitySchema }),
  z.strictObject({ status: z.literal('unavailable'), code: BoundedIdentitySchema }),
  ConnectedAccountRevokedResponseV1Schema,
  z.strictObject({
    status: z.literal('removalReviewRequired'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
    resources: z.array(ManagedResourceDependencyV1Schema),
  }),
  z.strictObject({
    status: z.literal('outcomeUnknown'),
    account: asProtocolZod(QualifiedConnectedAccountRefSchema),
  }),
]));

export const ConnectedAccountPendingAttemptsResponseSchema = lazyZodSchema(() => z.strictObject({
      status: z.literal('pendingAttempts'),
      attempts: z.array(z.strictObject({
        attemptId: BoundedIdentitySchema,
        kind: z.enum(['manual', 'oauth', 'device']),
        modeId: BoundedIdentitySchema,
        intent: z.enum(['connect', 'reconnect']),
        phase: z.enum(['configurationRequired', 'awaitingManual', 'awaitingOAuth', 'awaitingDeviceAuthorization', 'outcomeUnknown']),
        createdAtMs: z.number().check(z.int(), z.nonnegative()),
        expiresAtMs: z.number().check(z.int(), z.positive()),
      })),
    }));

export const ConnectedAccountDaemonControlResponseSchema =
  lazyZodSchema(() => z.discriminatedUnion('status', [
    ConnectedAccountPendingAttemptsResponseSchema,
    z.strictObject({
      status: z.literal('described'),
      service: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
      descriptor: PluginConnectedAccountDescriptorContributionV2Schema,
      occurrenceId: BoundedIdentitySchema,
      sourceCustody: ConnectedAccountSourceCustodyV1Schema,
      // Relayed from the same server list as the V4 accounts response, which is
      // bounded at its writer rather than in the projection it produces.
      accounts: z.array(QualifiedConnectedAccountProfileV4Schema),
      operationTransport:
        z.optional(ConnectedAccountPeerOperationTransportSchema),
    }),
    z.strictObject({
      status: z.literal('configuration'),
      target: ConnectedAccountConfigurationTargetSchema,
      mode: PluginConnectedAccountAuthenticationModeV2Schema,
      occurrenceId: BoundedIdentitySchema,
      sourceCustody: ConnectedAccountSourceCustodyV1Schema,
      configuration: ConnectedAccountConfigurationControlViewSchema,
    }),
    z.strictObject({
      status: z.literal('configurationCommitted'),
      target: ConnectedAccountConfigurationTargetSchema,
      mode: PluginConnectedAccountAuthenticationModeV2Schema,
      occurrenceId: BoundedIdentitySchema,
      sourceCustody: ConnectedAccountSourceCustodyV1Schema,
      configuration: ConnectedAccountConfigurationControlViewSchema,
    }),
    ...ConnectedAccountRevokeResponseV1Schema._zod.def.options,
  ]));
export type ConnectedAccountDaemonControlResponse =
  ReadonlyControlResponse<
    z.infer<typeof ConnectedAccountDaemonControlResponseSchema>
  >;

export type ConnectedAccountExpectedOperationTransport =
  | Readonly<{ kind: 'v4' }>
  | Readonly<{ kind: 'legacy'; serviceId: ConnectedServiceId }>;

/** Shared admission for quota readers, refreshers and Action callers. */
export function assertConnectedAccountOperationTransportV1(
  result: ConnectedAccountDaemonControlResponse,
  service: PluginContributionIdentityV1,
  expectedTransport: ConnectedAccountExpectedOperationTransport,
): void {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  if (result.status !== 'described') {
    return fail(result.status === 'unavailable' || result.status === 'conflict'
      ? result.code : 'connected_account_peer_operation_admission_unavailable');
  }
  const unsupported = expectedTransport.kind === 'v4'
    ? 'connected_account_v4_operation_unsupported' : 'connected_account_legacy_operation_unsupported';
  if (result.service.pluginId !== service.pluginId || result.service.localId !== service.localId) fail(unsupported);
  if (expectedTransport.kind === 'v4') {
    if (result.operationTransport?.kind !== 'v4') fail(unsupported);
    return;
  }
  if (result.operationTransport?.kind !== 'legacy'
    || result.operationTransport.peerClass !== 'revisioned_v2_v3'
    || result.operationTransport.serviceId !== expectedTransport.serviceId) fail(unsupported);
}
