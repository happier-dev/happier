import { AsyncLocalStorage } from 'node:async_hooks';
import axios from '@/api/client/credentialAxios';
import { isNetworkConnectionErrorCode, readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, bindWorkflowActionAutomationChecksV1, createActionAutomationHttpPortV1,
  notEvaluatedActionAutomationPortV1, readActionAutomationIndexUpdateV1,
  type MatchingActionAutomationPortV1, type NotEvaluatedActionAutomationPortV1,
  type WorkflowActionAutomationChecksV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';

type CredentialBinding = Readonly<{ token: string; isCredentialCurrent?: () => boolean | Promise<boolean> }>;
type HomeBinding = CredentialBinding & Readonly<{ serverHttpBaseUrl: string }>;
type HostedIndex = { token: string; port: ReturnType<typeof createActionAutomationHttpPortV1> };
// One index for each exact Account and Home endpoint in this host process.
const indexes = new Map<string, HostedIndex>();
// The index is shared, while finite HTTP work keeps its originating caller credential.
const requestCredential = new AsyncLocalStorage<CredentialBinding>();
const indexKey = (serverHttpBaseUrl: string, accountId: string) => JSON.stringify([normalizeServerHttpBaseUrl(serverHttpBaseUrl), accountId]);

export function createCliActionAutomationPortV1(input: HomeBinding & Readonly<{
  checks: WorkflowActionAutomationChecksV1;
}>): MatchingActionAutomationPortV1 | NotEvaluatedActionAutomationPortV1 {
  const index = readCliActionAutomationIndex(input);
  if (!index) return notEvaluatedActionAutomationPortV1;
  const port = bindWorkflowActionAutomationChecksV1(index, input.checks);
  const { token, isCredentialCurrent } = input;
  const credential = { token, isCredentialCurrent };
  const { start, admitOccurrence, hasAfterActions } = port;
  return {
    ...port,
    select: args => requestCredential.run(credential, () => port.select(args)),
    settle: args => requestCredential.run(credential, () => port.settle(args)),
    ...(start ? { start: (args: Parameters<typeof start>[0]) => requestCredential.run(credential, () => start(args)) } : {}),
    ...(admitOccurrence ? { admitOccurrence: (occurrence: Parameters<typeof admitOccurrence>[0],
      context: Parameters<typeof admitOccurrence>[1]) => requestCredential.run(credential, () => admitOccurrence(occurrence, context)) } : {}),
    ...(hasAfterActions ? { hasAfterActions: (actionIds: readonly string[]) =>
      requestCredential.run(credential, () => hasAfterActions(actionIds)) } : {}),
  };
}

/** Native Event demand reads the structural index and has no Action execution authority. */
export async function readCliHasAfterActionAutomationsV1(input: HomeBinding, actionIds: readonly string[]): Promise<boolean> {
  const read = readCliActionAutomationIndex(input)?.hasAfterActions;
  if (!read) throw new Error('automation_action_index_unavailable');
  return requestCredential.run(input, () => read(actionIds));
}

function readCliActionAutomationIndex(input: HomeBinding): HostedIndex['port'] | undefined {
  const accountId = readAccountIdFromToken(input.token);
  if (!accountId) return undefined;
  const key = indexKey(input.serverHttpBaseUrl, accountId);
  const current = indexes.get(key);
  if (current) {
    if (current.token !== input.token) {
      current.token = input.token;
      current.port.reconnect();
    }
    return current.port;
  }
  const port = createHostedActionAutomationIndex(accountId, input.serverHttpBaseUrl);
  indexes.set(key, { token: input.token, port });
  return port;
}

/** The process-wide index owns Home identity. Caller checks and credentials belong to each request. */
function createHostedActionAutomationIndex(accountId: string, serverHttpBaseUrl: string): HostedIndex['port'] {
  return createActionAutomationHttpPortV1({ accountId, async readHomeFeatures(signal) {
    const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: serverHttpBaseUrl, signal });
    return snapshot.status === 'ready' ? snapshot.features : null;
  }, request: async (path, init) => {
    const credential = requestCredential.getStore();
    if (!credential) throw new Error('Missing Action automation credential binding');
    if (credential.isCredentialCurrent && !await credential.isCredentialCurrent()) throw Object.assign(
      new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    const response = await axios.request<unknown>({ url: `${normalizeServerHttpBaseUrl(serverHttpBaseUrl)}${path}`,
      method: init.method, ...(init.body === undefined ? {} : { data: init.body }),
      headers: { Authorization: `Bearer ${credential.token}` }, signal: init.signal, validateStatus: () => true })
      .catch((error: unknown) => {
        if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 && readHttpStatus(error) === null
          && isNetworkConnectionErrorCode(readNormalizedConnectionErrorCode(error))) {
          throw Object.assign(new Error('Action index transport failed', { cause: error }), { code: 'server_unreachable' });
        }
        throw error;
      });
    if (response.status < 200 || response.status >= 300) {
      const body = readRecord(response.data);
      const code = readActionErrorCodeV1({ code: body.errorCode ?? body.error });
      throw Object.assign(new Error('automation_http_error'), { code:
        code ?? `http_${response.status}` });
    }
    return response.data;
  } });
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
