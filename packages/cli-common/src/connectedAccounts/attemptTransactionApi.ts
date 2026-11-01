import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import { z } from 'zod/mini';
import type { HttpService } from '../plugins/http/contracts.js';

// Existing server attempt-custody lifetime, shared by writers and admission.
export const CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS = 24 * 60 * 60_000;

export type ConnectedAccountAttemptTransactionKind = 'manual' | 'oauth' | 'device';

export type ConnectedAccountAttemptTransactionScope = Readonly<{
  machineId?: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  modeId: string;
  intent: 'connect' | 'reconnect';
  phase: 'starting' | 'configurationRequired' | 'awaitingManual' | 'awaitingOAuth' | 'awaitingDeviceAuthorization' | 'outcomeUnknown';
  createdAtMs: number;
}>;

export type PendingConnectedAccountAttemptTransaction = Readonly<{
  attemptId: string;
  kind: ConnectedAccountAttemptTransactionKind;
  modeId: string;
  intent: ConnectedAccountAttemptTransactionScope['intent'];
  phase: Exclude<ConnectedAccountAttemptTransactionScope['phase'], 'starting'>;
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type ConnectedAccountAttemptTransactionRecord = Readonly<{
  kind: ConnectedAccountAttemptTransactionKind;
  revision: number;
  content: StoredJsonContentEnvelope;
  expiresAtMs: number;
  scope: ConnectedAccountAttemptTransactionScope;
}>;

export type ConnectedAccountAttemptTransactionStoreApi = Readonly<{
  create(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    content: StoredJsonContentEnvelope;
    /** Omitted expiry uses the existing lifetime at the server's clock. */
    expiresAtMs?: number;
    scope: ConnectedAccountAttemptTransactionScope;
  }>): Promise<ConnectedAccountAttemptTransactionRecord>;
  read(input: Readonly<{
    attemptId: string;
  }>): Promise<ConnectedAccountAttemptTransactionRecord | null>;
  replace(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
    scope: ConnectedAccountAttemptTransactionScope;
  }>): Promise<ConnectedAccountAttemptTransactionRecord>;
  delete(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
  }>): Promise<void>;
  listPending(input: Readonly<{
    machineId?: string;
    service: ConnectedAccountAttemptTransactionScope['service'];
  }>): Promise<readonly PendingConnectedAccountAttemptTransaction[]>;
}>;

export type ConnectedAccountAttemptTransactionApiErrorCode =
  | 'connected_account_attempt_transaction_not_found'
  | 'connected_account_attempt_transaction_conflict'
  | 'connected_account_attempt_transaction_expiry_invalid'
  | 'connected_account_attempt_transaction_storage_mode_mismatch'
  | 'connected_account_attempt_transaction_unreadable'
  | 'connected_account_attempt_transaction_contract_invalid';

export class ConnectedAccountAttemptTransactionApiError extends Error {
  readonly code: ConnectedAccountAttemptTransactionApiErrorCode;

  constructor(code: ConnectedAccountAttemptTransactionApiErrorCode) {
    super(code);
    this.name = 'ConnectedAccountAttemptTransactionApiError';
    this.code = code;
  }
}

const TransactionScopeSchema = z.strictObject({
  machineId: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
  service: z.strictObject({ pluginId: z.string().check(z.minLength(1), z.maxLength(256)), localId: z.string().check(z.minLength(1), z.maxLength(256)) }),
  modeId: z.string().check(z.minLength(1), z.maxLength(256)),
  intent: z.enum(['connect', 'reconnect']),
  phase: z.enum(['starting', 'configurationRequired', 'awaitingManual', 'awaitingOAuth', 'awaitingDeviceAuthorization', 'outcomeUnknown']),
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
});

const TransactionRecordSchema = z.strictObject({
  kind: z.enum(['manual', 'oauth', 'device']),
  revision: z.number().check(z.int(), z.minimum(1)),
  content: StoredJsonContentEnvelopeSchema,
  expiresAtMs: z.number().check(z.int(), z.positive()),
  scope: TransactionScopeSchema,
});

const PendingTransactionSchema = z.strictObject({
  attemptId: z.string().check(z.minLength(1), z.maxLength(160)),
  kind: z.enum(['manual', 'oauth', 'device']),
  modeId: z.string().check(z.minLength(1), z.maxLength(256)),
  intent: z.enum(['connect', 'reconnect']),
  phase: z.enum(['configurationRequired', 'awaitingManual', 'awaitingOAuth', 'awaitingDeviceAuthorization', 'outcomeUnknown']),
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  expiresAtMs: z.number().check(z.int(), z.positive()),
});
const PendingTransactionsSchema = z.strictObject({
  attempts: z.array(PendingTransactionSchema),
});

