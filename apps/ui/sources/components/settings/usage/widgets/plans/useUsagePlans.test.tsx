import { afterEach, expect, it } from 'vitest';
import * as React from 'react';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderHook, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storage';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { useUsagePlans } from './useUsagePlans';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(() => { standardCleanup(); retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined; });

it('refreshes the displayed Usage Resource and creates no independent quota polling demand', async () => {
  home = await serveAccountHomes({ homes: [{ key: 'plans', serverUrl: 'https://usage-plans.test', accountId: 'plans-account' }],
    route: request => request.path === '/v1/features' ? Response.json(createRootLayoutFeaturesResponse({ features: {
      connectedServices: { enabled: true, quotas: { enabled: true } },
    } })) : undefined });
  const serverId = home.homes.plans!.id;
  publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.plans!.serverUrl, generation: 0 });
  const scope = { serverId, accountId: 'plans-account' };
  const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
  storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId, connectedAccountsV4: [
    { ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] },
  ] }) });
  await getServerFeaturesSnapshot({ serverId, force: true });
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.plans!.serverUrl))!;
  const slice = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({})] }).results[0]!;
  let refreshed = false;
  const model = { refreshing: false, refresh: async () => { refreshed = true; } };
  const hook = await renderHook(() => useUsagePlans(slice, model), {
    wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children }),
  });
  await flushHookEffects({ cycles: 20 });
  expect(home.requests.filter(request => request.path.includes('/quotas') || request.path.includes('/provider-account-usage'))).toEqual([]);
  await hook.getCurrent().refresh();
  expect(refreshed).toBe(true);
});
