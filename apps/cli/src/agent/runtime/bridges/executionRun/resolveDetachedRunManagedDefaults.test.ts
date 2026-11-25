import axios from 'axios';
import { expect, it, vi } from 'vitest';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { findCatalogEntry } from '@/agent/catalog/registry';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import * as persistence from '@/persistence';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveDetachedRunManagedDefaults } from './resolveDetachedRunManagedDefaults';
import { resolveExecutionRunConnectedServicesSelection } from './runtime/connectedServicesEnv';

it('preserves the selected runner model through detached Account defaults', async () => {
  const resolved = await resolveDetachedRunManagedDefaults({
    sessionId: null, intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'clawpatch' },
    runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    modelId: 'runner-model', connectedServices: null, permissionMode: 'read_only',
    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    promptCredentials: bindRequesterSessionCredentialScope({ token: 'fixture', encryption: null }, {
      serverId: 'fixture-home', serverHttpBaseUrl: 'https://fixture.invalid',
    }),
  }, { machineId: 'fixture-machine', agentSandbox: {
    machineIsolation: null, machineIsolationPolicy: null, nativeSandboxAvailable: false,
  } });
  expect(resolved?.modelSelection).toMatchObject({
    agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'runner-model',
  });
});

it('resolves the requester’s saved Muse profile for a detached Run with an empty binding', async () => {
  const serverHttpBaseUrl = 'https://requester.example';
  const credentials = bindRequesterSessionCredentialScope({
    token: `header.${Buffer.from(JSON.stringify({ sub: 'detached-muse-requester' })).toString('base64url')}.signature`,
    encryption: null,
  }, { serverId: 'fixture-home', serverHttpBaseUrl });
  const contributions = getResolvedContributionRegistry();
  const muse = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'muse', contributions })
    ?.authorizedPurposes.find(purpose => purpose.serviceRefs[0]?.localId === 'muse-account');
  const service = muse?.serviceRefs[0];
  if (!muse || !service) throw new Error('Missing the bundled Muse purpose');
  let available = true;
  const store = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  const home = vi.spyOn(axios, 'get').mockImplementation(async (input, config) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(serverHttpBaseUrl);
    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
    if (url.pathname === '/v2/account/settings') return { status: 200,
      data: { content: { t: 'plain', v: {} }, version: 9 } };
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
    if (url.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) {
      if (!available) throw new Error('Purpose catalog unavailable');
      return { status: 200, data: { status: 'present', revision: 3,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{
          purpose: muse.purpose,
          target: { kind: 'account', account: { service, accountId: 'saved-muse-profile' } },
        }] } } } } };
    }
    return { status: 404, data: { error: 'unsupported' } };
  });
  try {
    const leaf = { backendId: 'muse', backendSourceKind: 'built_in', agentCatalogEntry: findCatalogEntry('muse'), contributions };
    const session = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => (
      resolveExecutionRunConnectedServicesSelection(leaf)
    ));
    const bindings = { v: 2, bindingsByServiceId: {
      [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'profile', profileId: 'saved-muse-profile' },
    } };
    expect(session?.bindings).toEqual(bindings);
    const detached = () => resolveDetachedRunManagedDefaults({
      sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'muse' },
      modelId: 'meta/muse-spark-1.3-contributor', connectedServices: { v: 2, bindingsByServiceId: {} },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
      promptCredentials: credentials,
    }, { machineId: 'fixture-machine', agentSandbox: {
      machineIsolation: null, machineIsolationPolicy: null, nativeSandboxAvailable: false,
    } });
    const defaults = await detached();
    expect(defaults?.connectedServices).toEqual(bindings);
    await expect(resolveExecutionRunConnectedServicesSelection({ ...leaf, connectedServices: defaults?.connectedServices }))
      .resolves.toMatchObject({ bindings });
    available = false;
    await expect(detached()).rejects.toMatchObject({
      code: 'connected_services_default_unavailable', reason: 'connected_account_purpose_catalog_unavailable',
      details: { source: 'account_default', phase: 'purpose_binding' },
    });
  } finally {
    home.mockRestore();
    store.mockRestore();
  }
});
