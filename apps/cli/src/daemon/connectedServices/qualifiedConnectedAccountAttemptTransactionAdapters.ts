import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  StoredJsonContentEnvelopeSchema,
  isStoredJsonContentEnvelopeModeCompatible,
  openQualifiedConnectedAccountContentEnvelope,
  sealQualifiedConnectedAccountContentEnvelope,
  sameQualifiedConnectedAccountRef,
  type StoredJsonContentEnvelope,
} from '@happier-dev/protocol';
import { z } from 'zod';

import {
  createConnectedAccountAttemptTransactionApi,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionStoreApi,
} from '@/api/client/connectedAccountAttemptTransactionApi';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import { generatePkceCodes } from '@/cloud/pkce';
import type { StoredCredentials } from '@/persistence';
import type {
  ConnectedAccountDeviceTransactionSnapshot,
  ConnectedAccountOAuthCallbackCompletion,
  ConnectedAccountOAuthTransaction,
  ConnectedAccountOAuthTransactionOwner,
  ConnectedAccountOAuthTransactionSnapshot,
} from '@/plugins/runtime/connectedAccounts/authenticationAttemptOwner';

import {
  requireConnectedAccountCryptoMaterial,
  resolveConnectedAccountCryptoMaterial,
} from './accountScopedCryptoMaterial';
import type {
  QualifiedConnectedAccountAttemptTransactionAdapters,
} from './qualifiedConnectedAccountDaemonPersistence';

const DEFAULT_CALLBACK_URL = 'http://localhost:1455/auth/callback';
const DEFAULT_TRANSACTION_TTL_MS = 15 * 60_000;
const MAX_TRANSACTION_TTL_MS = 24 * 60 * 60_000;

const BoundedIdSchema = z.string().min(1).max(256);
const BoundedValueSchema = z.string().max(64 * 1024);
const SafeTimestampSchema = z.number().int().nonnegative();
const ServiceSchema = z.object({
  pluginId: BoundedIdSchema,
  localId: BoundedIdSchema,
}).strict();
const AccountSchema = z.object({
  service: ServiceSchema,
  accountId: BoundedIdSchema,
}).strict();
const StagedCredentialsSchema = z.record(
  z.string().min(1).max(128),
  BoundedValueSchema,
);
const ProviderIdentitySchema = z.object({
  accountId: BoundedIdSchema.optional(),
  email: z.string().min(1).max(4_096).optional(),
}).strict();
const PreparedSettlementSchema = z.object({
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  accountId: BoundedIdSchema,
  authenticationModeId: BoundedIdSchema,
  expectedCredentialRevision: z.string().max(4_096).nullable(),
  expectedCredentialConfigurationRevision:
    z.string().min(1).max(4_096).nullable(),
  expectedConfigurationRevision: z.string().min(1).max(4_096),
  generation: z.string().min(1).max(4_096),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.unknown().optional(),
  providerIdentity: ProviderIdentitySchema.optional(),
  displayName: z.string().max(4_096),
  scopes: z.array(z.string().max(4_096)).max(256),
}).strict();
const SnapshotBaseShape = {
  attemptId: BoundedIdSchema,
  createdAtMs: SafeTimestampSchema,
  intent: z.enum(['connect', 'reconnect']),
  service: ServiceSchema,
  account: AccountSchema.optional(),
  modeId: BoundedIdSchema,
  immutableGenerationId: z.string().min(1).max(4_096),
  expectedCredentialRevision: z.string().max(4_096).nullable(),
  expectedCredentialConfigurationRevision:
    z.string().min(1).max(4_096).nullable(),
  expectedConfigurationRevision: z.string().min(1).max(4_096),
  stagedCredentials: StagedCredentialsSchema,
  stagedAccountConfigurationContent: z.unknown().optional(),
  preparedSettlement: PreparedSettlementSchema.optional(),
} as const;
const OAuthSnapshotSchema = z.object({
  ...SnapshotBaseShape,
  phase: z.enum(['starting', 'awaitingOAuth', 'outcomeUnknown']),
  expiresAtMs: SafeTimestampSchema.optional(),
}).strict();
const DeviceSnapshotSchema = z.object({
  ...SnapshotBaseShape,
  expiresAtMs: SafeTimestampSchema,
  pollIntervalMs: z.number().int().positive(),
  nextPollAtMs: SafeTimestampSchema,
  verificationUri: z.string().min(1).max(8_192),
  verificationUriComplete: z.string().min(1).max(8_192).optional(),
  userCode: z.string().min(1).max(4_096),
}).strict();
const OAuthPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal('oauth'),
  snapshot: OAuthSnapshotSchema,
  state: z.string().min(32).max(256),
  challenge: z.string().min(32).max(256),
  verifier: z.string().min(43).max(128),
  callbackUrl: z.string().min(1).max(8_192),
  consumed: z.boolean(),
}).strict();
const DevicePayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal('device'),
  snapshot: DeviceSnapshotSchema,
}).strict();

