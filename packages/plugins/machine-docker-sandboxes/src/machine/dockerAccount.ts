import { PluginError, type PluginConnectedAccountDefinition } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountRuntime, ConnectedAccountPortableRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';

export const DOCKER_ACCOUNT_SERVICE = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker' } as const;
export const DOCKER_ACCOUNT_PURPOSE = 'docker-account';
const keys = ['DOCKER_ID', 'DOCKER_PAT'] as const;
export const dockerCredentialUnavailable = () => new PluginError({ code: 'credential_unavailable',
  message: 'Connect a Docker ID and personal access token.', remediation: { kind: 'selectAccount', service: DOCKER_ACCOUNT_SERVICE } });
function credential(values: Readonly<Record<string, unknown>>, token: string | null | undefined) {
  if (typeof values.username !== 'string' || !values.username.trim() || !token || /[\r\n\0]/u.test(token)) throw dockerCredentialUnavailable();
  return { username: values.username.trim(), token };
}
export const DOCKER_PORTABLE_ACCOUNT_RUNTIME: ConnectedAccountPortableRuntime = {
  authentication: { modes: { pat: { kind: 'manual', async complete(input, context) {
    try {
      const selected = credential(context.configuration.values, input.fields.token);
      await context.attemptCredentials.set('token', selected.token);
      return { status: 'connected', displayName: selected.username, scopes: [],
        ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}) };
    } catch { return { status: 'rejected', diagnostic: { code: 'credential_unavailable', severity: 'error',
      message: 'Enter your Docker ID and personal access token.' } }; }
  } } } },
};
export const DOCKER_CONNECTED_ACCOUNT_RUNTIME: ConnectedAccountRuntime = {
  authentication: DOCKER_PORTABLE_ACCOUNT_RUNTIME.authentication,
  async refresh(context) { return this.status(context); },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async status(context) {
    try { return { status: 'connected', displayName: credential(context.configuration.values, await context.credentials.get('token')).username, scopes: [] }; }
    catch { return { status: 'unavailable' }; }
  },
  async materialize(request, context) {
    if (request.kind !== 'environment' || request.keys.some(key => !keys.some(known => key === known))) throw dockerCredentialUnavailable();
    const selected = credential(context.configuration.values, await context.credentials.get('token'));
    const env: Readonly<Record<string, string>> = { DOCKER_ID: selected.username, DOCKER_PAT: selected.token };
    return { kind: 'environment', env: Object.fromEntries(request.keys.map(key => [key, env[key]])) };
  },
};
export const DOCKER_ACCOUNT_DESCRIPTOR = {
  declaration: { title: 'Docker Hub', ui: { category: 'cloud-machines' }, authentication: {
    account: { artifactId: 'account-runtime', exportName: 'activateAccount' },
    defaultModeId: 'pat',
    modes: [{ id: 'pat', title: 'Personal access token', kind: 'manual', apiKey: true,
      outcomeReconciliation: 'none', credentialOrigin: 'authentication',
      setup: { url: 'https://app.docker.com/settings/personal-access-tokens', createKeyTitle: 'Create Docker personal access token',
        checklist: ['Use a Docker personal access token with Read permission.', 'Select Allow Cloud Sandboxes access to also use Docker cloud.'] },
      configuration: { scope: 'account', changeBehavior: 'reconnect', fields: [{ id: 'username', title: 'Docker ID', required: true, secret: false,
        schema: { type: 'string', minLength: 1 } }] }, credentialFieldKeys: { token: 'token' },
      directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
      fields: [{ id: 'token', title: 'Personal access token', secret: true, schema: { type: 'string', minLength: 1 } }],
    }],
  } }, runtime: DOCKER_CONNECTED_ACCOUNT_RUNTIME, accountRuntime: DOCKER_PORTABLE_ACCOUNT_RUNTIME,
} as const satisfies PluginConnectedAccountDefinition;
export async function prepareDockerAccount(accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'>, signal: AbortSignal) {
  const binding = await accounts.getBinding(DOCKER_ACCOUNT_PURPOSE, { signal });
  if (!binding || binding.account.service.pluginId !== DOCKER_ACCOUNT_SERVICE.pluginId || binding.account.service.localId !== DOCKER_ACCOUNT_SERVICE.localId) throw dockerCredentialUnavailable();
  const material = await accounts.materialize(DOCKER_ACCOUNT_PURPOSE, { kind: 'environment', keys }, { signal, expectedAccount: binding.account });
  if (material.kind !== 'environment') throw dockerCredentialUnavailable();
  return credential({ username: material.env.DOCKER_ID }, material.env.DOCKER_PAT);
}
