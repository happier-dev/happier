import axios from 'axios';
import type { AccountScopedCryptoMaterial, ActionExecutorContext } from '@happier-dev/protocol';
import { createWorkspaceExecutionConfigClientV1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigClientV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { getRandomBytes } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';

/** Finite Account/Home-bound row operation, using the incumbent credential lifetime and HTTP carrier. */
export async function createAccountServerWorkspaceWorkerPreferenceClient(input: Readonly<{
  token: string; credentials?: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
  context: ActionExecutorContext; actionId: string; isCredentialCurrent?: () => boolean | Promise<boolean>;
  onRequestIssued?: () => void;
  resolveRequestHeaders(params: Readonly<{context: ActionExecutorContext; effectActionId: string; method: string; path: string; body?: unknown}>): Readonly<Record<string, string>> | null;
}>): Promise<ReturnType<typeof createWorkspaceExecutionConfigClientV1> | null> {
  const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
  const isCurrent = async () => !input.signal?.aborted && lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
    && (!input.isCredentialCurrent || await input.isCredentialCurrent());
  async function request(path: string, body?: unknown) {
    if (!await isCurrent()) throw new Error('workspace_execution_config_scope_retired');
    const method = body === undefined ? 'GET' : 'POST';
    const headers = input.resolveRequestHeaders({context: input.context, effectActionId: input.actionId, method, path, ...(body === undefined ? {} : {body})});
    if (!headers) throw new Error('workspace_execution_config_authorization_unavailable');
    // Mode and CAS-preparation reads have not handed off this Action's effect.
    if (path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`
      || (input.actionId.endsWith('.get') && path === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`)) {
      input.onRequestIssued?.();
    }
    const response = await axios.request<unknown>({ method, url: `${input.serverHttpBaseUrl}${path}`,
      headers: {...headers, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {data: body}),
      signal: input.signal, validateStatus: () => true });
    return response;
  }
  if (!await isCurrent()) return null;
  let mode: Awaited<ReturnType<typeof readAccountEncryptionModeOnce>>;
  try { mode = await readAccountEncryptionModeOnce({request: () => request('/v1/account/encryption')}); }
  catch { return null; }
  if (mode.kind !== 'resolved' || !await isCurrent()) return null;
  let material: AccountScopedCryptoMaterial | null = null;
  if (mode.mode === 'e2ee' && input.credentials?.token === input.token && hasUsableAccountSettingsEncryptionMaterial(input.credentials)) {
    material = input.credentials.encryption.type === 'legacy'
      ? {type: 'legacy', secret: input.credentials.encryption.secret}
      : {type: 'dataKey', machineKey: input.credentials.encryption.machineKey};
  }
  const rowRequest = async (path: string, body: unknown) => {
    const response = await request(path, body);
    if (response.status < 200 || (response.status >= 300 && response.status !== 409)) throw new Error(`workspace_execution_config_http_${response.status}`);
    return response.data;
  };
  return createWorkspaceExecutionConfigClientV1({ mode: mode.mode, material, randomBytes: getRandomBytes, isCurrent, signal: input.signal,
    transport: { read: (body) => rowRequest(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`, body),
      mutate: (body) => rowRequest(`${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`, body) },
  });
}