type OAuthPayload = z.infer<typeof OAuthPayloadSchema>;
type DevicePayload = z.infer<typeof DevicePayloadSchema>;

function defaultRandomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

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
  left:
    | ConnectedAccountOAuthTransactionSnapshot
    | ConnectedAccountDeviceTransactionSnapshot,
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
    && left.immutableGenerationId === right.immutableGenerationId
    && left.expectedCredentialRevision === right.expectedCredentialRevision
    && left.expectedCredentialConfigurationRevision
      === right.expectedCredentialConfigurationRevision
    && left.expectedConfigurationRevision === right.expectedConfigurationRevision
    && isDeepStrictEqual(
      left.stagedAccountConfigurationContent,
      right.stagedAccountConfigurationContent,
    );
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
  ttlMs: number;
  providerExpiresAtMs?: number;
}>): number {
  const hostExpiry = input.now + input.ttlMs;
  return input.providerExpiresAtMs === undefined
    ? hostExpiry
    : Math.min(hostExpiry, input.providerExpiresAtMs);
}

export function createQualifiedConnectedAccountAttemptTransactionAdapters(
  params: Readonly<{
    credentials: StoredCredentials;
    /**
     * Persisted `Account.encryptionMode` is the sole representation authority. Attempt
     * durability is installed for every Account, plaintext included, and the mode —
     * never key presence — decides whether content is sealed or stored plainly.
     */
    getAccountEncryptionMode: () => Promise<ConnectedServiceAccountEncryptionMode>;
    api?: ConnectedAccountAttemptTransactionStoreApi;
    randomBytes?: (length: number) => Uint8Array;
    callbackUrl?: string;
    transactionTtlMs?: number;
    now?: () => number;
  }>,
): QualifiedConnectedAccountAttemptTransactionAdapters {
  const api =
    params.api
    ?? createConnectedAccountAttemptTransactionApi({
      token: params.credentials.token,
    });
  const randomBytes = params.randomBytes ?? defaultRandomBytes;
  const defaultCallbackUrl = params.callbackUrl ?? DEFAULT_CALLBACK_URL;
  const transactionTtlMs =
    params.transactionTtlMs ?? DEFAULT_TRANSACTION_TTL_MS;
  const now = params.now ?? Date.now;
  if (
    !Number.isSafeInteger(transactionTtlMs)
    || transactionTtlMs <= 0
    || transactionTtlMs > MAX_TRANSACTION_TTL_MS
  ) {
    throw new Error('Connected-account attempt transaction TTL is invalid');
  }
  const material = resolveConnectedAccountCryptoMaterial(params.credentials);

  async function resolveAccountMode(): Promise<'plain' | 'e2ee'> {
    const mode = await params.getAccountEncryptionMode();
    if (mode === 'unknown') {
      throw new Error(
        'Connected-account attempt transaction account encryption mode is unavailable',
      );
    }
    return mode;
  }

  async function seal(
    payload: OAuthPayload | DevicePayload,
  ): Promise<StoredJsonContentEnvelope> {
    const accountMode = await resolveAccountMode();
    return accountMode === 'plain'
      ? sealQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'plain',
        payload,
        randomBytes,
      })
      : sealQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'e2ee',
        material: requireConnectedAccountCryptoMaterial(
          params.credentials,
          material,
        ),
        payload,
        randomBytes,
      });
  }

  async function open(
    record: ConnectedAccountAttemptTransactionRecord,
  ): Promise<unknown> {
    const accountMode = await resolveAccountMode();
    const envelope = StoredJsonContentEnvelopeSchema.parse(record.content);
    // The persisted Account mode and the stored envelope kind must agree before any
    // content is disclosed. A mismatch is an inconsistent record, never a reason to
    // try the other branch.
    if (!isStoredJsonContentEnvelopeModeCompatible(accountMode, envelope)) {
      throw new Error(
        'Connected-account attempt transaction content does not match the persisted Account encryption mode',
      );
    }
    const opened = accountMode === 'plain'
      ? openQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'plain',
        envelope,
      })
      : openQualifiedConnectedAccountContentEnvelope({
        kind: 'attempt',
        accountMode: 'e2ee',
        material: requireConnectedAccountCryptoMaterial(
          params.credentials,
          material,
        ),
        envelope,
      });
    if (opened === null) {
      throw new Error(
        'Connected-account attempt transaction content is unavailable for the current account mode',
      );
    }
    return opened;
  }

  async function readOAuthPayload(input: Readonly<{
    attemptId: string;
    record: ConnectedAccountAttemptTransactionRecord;
  }>): Promise<OAuthPayload> {
    const parsed = OAuthPayloadSchema.parse(await open(input.record));
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
    const parsed = DevicePayloadSchema.parse(await open(input.record));
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
  }): ConnectedAccountOAuthTransaction & Readonly<{
    snapshot: ConnectedAccountOAuthTransactionSnapshot;
  }> {
    let payload = input.payload;
    let record = input.record;
    let closed = false;
    return Object.freeze({
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
          snapshot,
        });
        const nextRecord = await api.replace({
          kind: 'oauth',
          attemptId: snapshot.attemptId,
          expectedRevision: record.revision,
          content: await seal(nextPayload),
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

  const oauth: ConnectedAccountOAuthTransactionOwner = Object.freeze({
    async create(input) {
      if (
        input.attemptId !== input.snapshot.attemptId
        || !sameService(input.service, input.snapshot.service)
      ) {
        throw new Error(
          'Connected-account OAuth transaction identity is invalid',
        );
      }
      const pkce = generatePkceCodes();
      const callbackUrl = input.callbackUrl ?? defaultCallbackUrl;
      const payload = OAuthPayloadSchema.parse({
        version: 1,
        kind: 'oauth',
        snapshot: input.snapshot,
        state: Buffer.from(randomBytes(32)).toString('base64url'),
        challenge: pkce.challenge,
        verifier: pkce.verifier,
        callbackUrl,
        consumed: false,
      });
      const record = await api.create({
        kind: 'oauth',
        attemptId: input.attemptId,
        content: await seal(payload),
        expiresAtMs: transactionExpiresAt({
          now: now(),
          ttlMs: transactionTtlMs,
          ...(input.snapshot.expiresAtMs === undefined
            ? {}
            : { providerExpiresAtMs: input.snapshot.expiresAtMs }),
        }),
      });
      return createOAuthHandle({ payload, record });
    },
    async read(attemptId) {
      const record = await api.read({ kind: 'oauth', attemptId });
      if (!record) return null;
      const payload = await readOAuthPayload({ attemptId, record });
      return createOAuthHandle({ payload, record });
    },
  });

  return Object.freeze({
    oauth,
    device: Object.freeze({
      async acknowledge(snapshot: ConnectedAccountDeviceTransactionSnapshot) {
        const current = await api.read({
          kind: 'device',
          attemptId: snapshot.attemptId,
        });
        const payload = DevicePayloadSchema.parse({
          version: 1,
          kind: 'device',
          snapshot,
        });
        if (!current) {
          await api.create({
            kind: 'device',
            attemptId: snapshot.attemptId,
            content: await seal(payload),
            expiresAtMs: transactionExpiresAt({
              now: now(),
              ttlMs: transactionTtlMs,
              providerExpiresAtMs: snapshot.expiresAtMs,
            }),
          });
          return;
        }
        const currentPayload = await readDevicePayload({
          attemptId: snapshot.attemptId,
          record: current,
        });
        assertDeviceSnapshotAdvance(currentPayload.snapshot, snapshot);
        await api.replace({
          kind: 'device',
          attemptId: snapshot.attemptId,
          expectedRevision: current.revision,
          content: await seal(payload),
          expiresAtMs: Math.min(current.expiresAtMs, snapshot.expiresAtMs),
        });
      },
      async read(attemptId: string) {
        const record = await api.read({ kind: 'device', attemptId });
        if (!record) return null;
        return (
          await readDevicePayload({ attemptId, record })
        ).snapshot;
      },
      async clear(attemptId: string) {
        const record = await api.read({ kind: 'device', attemptId });
        if (!record) return;
        await api.delete({
          kind: 'device',
          attemptId,
          expectedRevision: record.revision,
        });
      },
    }),
  });
}
