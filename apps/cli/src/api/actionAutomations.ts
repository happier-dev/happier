import { AsyncLocalStorage } from 'node:async_hooks';
import axios from '@/api/client/credentialAxios';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionAutomationHttpPortV1, readActionAutomationIndexUpdateV1,
  type ActionAutomationPortV1, type ActionAutomationSelectArgsV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';

type CredentialBinding = Readonly<{ token: string; isCredentialCurrent?: () => boolean | Promise<boolean> }>;
type HostedIndex = { token: string; port: ReturnType<typeof createActionAutomationHttpPortV1> };
// One index for each exact Account and Home endpoint in this host process.
const indexes = new Map<string, HostedIndex>();
// The index is shared, while finite HTTP work keeps its originating caller credential.
const requestCredential = new AsyncLocalStorage<CredentialBinding>();
const indexKey = (serverHttpBaseUrl: string, accountId: string) => JSON.stringify([normalizeServerHttpBaseUrl(serverHttpBaseUrl), accountId]);

export function createCliActionAutomationPortV1(input: Readonly<{
  token: string; serverHttpBaseUrl: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  checks?: Pick<ActionAutomationPortV1, 'start' | 'wait' | 'cancel'> & Readonly<{
    allowConsent: NonNullable<ActionAutomationPortV1['allowConsent']>;
    prepareMatching: NonNullable<ActionAutomationPortV1['prepareMatching']>;
    resolveConsent: NonNullable<ActionAutomationSelectArgsV1['resolveConsent']>;
  }>;
}>): ActionAutomationPortV1 | undefined {
  const accountId = readAccountIdFromToken(input.token);
  if (!accountId) return undefined;
  const key = indexKey(input.serverHttpBaseUrl, accountId);
  const current = indexes.get(key);
  const checks = input.checks;
  const bind = (port: ReturnType<typeof createActionAutomationHttpPortV1>): ActionAutomationPortV1 => {
    const start = checks?.start ?? port.start;
    const hasAfterActions = port.hasAfterActions;
    const admitOccurrence = port.admitOccurrence;
    return { ...port, ...checks,
      select: args => requestCredential.run(input, () => port.select({ ...args,
        ...(checks ? { resolveConsent: checks.resolveConsent, prepareMatching: checks.prepareMatching } : {}) })),
      ...(hasAfterActions ? { hasAfterActions: (actionIds: readonly string[]) =>
        requestCredential.run(input, () => hasAfterActions(actionIds)) } : {}),
      settle: args => requestCredential.run(input, () => port.settle(args)),
      ...(start ? { start: (args: Parameters<typeof start>[0]) => requestCredential.run(input, () => start(args)) } : {}),
      ...(admitOccurrence ? { admitOccurrence: (occurrence: Parameters<typeof admitOccurrence>[0],
        context: Parameters<typeof admitOccurrence>[1]) => requestCredential.run(input, () => admitOccurrence(occurrence, context)) } : {}),
      ...(checks ? { allowConsent: async (args: Parameters<NonNullable<ActionAutomationPortV1['allowConsent']>>[0]) => {
        const consent = await checks.allowConsent(args);
        port.retainConsent(consent);
        return consent;
      } } : {}),
    };
  };
  if (current) {
    if (current.token !== input.token) {
      current.token = input.token;
      current.port.reconnect();
    }
    return bind(current.port);
  }
  const port = createActionAutomationHttpPortV1({ accountId, request: async (path, init) => {
    const credential = requestCredential.getStore();
    if (!credential) throw new Error('Missing Action automation credential binding');
    if (credential.isCredentialCurrent && !await credential.isCredentialCurrent()) throw Object.assign(
      new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    const response = await axios.request<unknown>({ url: `${normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)}${path}`,
      method: init.method, ...(init.body === undefined ? {} : { data: init.body }),
      headers: { Authorization: `Bearer ${credential.token}` }, signal: init.signal, validateStatus: () => true });
    if (response.status < 200 || response.status >= 300) {
      const body = readRecord(response.data);
      const code = readActionErrorCodeV1({ code: body.errorCode ?? body.error });
      throw Object.assign(new Error('automation_http_error'), { code:
        code ?? `http_${response.status}` });
    }
    return response.data;
  } });
  indexes.set(key, { token: input.token, port });
  return bind(port);
}

/** Existing Account and Machine socket owners deliver structural rows without fetching. */
export function applyCliActionAutomationUpdateV1(input: Readonly<{
  token: string; serverHttpBaseUrl: string; body: unknown;
}>): void {
  const accountId = readAccountIdFromToken(input.token);
  if (!accountId) return;
  const index = indexes.get(indexKey(input.serverHttpBaseUrl, accountId));
  if (!index) return;
  const change = readActionAutomationIndexUpdateV1(input.body);
  if (change) index.port.apply(change);
}

/** Existing authenticated socket recovery permits one new seed on next admission. */
export function reconnectCliActionAutomationsV1(input: Readonly<{ token: string; serverHttpBaseUrl: string }>): void {
  const accountId = readAccountIdFromToken(input.token);
  if (accountId) indexes.get(indexKey(input.serverHttpBaseUrl, accountId))?.port.reconnect();
}

/** The incumbent cursor owner supplies only the rows it recovered from a missed connection. */
export async function refreshCliActionAutomationsFromChangesV1(input: Readonly<{
  token: string; serverHttpBaseUrl: string;
  changes: Parameters<HostedIndex['port']['refreshChanges']>[0];
}>): Promise<void> {
  const accountId = readAccountIdFromToken(input.token);
  if (accountId) await requestCredential.run(input,
    () => indexes.get(indexKey(input.serverHttpBaseUrl, accountId))?.port.refreshChanges(input.changes));
}