const TransactionErrorSchema = z.strictObject({
  error: z.enum([
    'connected_account_attempt_transaction_not_found',
    'connected_account_attempt_transaction_conflict',
    'connected_account_attempt_transaction_expiry_invalid',
    'connected_account_attempt_transaction_storage_mode_mismatch',
    'connected_account_attempt_transaction_unreadable',
  ]),
});

function throwResponseError(data: unknown): never {
  const parsed = TransactionErrorSchema.safeParse(data);
  throw new ConnectedAccountAttemptTransactionApiError(
    parsed.success
      ? parsed.data.error
      : 'connected_account_attempt_transaction_contract_invalid',
  );
}

export function createConnectedAccountAttemptTransactionApi(
  params: Readonly<{
    token: string;
    baseUrl: string;
    http: Pick<HttpService, 'request'>;
    headers?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  }>,
): ConnectedAccountAttemptTransactionStoreApi {
  const transactionUrl = (kind: ConnectedAccountAttemptTransactionKind, attemptId: string) =>
    `${params.baseUrl}/v2/connect/connected-account-attempt-transactions/${kind}/${encodeURIComponent(attemptId)}`;
  const options = {
    headers: { ...params.headers, Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
  } as const;
  const request = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) => {
    const response = await params.http.request({
      url, method, headers: options.headers, redirect: 'error',
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }),
    });
    let data: unknown;
    try { data = JSON.parse(new TextDecoder().decode(response.body)); }
    catch { throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_contract_invalid'); }
    return { status: response.status, data };
  };
  return Object.freeze({
    async create(input) {
      const response = await request('POST',
        transactionUrl(input.kind, input.attemptId),
        {
          content: input.content,
          expiresAtMs: input.expiresAtMs,
          scope: input.scope,
        },
      );
      if (response.status !== 200) throwResponseError(response.data);
      return TransactionRecordSchema.parse(response.data);
    },
    async read(input) {
      const response = await request('GET',
        `${params.baseUrl}/v2/connect/connected-account-attempt-transactions/${encodeURIComponent(input.attemptId)}`,
      );
      if (response.status === 404) {
        const parsed = TransactionErrorSchema.safeParse(response.data);
        if (
          !parsed.success
          || parsed.data.error !== 'connected_account_attempt_transaction_not_found'
        ) {
          throw new ConnectedAccountAttemptTransactionApiError(
            'connected_account_attempt_transaction_contract_invalid',
          );
        }
        return null;
      }
      if (response.status !== 200) throwResponseError(response.data);
      return TransactionRecordSchema.parse(response.data);
    },
    async replace(input) {
      const response = await request('PATCH',
        transactionUrl(input.kind, input.attemptId),
        {
          expectedRevision: input.expectedRevision,
          content: input.content,
          expiresAtMs: input.expiresAtMs,
          scope: input.scope,
        },
      );
      if (response.status !== 200) throwResponseError(response.data);
      return TransactionRecordSchema.parse(response.data);
    },
    async delete(input) {
      const response = await request('DELETE',
        transactionUrl(input.kind, input.attemptId),
        { expectedRevision: input.expectedRevision },
      );
      if (response.status === 404) {
        // DELETE is idempotent: an exact absent record is the outcome this
        // cleanup asked for. Reporting it as a failure keeps the terminal
        // response and its attempt slot held for an operation that can never
        // succeed again.
        const parsed = TransactionErrorSchema.safeParse(response.data);
        if (
          !parsed.success
          || parsed.data.error !== 'connected_account_attempt_transaction_not_found'
        ) {
          throw new ConnectedAccountAttemptTransactionApiError(
            'connected_account_attempt_transaction_contract_invalid',
          );
        }
        return;
      }
      if (response.status !== 200) throwResponseError(response.data);
      if (
        !response.data
        || typeof response.data !== 'object'
        || Array.isArray(response.data)
        || !('status' in response.data)
        || response.data.status !== 'deleted'
      ) {
        throw new ConnectedAccountAttemptTransactionApiError(
          'connected_account_attempt_transaction_contract_invalid',
        );
      }
    },
    async listPending(input) {
      const url = new URL(`${params.baseUrl}/v2/connect/connected-account-attempt-transactions/pending`);
      if (input.machineId !== undefined) url.searchParams.set('machineId', input.machineId);
      url.searchParams.set('pluginId', input.service.pluginId);
      url.searchParams.set('localId', input.service.localId);
      const response = await request('GET', url.toString());
      if (response.status !== 200) throwResponseError(response.data);
      return PendingTransactionsSchema.parse(response.data).attempts;
    },
  });
}
