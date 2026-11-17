import axios from '@/api/client/credentialAxios';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createActionAutomationHttpPortV1, readActionAutomationIndexUpdateV1,
  type ActionAutomationPortV1, type ActionAutomationSelectArgsV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';

type HostedIndex = Readonly<{ token: string; port: ReturnType<typeof createActionAutomationHttpPortV1> }>;
// One index for each exact Account and Home endpoint in this host process.
const indexes = new Map<string, HostedIndex>();
const indexKey = (serverHttpBaseUrl: string, accountId: string) => JSON.stringify([normalizeServerHttpBaseUrl(serverHttpBaseUrl), accountId]);

export function createCliActionAutomationPortV1(input: Readonly<{
  token: string; serverHttpBaseUrl: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  checks?: Pick<ActionAutomationPortV1, 'start' | 'wait' | 'cancel'> & Readonly<{
    allowConsent: NonNullable<ActionAutomationPortV1['allowConsent']>;
    resolveConsent: NonNullable<ActionAutomationSelectArgsV1['resolveConsent']>;
  }>;
}>): ActionAutomationPortV1 | undefined {
  const accountId = readAccountIdFromToken(input.token);
  if (!accountId) return undefined;
  const key = indexKey(input.serverHttpBaseUrl, accountId);
  const current = indexes.get(key);
  const checks = input.checks;
  const bind = (port: ReturnType<typeof createActionAutomationHttpPortV1>): ActionAutomationPortV1 => ({ ...port,
    ...checks,
    select: args => port.select({ ...args, ...(checks ? { resolveConsent: checks.resolveConsent } : {}) }),
    ...(checks ? { allowConsent: async (args: Parameters<NonNullable<ActionAutomationPortV1['allowConsent']>>[0]) => {
      const consent = await checks.allowConsent(args);
      port.retainConsent(consent);
      return consent;
    } } : {}),
  });
  if (current?.token === input.token) return bind(current.port);
  current?.port.dispose();
  const port = createActionAutomationHttpPortV1({ accountId, request: async (path, init) => {
    if (input.isCredentialCurrent && !await input.isCredentialCurrent()) throw Object.assign(
      new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    const response = await axios.request<unknown>({ url: `${normalizeServerHttpBaseUrl(input.serverHttpBaseUrl)}${path}`,
      method: init.method, ...(init.body === undefined ? {} : { data: init.body }),
      headers: { Authorization: `Bearer ${input.token}` }, signal: init.signal, validateStatus: () => true });
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
  if (accountId) await indexes.get(indexKey(input.serverHttpBaseUrl, accountId))?.port.refreshChanges(input.changes);
}
