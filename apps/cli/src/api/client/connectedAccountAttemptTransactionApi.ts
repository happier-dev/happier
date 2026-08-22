import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import { z } from 'zod';

import { resolveConnectedServicesServerApiTimeoutMs } from './connectedServicesServerApiTimeout';
import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';

export type ConnectedAccountAttemptTransactionKind = 'oauth' | 'device';

export type ConnectedAccountAttemptTransactionRecord = Readonly<{
  revision: number;
  ciphertext: string;
  expiresAtMs: number;
}>;

export type ConnectedAccountAttemptTransactionStoreApi = Readonly<{
  create(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    ciphertext: string;
    expiresAtMs: number;
  }>): Promise<ConnectedAccountAttemptTransactionRecord>;
  read(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
  }>): Promise<ConnectedAccountAttemptTransactionRecord | null>;
  replace(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
    ciphertext: string;
    expiresAtMs: number;
  }>): Promise<ConnectedAccountAttemptTransactionRecord>;
  delete(input: Readonly<{
    kind: ConnectedAccountAttemptTransactionKind;
    attemptId: string;
    expectedRevision: number;
  }>): Promise<void>;
}>;

export type ConnectedAccountAttemptTransactionApiErrorCode =
  | 'connected_account_attempt_transaction_not_found'
  | 'connected_account_attempt_transaction_conflict'
  | 'connected_account_attempt_transaction_expiry_invalid'
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
  ciphertext: z.string().min(1).max(524_288),
  expiresAtMs: z.number().int().positive(),
}).strict();

const TransactionErrorSchema = z.object({
  error: z.enum([
    'connected_account_attempt_transaction_not_found',
    'connected_account_attempt_transaction_conflict',
    'connected_account_attempt_transaction_expiry_invalid',
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
          ciphertext: input.ciphertext,
          expiresAtMs: input.expiresAtMs,
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
          validateStatus: (status) => status === 200 || status === 404,
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
      return TransactionRecordSchema.parse(response.data);
    },
    async replace(input) {
      const response = await axios.patch(
        transactionUrl(input.kind, input.attemptId),
        {
          expectedRevision: input.expectedRevision,
          ciphertext: input.ciphertext,
          expiresAtMs: input.expiresAtMs,
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
  });
}
