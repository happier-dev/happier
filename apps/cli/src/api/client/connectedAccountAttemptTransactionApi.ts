import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import type { StoredJsonContentEnvelope } from '@happier-dev/protocol';
import axios from 'axios';
import { z } from 'zod';

import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type ConnectedAccountAttemptTransactionKind = 'oauth' | 'device';

export type ConnectedAccountAttemptTransactionScope = Readonly<{
  machineId: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  modeId: string;
  intent: 'connect' | 'reconnect';
  phase: 'starting' | 'awaitingOAuth' | 'awaitingDeviceAuthorization' | 'outcomeUnknown';
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
  revision: number;
  content: StoredJsonContentEnvelope;
  expiresAtMs: number;
}>;

export type ConnectedAccountAttemptTransactionStoreApi = Readonly<{
  create(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    content: StoredJsonContentEnvelope;
    expiresAtMs: number;
    scope: ConnectedAccountAttemptTransactionScope;
  }>): Promise<ConnectedAccountAttemptTransactionRecord>;
  read(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
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
    machineId: string;
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

const TransactionRecordSchema = z.object({
  revision: z.number().int().min(1),
  content: StoredJsonContentEnvelopeSchema,
  expiresAtMs: z.number().int().positive(),
}).strict();

const PendingTransactionSchema = z.object({
  attemptId: z.string().min(1).max(160),
  kind: z.enum(['oauth', 'device']),
  modeId: z.string().min(1).max(256),
  intent: z.enum(['connect', 'reconnect']),
  phase: z.enum(['awaitingOAuth', 'awaitingDeviceAuthorization', 'outcomeUnknown']),
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().positive(),
}).strict();
const PendingTransactionsSchema = z.object({
  attempts: z.array(PendingTransactionSchema),
}).strict();

const TransactionErrorSchema = z.object({
  error: z.enum([
    'connected_account_attempt_transaction_not_found',
    'connected_account_attempt_transaction_conflict',
    'connected_account_attempt_transaction_expiry_invalid',
    'connected_account_attempt_transaction_storage_mode_mismatch',
    'connected_account_attempt_transaction_unreadable',
  ]),
}).strict();

function requestHeaders(token: string): Readonly<Record<string, string>> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function transactionUrl(
  kind: ConnectedAccountAttemptTransactionKind,
  attemptId: string,
): string {
  return `${resolveServerHttpBaseUrl()}/v2/connect/connected-account-attempt-transactions/${kind}/${encodeURIComponent(attemptId)}`;
}

function throwResponseError(data: unknown): never {
  const parsed = TransactionErrorSchema.safeParse(data);
  throw new ConnectedAccountAttemptTransactionApiError(
    parsed.success
      ? parsed.data.error
      : 'connected_account_attempt_transaction_contract_invalid',
  );
}

export function createConnectedAccountAttemptTransactionApi(
  params: Readonly<{ token: string }>,
): ConnectedAccountAttemptTransactionStoreApi {
  const options = {
    headers: requestHeaders(params.token),
    timeout: resolveConnectedServicesServerApiTimeoutMs(),
  } as const;
  return Object.freeze({
    async create(input) {
      const response = await axios.post(
        transactionUrl(input.kind, input.attemptId),
        {
          content: input.content,
          expiresAtMs: input.expiresAtMs,
          scope: input.scope,
        },
        {
          ...options,
          validateStatus: (status) => status === 200 || status === 409,
        },
      );
      if (response.status !== 200) throwResponseError(response.data);
      return TransactionRecordSchema.parse(response.data);
    },
    async read(input) {
      const response = await axios.get(
        transactionUrl(input.kind, input.attemptId),
        {
          ...options,
          validateStatus: (status) => (
            status === 200 || status === 404 || status === 409
          ),
        },
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
      const response = await axios.patch(
        transactionUrl(input.kind, input.attemptId),
        {
          expectedRevision: input.expectedRevision,
          content: input.content,
          expiresAtMs: input.expiresAtMs,
          scope: input.scope,
        },
        {
          ...options,
          validateStatus: (status) => (
            status === 200 || status === 404 || status === 409
          ),
        },
      );
      if (response.status !== 200) throwResponseError(response.data);
      return TransactionRecordSchema.parse(response.data);
    },
    async delete(input) {
      const response = await axios.delete(
        transactionUrl(input.kind, input.attemptId),
        {
          ...options,
          data: { expectedRevision: input.expectedRevision },
          validateStatus: (status) => (
            status === 200 || status === 404 || status === 409
          ),
        },
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
        || response.data.status !== 'deleted'
      ) {
        throw new ConnectedAccountAttemptTransactionApiError(
          'connected_account_attempt_transaction_contract_invalid',
        );
      }
    },
    async listPending(input) {
      const url = new URL(`${resolveServerHttpBaseUrl()}/v2/connect/connected-account-attempt-transactions/pending`);
      url.searchParams.set('machineId', input.machineId);
      url.searchParams.set('pluginId', input.service.pluginId);
      url.searchParams.set('localId', input.service.localId);
      const response = await axios.get(url.toString(), {
        ...options,
        validateStatus: (status) => status === 200 || status === 409,
      });
      if (response.status !== 200) throwResponseError(response.data);
      return PendingTransactionsSchema.parse(response.data).attempts;
    },
  });
}
