import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

const requesterAccount = new AsyncLocalStorage<Readonly<{ accountId: string;
  executionAuthorization?: ExternalActionExecutionAuthorizationV1 }>>();

/** Private host binding from admitted Action/Run custody, never an SCM input field. */
export function runWithScmAccountScope<T>(accountId: string | undefined, effect: () => T,
  executionAuthorization?: ExternalActionExecutionAuthorizationV1): T {
  if (!accountId) throw Object.assign(new Error('SCM requester Account is unavailable'), { code: 'DIFF_UNAVAILABLE' });
  const current = requesterAccount.getStore();
  const authorization = executionAuthorization ?? (current?.accountId === accountId ? current.executionAuthorization : undefined);
  if (authorization && authorization.binding.accountId !== accountId) {
    throw Object.assign(new Error('SCM requester Account does not match its admission'), { code: 'DIFF_UNAVAILABLE' });
  }
  return requesterAccount.run({ accountId, ...(authorization ? { executionAuthorization: authorization } : {}) }, effect);
}

export function readScmAccountScope(): string | undefined {
  return requesterAccount.getStore()?.accountId;
}

export function readScmExecutionAuthorization(): ExternalActionExecutionAuthorizationV1 | undefined {
  return requesterAccount.getStore()?.executionAuthorization;
}

/** Unattributed development shelves remain untouched; they cannot be assigned by pathname. */
export function resolveScmAccountStorageKey(accountId = readScmAccountScope()): string {
  if (!accountId) throw Object.assign(new Error('SCM requester Account is unavailable'), { code: 'DIFF_UNAVAILABLE' });
  return createHash('sha256').update(accountId).digest('hex');
}

export function resolveScmAccountStorageDirectory(directory: string, accountId = readScmAccountScope()): string {
  return join(directory, 'accounts', resolveScmAccountStorageKey(accountId));
}
