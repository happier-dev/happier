import { sameStrictJsonValue as isDeepStrictEqual } from '@happier-dev/protocol/json/strictJsonValue';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { ConnectedAccountSourceCustodyV1Schema, connectedAccountSourceCustodyV1Equal } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { QualifiedConnectedAccountAuthenticationProvenanceV4Schema, QualifiedConnectedAccountProviderIdentityV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import { z } from 'zod/mini';

import {
  CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS,
  ConnectedAccountAttemptTransactionApiError,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionScope,
  type ConnectedAccountAttemptTransactionStoreApi,
} from './attemptTransactionApi.js';
import type { PkceCodes } from './pkce.js';
import type {
  ConnectedAccountAttemptAddressOwner,
  ConnectedAccountAttemptAddressSnapshot,
  ConnectedAccountDeviceTransactionSnapshot,
  ConnectedAccountOAuthCallbackCompletion,
  ConnectedAccountOAuthTransaction,
  ConnectedAccountOAuthTransactionOwner,
  ConnectedAccountOAuthTransactionSnapshot,
  ConnectedAccountDeviceTransactionOwner,
} from './authenticationAttemptOwner.js';

const BoundedIdSchema = z.string().check(z.minLength(1), z.maxLength(256));
const SafeTimestampSchema = z.number().check(z.int(), z.nonnegative());
const ServiceSchema = z.strictObject({
  pluginId: BoundedIdSchema,
  localId: BoundedIdSchema,
});
const AccountSchema = z.strictObject({
  service: ServiceSchema,
  accountId: BoundedIdSchema,
});
const StagedCredentialsSchema = z.record(
  z.string().check(z.minLength(1), z.maxLength(128)),
  z.string(),
);
const PreparedSettlementShape = {
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  accountId: BoundedIdSchema,
  authenticationModeId: BoundedIdSchema,
  directExportContract: z.optional(z.nullable(z.literal(CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1))),
  expectedCredentialRevision: z.nullable(z.string().check(z.maxLength(4_096))),
  expectedCredentialConfigurationRevision:
    z.nullable(z.string().check(z.minLength(1), z.maxLength(4_096))),
  expectedConfigurationRevision: z.string().check(z.minLength(1), z.maxLength(4_096)),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.optional(z.unknown()),
  providerIdentity: z.optional(QualifiedConnectedAccountProviderIdentityV4Schema),
  authenticationProvenance: z.optional(QualifiedConnectedAccountAuthenticationProvenanceV4Schema),
  displayName: z.string().check(z.maxLength(4_096)),
  scopes: z.array(z.string().check(z.maxLength(4_096))).check(z.maxLength(256)),
} as const;
const PreparedSettlementSchema = z.strictObject({
  ...PreparedSettlementShape,
  sourceCustody: ConnectedAccountSourceCustodyV1Schema,
});
const SnapshotCommonShape = {
  attemptId: BoundedIdSchema,
  createdAtMs: SafeTimestampSchema,
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  account: z.optional(AccountSchema),
  modeId: BoundedIdSchema,
  expectedCredentialRevision: z.nullable(z.string().check(z.maxLength(4_096))),
  expectedCredentialConfigurationRevision:
    z.nullable(z.string().check(z.minLength(1), z.maxLength(4_096))),
  expectedConfigurationRevision: z.string().check(z.minLength(1), z.maxLength(4_096)),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.optional(z.unknown()),
} as const;
const SnapshotBaseShape = {
  ...SnapshotCommonShape,
  sourceCustody: ConnectedAccountSourceCustodyV1Schema,
  preparedSettlement: z.optional(PreparedSettlementSchema),
} as const;
const OAuthSnapshotSchema = z.strictObject({
  ...SnapshotBaseShape,
  phase: z.enum(['starting', 'awaitingOAuth', 'outcomeUnknown']),
  authorizationUrl: z.optional(z.string().check(z.minLength(1))),
  issuer: z.optional(z.string().check(z.minLength(1))),
  issuerResponseParameterRequired: z.optional(z.boolean()),
  expiresAtMs: z.optional(SafeTimestampSchema),
});
const DeviceSnapshotSchema = z.strictObject({
  ...SnapshotBaseShape,
  expiresAtMs: SafeTimestampSchema,
  pollIntervalMs: z.number().check(z.int(), z.positive()),
  nextPollAtMs: SafeTimestampSchema,
  verificationUri: z.string().check(z.minLength(1)),
  verificationUriComplete: z.optional(z.string().check(z.minLength(1))),
  userCode: z.string().check(z.minLength(1)),
});
const OAuthPayloadSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal('oauth'),
  snapshot: OAuthSnapshotSchema,
  state: z.string().check(z.minLength(32), z.maxLength(4_096)),
  challenge: z.string().check(z.minLength(32), z.maxLength(256)),
  verifier: z.string().check(z.minLength(43), z.maxLength(128)),
  callbackUrl: z.string().check(z.minLength(1)),
  consumed: z.boolean(),
});
const DevicePayloadSchema = z.strictObject({
  version: z.literal(2),
  kind: z.literal('device'),
  snapshot: DeviceSnapshotSchema,
});
type OAuthPayload = z.infer<typeof OAuthPayloadSchema>;
type DevicePayload = z.infer<typeof DevicePayloadSchema>;

