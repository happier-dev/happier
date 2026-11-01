import { CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS } from '@happier-dev/cli-common/connectedAccounts';
import {
  ConnectedAccountAttemptTransactionApiError,
  type ConnectedAccountAttemptTransactionRecord,
  type ConnectedAccountAttemptTransactionStoreApi,
} from '@/api/client/connectedAccountAttemptTransactionApi';

/** Database/API boundary only; the durable transaction policy remains real. */
export function createConnectedAccountAttemptTransactionApiBoundary(): ConnectedAccountAttemptTransactionStoreApi & {
  records: Map<string, ConnectedAccountAttemptTransactionRecord>;
} {
  const records = new Map<string, ConnectedAccountAttemptTransactionRecord>();
  const scopes = new Map<string, Parameters<ConnectedAccountAttemptTransactionStoreApi['create']>[0]['scope']>();
  return {
    records,
    async create(input) {
      const key = input.attemptId;
      if (records.has(key)) throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_conflict');
      const record = Object.freeze({ kind: input.kind, revision: 1, content: input.content,
        expiresAtMs: input.expiresAtMs ?? Date.now() + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS, scope: input.scope });
      records.set(key, record);
      scopes.set(key, input.scope);
      return record;
    },
    async read(input) {
      return records.get(input.attemptId) ?? null;
    },
    async replace(input) {
      const key = input.attemptId;
      const current = records.get(key);
      if (current && current.kind !== input.kind) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_unreadable');
      }
      if (!current || current.revision !== input.expectedRevision) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_conflict');
      }
      const record = Object.freeze({ kind: input.kind, revision: current.revision + 1, content: input.content,
        expiresAtMs: input.expiresAtMs, scope: input.scope });
      records.set(key, record);
      scopes.set(key, input.scope);
      return record;
    },
    async delete(input) {
      const key = input.attemptId;
      const current = records.get(key);
      if (current && current.kind !== input.kind) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_unreadable');
      }
      if (!current || current.revision !== input.expectedRevision) {
        throw new ConnectedAccountAttemptTransactionApiError('connected_account_attempt_transaction_conflict');
      }
      records.delete(key);
      scopes.delete(key);
    },
    async listPending(input) {
      return [...scopes.entries()].flatMap(([key, scope]) => {
        const record = records.get(key);
        if (!record || scope.machineId !== input.machineId
          || scope.service.pluginId !== input.service.pluginId
          || scope.service.localId !== input.service.localId
          || scope.phase === 'starting') return [];
        return [{ attemptId: key, kind: record.kind, modeId: scope.modeId, intent: scope.intent,
          phase: scope.phase, createdAtMs: scope.createdAtMs, expiresAtMs: record.expiresAtMs }];
      });
    },
  };
}
