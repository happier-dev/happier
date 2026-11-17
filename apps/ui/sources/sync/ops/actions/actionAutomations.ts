import { createActionAutomationHttpPortV1, readActionAutomationIndexUpdateV1,
  type ActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { UiWorkflowAction } from './workflowActionDeps';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

type HostedIndex = Readonly<{ token: string; port: ReturnType<typeof createActionAutomationHttpPortV1> }>;
const indexes = new Map<string, HostedIndex>();

/** The Account owns the index; mounted executor instances borrow it. */
export function createUiActionAutomationPortV1(account: LazyActionAccountContext,
  checks?: UiWorkflowAction['actionAutomationChecks']): ActionAutomationPortV1 {
  const key = serverAccountScopeKeySuffix({ serverId: account.serverId, accountId: account.accountId });
  const current = indexes.get(key);
  const bind = (port: ReturnType<typeof createActionAutomationHttpPortV1>): ActionAutomationPortV1 => ({ ...port, ...checks,
    select: args => port.select({ ...args, ...(checks ? { resolveConsent: checks.resolveConsent } : {}) }),
    ...(checks ? { allowConsent: async (args: Parameters<NonNullable<ActionAutomationPortV1['allowConsent']>>[0]) => {
      const consent = await checks.allowConsent(args);
      port.retainConsent(consent);
      return consent;
    } } : {}),
  });
  if (current?.token === account.credentials.token) return bind(current.port);
  current?.port.dispose();
  const port = createActionAutomationHttpPortV1({ accountId: account.accountId,
    subscribe: (_apply, invalidate) => subscribeHomeAccountChange(event => {
      if (event.changesCatchUp || event.feedPageConsumed) return;
      if (event.source === 'connected' || event.source === 'snapshot'
        || event.source === 'catch-up-pending' && !event.entityIds?.length) invalidate();
    }, { serverIds: [account.serverId], includeCatchUpPending: 'recovery' }),
    request: async (path, init) => {
    // A mounted invocation may end before the next invocation. Acquire through
    // the existing Account owner so no ended reader lends the index its lifetime.
    const [{ captureLazyActionAccountContext }, { readAutomationJsonOrThrow }] = await Promise.all([
      import('./actionAccountContext'), import('@/sync/api/automations/apiAutomationHttp'),
    ]);
    const requestAccount = await captureLazyActionAccountContext(account.serverId, init.signal,
      undefined, account.accountOnlyLifetime.scope);
    try {
      const response = await requestAccount.request(path, { method: init.method,
        headers: { Authorization: `Bearer ${requestAccount.credentials.token}`, 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: init.signal },
      { auth: true });
      return await readAutomationJsonOrThrow(response);
    } finally { requestAccount.dispose(); }
  } });
  indexes.set(key, { token: account.credentials.token, port });
  account.accountOnlyLifetime.onRetire(() => {
    if (indexes.get(key)?.port === port) indexes.delete(key);
    port.dispose();
  });
  return bind(port);
}

/** Existing synced structural upserts are sufficient; no fetch is made for a push. */
export function applyUiActionAutomationUpdateV1(input: Readonly<{
  serverId: string; accountId: string; body: unknown;
}>): void {
  const index = indexes.get(serverAccountScopeKeySuffix(input));
  if (!index) return;
  const change = readActionAutomationIndexUpdateV1(input.body);
  if (change) index.port.apply(change);
}

/** Transport recovery changes availability, while the Account retains ownership. */
export function reconnectUiActionAutomationsV1(input: Readonly<{ serverId: string; accountId: string }>): void {
  indexes.get(serverAccountScopeKeySuffix(input))?.port.reconnect();
}

/** Recover only the scopes selected by the existing Home cursor page. */
export async function refreshUiActionAutomationsFromChangesV1(input: Readonly<{
  serverId: string; accountId: string;
  changes: Parameters<HostedIndex['port']['refreshChanges']>[0];
}>): Promise<void> {
  await indexes.get(serverAccountScopeKeySuffix(input))?.port.refreshChanges(input.changes);
}