function sameService(
  left: ConnectedAccountOAuthTransactionSnapshot['service'],
  right: ConnectedAccountOAuthTransactionSnapshot['service'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameAccount(
  left: ConnectedAccountOAuthTransactionSnapshot['account'],
  right: ConnectedAccountOAuthTransactionSnapshot['account'],
): boolean {
  if (!left || !right) return left === right;
  return sameQualifiedConnectedAccountRef(left, right);
}

function sameSnapshotIdentity(
  left: ConnectedAccountOAuthTransactionSnapshot | ConnectedAccountDeviceTransactionSnapshot,
  right:
    | ConnectedAccountOAuthTransactionSnapshot
    | ConnectedAccountDeviceTransactionSnapshot,
): boolean {
  return left.attemptId === right.attemptId
    && left.createdAtMs === right.createdAtMs
    && left.intent === right.intent
    && sameService(left.service, right.service)
    && sameAccount(left.account, right.account)
    && left.modeId === right.modeId
    && connectedAccountSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody)
    && left.expectedCredentialRevision === right.expectedCredentialRevision
    && left.expectedCredentialConfigurationRevision
      === right.expectedCredentialConfigurationRevision
    && left.expectedConfigurationRevision === right.expectedConfigurationRevision
    && (isDeepStrictEqual(
      left.stagedAccountConfigurationContent,
      right.stagedAccountConfigurationContent,
    ) || (left.sourceCustody.kind === 'host' && 'phase' in left && left.phase === 'starting'));
}

function assertOAuthSnapshotAdvance(
  current: ConnectedAccountOAuthTransactionSnapshot,
  next: ConnectedAccountOAuthTransactionSnapshot,
): void {
  const phaseRank: Readonly<
    Record<ConnectedAccountOAuthTransactionSnapshot['phase'], number>
  > = {
    starting: 0,
    awaitingOAuth: 1,
    outcomeUnknown: 2,
  };
  if (
    !sameSnapshotIdentity(current, next)
    || phaseRank[next.phase] < phaseRank[current.phase]
    || (
      current.authorizationUrl !== undefined
      && current.authorizationUrl !== next.authorizationUrl
    )
    || (current.issuer !== undefined && current.issuer !== next.issuer)
    || (current.issuerResponseParameterRequired !== undefined
      && current.issuerResponseParameterRequired !== next.issuerResponseParameterRequired)
    || (
      current.preparedSettlement !== undefined
      && !isDeepStrictEqual(current.preparedSettlement, next.preparedSettlement)
    )
  ) {
    throw new Error(
      'Connected-account OAuth transaction acknowledgement is invalid',
    );
  }
}

function assertDeviceSnapshotAdvance(
  current: ConnectedAccountDeviceTransactionSnapshot,
  next: ConnectedAccountDeviceTransactionSnapshot,
): void {
  if (
    !sameSnapshotIdentity(current, next)
    || current.expiresAtMs !== next.expiresAtMs
    || current.verificationUri !== next.verificationUri
    || current.verificationUriComplete !== next.verificationUriComplete
    || current.userCode !== next.userCode
    || next.nextPollAtMs < current.nextPollAtMs
    || (
      current.preparedSettlement !== undefined
      && !isDeepStrictEqual(current.preparedSettlement, next.preparedSettlement)
    )
  ) {
    throw new Error(
      'Connected-account device transaction acknowledgement is invalid',
    );
  }
}

function transactionExpiresAt(input: Readonly<{
  now: number;
  providerExpiresAtMs?: number;
}>): number {
  const hostExpiry = input.now + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS;
  return input.providerExpiresAtMs === undefined
    ? hostExpiry
    : Math.min(hostExpiry, input.providerExpiresAtMs);
}

type DurableOAuthTransaction = ConnectedAccountOAuthTransaction & Required<Pick<
  ConnectedAccountOAuthTransaction, 'snapshot' | 'expiresAtMs' | 'acknowledge'
>>;

export type ConnectedAccountAttemptTransactionAdapters = Readonly<{
  address: ConnectedAccountAttemptAddressOwner;
  oauth: Readonly<{
    create(input: Parameters<ConnectedAccountOAuthTransactionOwner['create']>[0]): Promise<DurableOAuthTransaction>;
    read(...input: Parameters<NonNullable<ConnectedAccountOAuthTransactionOwner['read']>>): Promise<DurableOAuthTransaction | null>;
  }>;
  device: ConnectedAccountDeviceTransactionOwner;
  listPending: (service: ConnectedAccountAttemptTransactionScope['service']) => ReturnType<ConnectedAccountAttemptTransactionStoreApi['listPending']>;
}>;

export function createConnectedAccountAttemptTransactionAdapters(
  params: Readonly<{
    api: ConnectedAccountAttemptTransactionStoreApi;
    randomBytes: (length: number) => Uint8Array;
    generatePkceCodes: () => Promise<PkceCodes>;
    seal: (payload: unknown) => Promise<StoredJsonContentEnvelope>;
    open: (record: ConnectedAccountAttemptTransactionRecord) => Promise<unknown>;
    getMachineId?: () => string | undefined;
    now?: () => number;
  }>,
): ConnectedAccountAttemptTransactionAdapters {
  const { api, randomBytes, seal, open } = params;
  const now = params.now ?? Date.now;

  function scopeFor(
    snapshot: ConnectedAccountOAuthTransactionSnapshot | ConnectedAccountDeviceTransactionSnapshot | ConnectedAccountAttemptAddressSnapshot,
    storedScope?: ConnectedAccountAttemptTransactionScope,
  ): ConnectedAccountAttemptTransactionScope {
    const machineId = storedScope === undefined ? params.getMachineId?.() : storedScope.machineId;
    return Object.freeze({
      ...(machineId === undefined ? {} : { machineId }),
      service: snapshot.service,
      modeId: snapshot.modeId,
      intent: snapshot.intent,
      phase: 'phase' in snapshot ? snapshot.phase : 'awaitingDeviceAuthorization',
      createdAtMs: snapshot.createdAtMs,
    });
  }

  async function readOAuthPayload(input: Readonly<{
    attemptId: string;
    record: ConnectedAccountAttemptTransactionRecord;
  }>): Promise<OAuthPayload> {
    const opened = await open(input.record);
    const parsed = createStoredReadSchema(OAuthPayloadSchema).parse(opened);
    if (parsed.snapshot.attemptId !== input.attemptId) {
      throw new Error(
        'Connected-account OAuth transaction identity is invalid',
      );
    }
    return parsed;
  }

  async function readDevicePayload(input: Readonly<{
    attemptId: string;
    record: ConnectedAccountAttemptTransactionRecord;
  }>): Promise<DevicePayload> {
    const opened = await open(input.record);
    const parsed = createStoredReadSchema(DevicePayloadSchema).parse(opened);
    if (parsed.snapshot.attemptId !== input.attemptId) {
      throw new Error(
        'Connected-account device transaction identity is invalid',
      );
    }
    return parsed;
  }

  function createOAuthHandle(input: {
    payload: OAuthPayload;
    record: ConnectedAccountAttemptTransactionRecord;
  }): DurableOAuthTransaction {
    let payload = input.payload;
    let record = input.record;
    let closed = false;
    return Object.freeze({
      get expiresAtMs() {
        return record.expiresAtMs;
      },
      get snapshot() {
        return payload.snapshot;
      },
      get request() {
        return Object.freeze({
          callbackUrl: payload.callbackUrl,
          state: payload.state,
          pkce: Object.freeze({
            challenge: payload.challenge,
            method: 'S256' as const,
          }),
        });
      },
      async acknowledge(snapshot) {
        if (closed) {
          throw new Error('Connected-account OAuth transaction is closed');
        }
        assertOAuthSnapshotAdvance(payload.snapshot, snapshot);
        const nextPayload = OAuthPayloadSchema.parse({
          ...payload,
          version: 2,
          snapshot,
        });
        const nextRecord = await api.replace({
          kind: 'oauth',
          attemptId: snapshot.attemptId,
          expectedRevision: record.revision,
          content: await seal(nextPayload),
          scope: scopeFor(snapshot, record.scope),
          expiresAtMs: Math.min(
            record.expiresAtMs,
            snapshot.expiresAtMs ?? record.expiresAtMs,
          ),
        });
        payload = nextPayload;
        record = nextRecord;
      },
      async acceptCompletion(
        completion: ConnectedAccountOAuthCallbackCompletion,
      ) {
        if (
          closed
          || payload.consumed
          || completion.state !== payload.state
          || completion.callbackUrl !== payload.callbackUrl
        ) {
          throw new Error(
            'Connected-account OAuth completion does not match its transaction',
          );
        }
        const nextPayload = OAuthPayloadSchema.parse({
          ...payload,
          consumed: true,
        });
        const nextRecord = await api.replace({
          kind: 'oauth',
          attemptId: payload.snapshot.attemptId,
          expectedRevision: record.revision,
          content: await seal(nextPayload),
          scope: scopeFor(payload.snapshot, record.scope),
          expiresAtMs: record.expiresAtMs,
        });
        payload = nextPayload;
        record = nextRecord;
        return Object.freeze({
          ...completion,
          pkceVerifier: payload.verifier,
        });
      },
      async close() {
        if (closed) return;
        await api.delete({
          kind: 'oauth',
          attemptId: payload.snapshot.attemptId,
          expectedRevision: record.revision,
        });
        closed = true;
      },
    });
  }

  const oauth: ConnectedAccountAttemptTransactionAdapters['oauth'] = Object.freeze({
    async create(input) {
      if (
        input.attemptId !== input.snapshot.attemptId
        || !sameService(input.service, input.snapshot.service)
      ) {
        throw new Error(
          'Connected-account OAuth transaction identity is invalid',
        );
      }
      const current = await api.read({ attemptId: input.attemptId });
      if (current && (current.kind !== 'oauth' || current.scope.phase !== 'configurationRequired')) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_conflict');
      }
      const pkce = await params.generatePkceCodes();
      const callbackUrl = input.callbackUrl;
      const payload = OAuthPayloadSchema.parse({
        version: 2,
        kind: 'oauth',
        snapshot: input.snapshot,
        state: `${input.attemptId}.${encodeBase64(randomBytes(32), 'base64url')}`,
        challenge: pkce.challenge,
        verifier: pkce.verifier,
        callbackUrl,
        consumed: false,
      });
      const expiresAtMs = transactionExpiresAt({
        now: now(),
        ...(input.snapshot.expiresAtMs === undefined
          ? {}
          : { providerExpiresAtMs: input.snapshot.expiresAtMs }),
      });
      const candidate = {
        kind: 'oauth' as const,
        attemptId: input.attemptId,
        content: await seal(payload),
        scope: scopeFor(input.snapshot, current?.scope),
        expiresAtMs: current ? Math.min(current.expiresAtMs, expiresAtMs) : expiresAtMs,
      };
      const record = current
        ? await api.replace({ ...candidate, expectedRevision: current.revision })
        : await api.create(candidate);
      return createOAuthHandle({ payload, record });
    },
    async read(attemptId, addressedRecord) {
      const record = addressedRecord ?? await api.read({ attemptId });
      if (!record || record.kind !== 'oauth' || record.scope.phase === 'configurationRequired') return null;
      const payload = await readOAuthPayload({ attemptId, record });
      return createOAuthHandle({ payload, record });
    },
  });

  const address: ConnectedAccountAttemptAddressOwner = Object.freeze({
    async acknowledge(snapshot) {
      const current = await api.read({ attemptId: snapshot.attemptId });
      if (current && (current.kind !== snapshot.kind
        || (current.scope.phase !== 'configurationRequired' && current.scope.phase !== 'awaitingManual'))) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_conflict');
      }
      if (current?.scope.phase === snapshot.phase) {
        return Object.freeze({ expiresAtMs: current.expiresAtMs });
      }
      const candidate = {
        kind: snapshot.kind,
        attemptId: snapshot.attemptId,
        content: current?.content ?? await seal(null),
        scope: scopeFor(snapshot, current?.scope),
      };
      const record = current
        ? await api.replace({ ...candidate, expectedRevision: current.revision, expiresAtMs: current.expiresAtMs })
        : await api.create(candidate);
      return Object.freeze({ expiresAtMs: record.expiresAtMs });
    },
    async read(attemptId) {
      return await api.read({ attemptId });
    },
    async clear(attemptId) {
      const record = await api.read({ attemptId });
      if (!record) return;
      await api.delete({ kind: record.kind, attemptId, expectedRevision: record.revision });
    },
  });

  return Object.freeze({
    address,
    oauth,
    async listPending(service) {
      const machineId = params.getMachineId?.();
      return await api.listPending({
        ...(machineId === undefined ? {} : { machineId }),
        service,
      });
    },
    device: Object.freeze({
      async acknowledge(snapshot: ConnectedAccountDeviceTransactionSnapshot) {
        const current = await api.read({
          attemptId: snapshot.attemptId,
        });
        const payload = DevicePayloadSchema.parse({
          version: 2,
          kind: 'device',
          snapshot,
        });
        if (!current) {
          await api.create({
            kind: 'device',
            attemptId: snapshot.attemptId,
            content: await seal(payload),
            scope: scopeFor(snapshot),
            expiresAtMs: transactionExpiresAt({
              now: now(),
              providerExpiresAtMs: snapshot.expiresAtMs,
            }),
          });
          return;
        }
        if (current.kind !== 'device' || current.scope.phase !== 'configurationRequired') {
          const currentPayload = await readDevicePayload({
            attemptId: snapshot.attemptId,
            record: current,
          });
          assertDeviceSnapshotAdvance(currentPayload.snapshot, snapshot);
        }
        await api.replace({
          kind: 'device',
          attemptId: snapshot.attemptId,
          expectedRevision: current.revision,
          content: await seal(payload),
          scope: scopeFor(snapshot, current.scope),
          expiresAtMs: Math.min(current.expiresAtMs, snapshot.expiresAtMs),
        });
      },
      async read(attemptId: string, addressedRecord?: ConnectedAccountAttemptTransactionRecord) {
        const record = addressedRecord ?? await api.read({ attemptId });
        if (!record || record.kind !== 'device' || record.scope.phase === 'configurationRequired') return null;
        return (
          await readDevicePayload({ attemptId, record })
        ).snapshot;
      },
      async clear(attemptId: string) {
        const record = await api.read({ attemptId });
        if (!record || record.kind !== 'device') return;
        await api.delete({
          kind: 'device',
          attemptId,
          expectedRevision: record.revision,
        });
      },
    }),
  });
}
