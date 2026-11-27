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

type ScmRequesterAccountContext = import('@/daemon/sessionEncryption/requesterAccountActionContext').RequesterAccountActionContext;
export type ScmRequesterConnectedAccounts = Pick<import('@/plugins/runtime/invocation/services/connectedAccounts').StablePluginConnectedAccountsOwner,
  'getBinding' | 'listAccounts' | 'materialize'>;
type ScmRequesterOperationSelection = import('@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner')
  .ConnectedAccountPurposeBindingOwner['prepareOperationSelection'];
/** The existing finite requester material (`prepareRequesterOperationMaterial`), as the daemon wires it. */
export type ScmRequesterCredentialMaterial = Readonly<{
  connectedAccounts: ScmRequesterConnectedAccounts;
  prepareConnectedAccountOperationSelection?: ScmRequesterOperationSelection;
  dispose(): Promise<void>;
}>;
export type ScmRequesterCredentials = Readonly<{
  /** Admitted requester custody; a member child prepares its own material from it. */
  account: ScmRequesterAccountContext | null;
  /** Null: this request has no candidate at all, so every credential use settles as authentication required. */
  connectedAccounts: ScmRequesterConnectedAccounts | null;
  prepareOperationSelection?: ScmRequesterOperationSelection;
}>;

const requesterCredentials = new AsyncLocalStorage<ScmRequesterCredentials>();

/**
 * Binds another person's own credential candidates for one SCM request (owner ruling 2026-11-26: a guest
 * uses their own hosting account, never this Machine's logins or connected accounts). The SCM ingress
 * decides once whether the request is another person's; every credential consumer reads this binding.
 * The material opens on first use only and is disposed with the request.
 */
export async function runWithScmRequesterCredentials<T>(input: Readonly<{
  account: ScmRequesterAccountContext | null;
  prepare?: (account: ScmRequesterAccountContext, signal: AbortSignal) => Promise<ScmRequesterCredentialMaterial>;
  signal: AbortSignal;
}>, effect: () => Promise<T>): Promise<T> {
  const { account, prepare } = input;
  let opened: Promise<ScmRequesterCredentialMaterial> | undefined;
  const open = account && prepare ? () => opened ??= prepare(account, input.signal) : undefined;
  const connectedAccounts: ScmRequesterConnectedAccounts | null = open ? {
    getBinding: async request => await (await open()).connectedAccounts.getBinding(request),
    listAccounts: async request => await (await open()).connectedAccounts.listAccounts(request),
    materialize: async request => await (await open()).connectedAccounts.materialize(request),
  } : null;
  const prepareOperationSelection: ScmRequesterOperationSelection | undefined = open ? async request => {
    const select = (await open()).prepareConnectedAccountOperationSelection;
    if (!select) throw Object.assign(new Error('Requester Account selection is unavailable'), { code: 'credential_unavailable' });
    return await select(request);
  } : undefined;
  try {
    return await requesterCredentials.run({ account, connectedAccounts,
      ...(prepareOperationSelection ? { prepareOperationSelection } : {}) }, effect);
  } finally {
    // Cleanup is reported beside the result by the material owner; it never replaces it.
    if (opened) await opened.then(material => material.dispose(), () => undefined).catch(() => undefined);
  }
}

/** Member child side: the parent already selected this requester; the child binds the same candidates. */
export function runWithAdmittedScmRequesterCredentials<T>(connectedAccounts: ScmRequesterConnectedAccounts | null, effect: () => T): T {
  return requesterCredentials.run({ account: null, connectedAccounts }, effect);
}

export function readScmRequesterCredentials(): ScmRequesterCredentials | undefined {
  return requesterCredentials.getStore();
}
