import axios from 'axios';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { StoredCredentials } from '@/persistence';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'],
      scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
});
afterAll(async () => { await runtime?.dispose(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('reads automatic runner credential readiness from admitted requester custody, as Session launch does', async () => {
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = (accountId: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials: StoredCredentials = { token: token('requester'), encryption: null };
  vi.stubEnv('HAPPIER_CODEX_PATH', '/nonexistent/happier-test-codex');
  const requests: Array<{ origin: string; path: string; authorization: unknown }> = [];
  // Only Home HTTP and the Account change socket are substituted. Requester
  // admission, custody selection and credential readiness stay real.
  const record = (url: unknown, config: { headers?: Record<string, unknown> } | undefined) => {
    const parsed = new URL(String(url));
    requests.push({ origin: parsed.origin, path: parsed.pathname, authorization: config?.headers?.Authorization });
    return parsed.pathname;
  };
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = record(url, config);
    if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester' } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    return { status: 404, data: {} };
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
    record(url, config);
    return { status: 404, data: {} };
  });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-root', binding: {
    accountId: 'requester', custodianAccountId: 'host-owner', authentication: { kind: 'account', tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
    actionId: 'agents.models.list', requestId: 'runner', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
  } });
  let custody: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
  try {
    custody = await admitRequesterAccountActionContext({ authorization, credentials, serverId: 'home',
      serverIdentityId: 'home', serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!custody) throw new Error('Requester custody was not admitted');
    requests.length = 0;
    const ownerCredentials = { token: token('host-owner'), encryption: null };
    const signer = vi.fn(() => ({ Authorization: 'Bearer custodian-signed-root' }));
    const inventory = createCliActionInventoryDeps({ credentials: ownerCredentials, token: ownerCredentials.token,
      serverId: 'home', serverHttpBaseUrl: 'https://host-owner-home.test', sessionId: '', mode: 'plain', ctx: null,
      localMachineId: 'machine', authorizeConnectedAccountRequest: signer });
    await inventory.agentsModelsList!({ purpose: 'llm_task_runner', task: 'deploy_suggestion', machineId: 'machine', choice: null },
      { surface: 'cli', externalActionExecutionAuthorization: custody.authorization });
    // The admitted custody, not a signed custodian read under this root, owns
    // the requester's launch credential metadata (Home admits no profile or Team read here).
    expect(signer).not.toHaveBeenCalled();
    expect(requests).toContainEqual({ origin: 'https://requester-home.test',
      path: `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, authorization: `Bearer ${credentials.token}` });
    expect(requests.filter(request => request.authorization !== `Bearer ${credentials.token}`)).toEqual([]);
  } finally {
    await custody?.dispose();
    await channel.close();
  }
});
