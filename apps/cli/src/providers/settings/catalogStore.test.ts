import axios from 'axios';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema,
  ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { emptyAccountSettingsHistoryCaptureResponse } from '@/settings/accountSettings/emptyAccountSettingsHistoryCapture.testkit';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createCliProviderConnectionsStore, createCliProviderConnectionsStoreForOperation } from './catalogStore';
import { refreshActiveProviderConnectionsCatalog, refreshDemandedActiveProviderConnectionsCatalog } from './hydrate';
import { createCliProviderActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProviderActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { CustomProviderTemplateV1Schema } from '@happier-dev/protocol/providers/connections/customTemplateV1';
import { parseProviderActionRequestV1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { createCliAccountProviderActionExecuteV1 } from '@/providers/connections/accountActions';
import * as persistence from '@/persistence';
import { prepareProviderConnectionsCatalogForCli, refreshProviderConnectionsCatalogForCli } from './hydrate';
import { logger } from '@/ui/logger';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';

import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/deepseek/src/provider/contribution';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

it('refuses a concurrent Account create without replay, then admits an explicit fresh create without losing the winner', async () => {
  const credentials = { token: 'fix-c288-two-writer-fixture', encryption: null };
  let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
  let revision = 7;
  let writes = 0;
  let releaseWrites = () => {};
  const writersReady = new Promise<void>(resolve => { releaseWrites = resolve; });
  let boundaryError: unknown;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.url === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 4,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'GET') {
        response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
      } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(body));
        writes++;
        // Hold the actual commit boundary until both independent writers have
        // captured the same revision; reads used for admission are not this race.
        if (writes === 2) releaseWrites();
        if (writes <= 2) await writersReady;
        if (mutation.expectedRevision !== revision) {
          response.end(JSON.stringify({ status: 'conflict', revision }));
        } else {
          if (mutation.content?.t !== 'plain') throw new Error('Expected Plain catalog fixture');
          catalog = mutation.content.v;
          revision++;
          response.end(JSON.stringify({ status: 'updated', revision, cursor: revision }));
        }
      } else throw new Error(`Unexpected two-writer boundary: ${request.method} ${request.url}`);
    } catch (error) {
      boundaryError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'invalid-fixture-request' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const create = (suffix: string) => runWithServerHttpBaseUrl(base, async () => {
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
        serverHttpBaseUrl: base, isCurrent: async () => true });
      const execute = createCliAccountProviderActionExecuteV1({ credentials, operationContext, serverHttpBaseUrl: base,
        readDefinitions: async () => [{ contributionKey: 'happier.provider.deepseek/deepseek',
          definition: DEEPSEEK_PROVIDER_CONTRIBUTION, provenance: 'first_party' }] });
      return execute(parseProviderActionRequestV1('providers.connections.create_contribution', {
        action: 'createContribution', connectionId: `pc_fix_c288_${suffix}`,
        contributionKey: 'happier.provider.deepseek/deepseek', displayName: suffix, savedSecretId: null, enable: false,
      }), { surface: 'cli' });
    });
    const results = await Promise.all(['first', 'second'].map(create));
    expect(boundaryError).toBeUndefined();
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false, errorCode: 'provider_connection_changed',
      details: { retryable: true, action: 'review_connection' } });
    expect(catalog.connections).toHaveLength(1);
    expect(revision).toBe(8);
    expect(writes).toBe(2);
    // The person can submit again after reviewing current state; the failed
    // invocation itself never dispatches a second catalog mutation.
    expect(await create(results[0]?.ok ? 'second' : 'first')).toMatchObject({ ok: true });
    expect(catalog.connections.map(row => row.id).sort()).toEqual(['pc_fix_c288_first', 'pc_fix_c288_second']);
    expect(revision).toBe(9);
    expect(writes).toBe(3);
  } finally {
    releaseWrites();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each(['unchanged', 'catalog-edited-before-approval', 'connection-edited', 'catalog-raced'] as const)(
  'approves a Gateway hub update through the real Account executor and HTTP catalog store: %s', async scenario => {
    const credentials = { token: 'gateway-approval-http-fixture', encryption: null };
    let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
    let revision = 7;
    let raceNextWrite = false;
    let commitCompetingEdit: (() => Promise<void>) | undefined;
    let writes = 0;
    let boundaryError: unknown;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.url === '/v1/account/encryption/currentness') {
          response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 4,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'GET') {
          response.end(JSON.stringify({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
        } else if (request.url === '/v1/account/entity-rows/provider-connections' && request.method === 'POST') {
          let body = '';
          for await (const chunk of request) body += String(chunk);
          const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(body));
          writes++;
          if (raceNextWrite) {
            raceNextWrite = false;
            if (!commitCompetingEdit) throw new Error('Missing competing catalog Action');
            await commitCompetingEdit();
          }
          if (mutation.expectedRevision !== revision) {
            response.end(JSON.stringify({ status: 'conflict', revision }));
          } else {
            if (mutation.content?.t !== 'plain') throw new Error('Expected Plain catalog fixture');
            catalog = mutation.content.v;
            revision++;
            response.end(JSON.stringify({ status: 'updated', revision, cursor: revision }));
          }
        } else {
          throw new Error(`Unexpected Gateway approval HTTP request: ${request.method} ${request.url}`);
        }
      } catch (error) {
        boundaryError = error;
        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'invalid-fixture-request' }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runWithServerHttpBaseUrl(base, async () => {
        const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
          serverHttpBaseUrl: base, isCurrent: async () => true });
        let approval: ApprovalRequestV2 | null = null;
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
          isApprovalExecutionOriginCurrent: async () => true,
          approvalsCreate: async ({ request }) => {
            approval = ApprovalRequestV2Schema.parse(request);
            return { artifactId: 'gateway-hub-approval' };
          },
          approvalsGet: async () => approval && structuredClone(approval),
          approvalsUpdate: async ({ request }) => {
            if (!approval) throw new Error('Missing Gateway approval');
            const next = ApprovalRequestV2Schema.parse(request);
            const transition = decideApprovalRequestTransition(approval, next);
            if (!transition.ok) return transition;
            approval = structuredClone(next);
            return { ok: true };
          },
          providerActionExecute: createCliProviderActionExecuteV1({ credentials, operationContext,
            serverId: 'gateway-home', serverHttpBaseUrl: base,
            callMachineAction: async () => { throw new Error('Account hub update must not invoke Machine RPC'); } }),
        });
        const invocation = { surface: 'cli' as const, serverId: 'gateway-home', authority: 'present_user' as const,
          actionCaller: { kind: 'host' as const }, actionRequestId: 'gateway-hub-request' };
        commitCompetingEdit = async () => {
          expect(await executor.execute('providers.models.source_visibility.set', {
            action: 'setConnectionVisibility', connectionId: 'pc_hub_approval', shown: false,
          }, { ...invocation, presentUserConfirmation: { actionId: 'providers.models.source_visibility.set' } }))
            .toMatchObject({ ok: true });
        };
        const creation = await executor.execute('providers.connections.create_contribution', {
          action: 'createContribution', connectionId: 'pc_hub_approval',
          contributionKey: 'happier.provider.cliproxyapi/cliproxyapi', displayName: 'Approval Gateway',
          savedSecretId: null, enable: false, deployment: { kind: 'managedLocal', purposeBindingDefaults: {} },
        }, { ...invocation, presentUserConfirmation: { actionId: 'providers.connections.create_contribution' } });
        expect(creation, JSON.stringify(creation)).toMatchObject({ ok: true });
        const created = catalog.connections[0]!;
        expect(created).toMatchObject({ revision: 1, deployment: { kind: 'managedLocal' } });
        expect(await executor.execute('providers.connections.update', {
          action: 'update', connectionId: created.id, expectedRevision: created.revision,
          gatewayPlacement: { kind: 'machine', machineId: 'hub-machine' },
        }, invocation)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(writes).toBe(1);
        if (scenario === 'connection-edited') {
          expect(await executor.execute('providers.connections.update', {
            action: 'update', connectionId: created.id, expectedRevision: created.revision, displayName: 'Concurrent name',
          }, { ...invocation, presentUserConfirmation: { actionId: 'providers.connections.update' } })).toMatchObject({ ok: true });
        }
        if (scenario === 'catalog-edited-before-approval') await commitCompetingEdit();
        raceNextWrite = scenario === 'catalog-raced';
        const decided = await executor.execute('approval.request.decide', {
          artifactId: 'gateway-hub-approval', decision: 'approve',
        }, invocation);
        expect(boundaryError).toBeUndefined();
        const applied = scenario === 'unchanged' || scenario === 'catalog-edited-before-approval';
        expect(decided).toMatchObject({ ok: true, result: { execution: applied ? { ok: true }
          : { ok: false, errorCode: 'provider_connection_changed', details: { action: 'review_connection' } } } });
        const observed = await executor.execute('providers.connections.describe', { connectionId: created.id }, invocation);
        expect(observed).toMatchObject({ ok: true, result: { connections: [applied
          ? { connectionId: created.id, revision: 2, gatewayPlacement: { kind: 'machine', machineId: 'hub-machine' } }
          : { connectionId: created.id, revision: scenario === 'connection-edited' ? 2 : 1 }] } });
        expect(catalog.connections[0]?.gatewayPlacement).toEqual(applied ? { kind: 'machine', machineId: 'hub-machine' } : undefined);
        if (scenario === 'catalog-raced' || scenario === 'catalog-edited-before-approval') {
          expect(catalog.modelPickerVisibilityByConnectionId?.[created.id]).toBe(false);
        }
        // One admitted effect; a refused CAS must settle without retrying the mutation.
        expect(writes).toBe(scenario === 'catalog-raced' || scenario === 'catalog-edited-before-approval' ? 3 : 2);
      });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  },
);

it('does no source or history GETs for repeated post-cutover catalog reads', async () => {
  const credentials = { token: 'provider-cutover-cost', encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    return emptyAccountSettingsHistoryCaptureResponse(path) ?? { status: 404, data: {} };
  });
  const store = createCliProviderConnectionsStore({ credentials });
  for (let index = 0; index < 25; index++) expect(await store.readCatalog()).toMatchObject({ status: 'ready' });
  expect(reads.filter(path => path.startsWith('/v2/account/settings'))).toEqual([]);
  expect(reads.filter(path => path === '/v1/account/entity-rows/provider-connections')).toHaveLength(25);
});

it.each([
  { revision: 4, custody: 'daemon' }, { revision: 'absent', custody: 'daemon' },
  { revision: 4, custody: 'requester' }, { revision: 'absent', custody: 'requester' },
] as const)('reobserves only current Provider authority and preserves activation ($revision, $custody)', async ({ revision, custody }) => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: `provider-current-${revision}-${custody}` })).toString('base64url')}.signature`, encryption: null };
  const requests: string[] = [];
  const mutations: ReturnType<typeof ProviderConnectionsRowMutationV1Schema.parse>[] = [];
  let activated = revision !== 'absent';
  let revokeAfterRow = false;
  let revoked = false;
  let boundaryError: unknown;
  const server = createServer(async (request, response) => {
    const path = request.url;
    requests.push(`${request.method} ${path}`);
    response.setHeader('Content-Type', 'application/json');
    try {
      if (path === '/v1/account/encryption/currentness') {
        response.statusCode = revoked ? 401 : 200;
        response.end(JSON.stringify(revoked ? { error: 'unauthorized' } : { mode: 'plain', version: 1,
          settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      } else if (path === '/v1/account/entity-rows/provider-connections' && request.method === 'GET') {
        if (revokeAfterRow) revoked = true;
        response.end(JSON.stringify(activated ? { status: 'present', revision: 5,
          content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } : { status: 'absent' }));
      } else if (path === '/v1/account/entity-rows/provider-connections' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        mutations.push(ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(body)));
        activated = true;
        response.end(JSON.stringify({ status: 'updated', revision: 5, cursor: 1 }));
      } else if (path === '/v2/account/settings' && request.method === 'GET') {
        response.end(JSON.stringify({ version: 7, content: { t: 'plain', v: {} } }));
      } else if (path === '/v2/account/settings/history') {
        response.end(JSON.stringify({ snapshots: [] }));
      } else {
        const capture = emptyAccountSettingsHistoryCaptureResponse(path ?? '');
        response.statusCode = capture?.status ?? 404;
        response.end(JSON.stringify(capture?.data ?? { error: 'unsupported' }));
      }
    } catch (error) {
      boundaryError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'invalid-fixture-request' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        providerConnectionsCatalog: { status: 'ready' as const, revision, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } };
      // Custody admission is the requester boundary; Account-mode/currentness
      // before disclosure still goes through real HTTP after the row response.
      const operationContext = custody === 'requester' ? createInvocationSavedSecretOperationContextV1({
        credentials, snapshot, serverHttpBaseUrl: base, isCurrent: async () => true,
      }) : undefined;
      setActiveAccountSettingsSnapshot(operationContext ? { ...snapshot, scopeKey: 'foreign-daemon',
        providerConnectionsCatalog: { ...snapshot.providerConnectionsCatalog, revision: revision === 'absent' ? 4 : 'absent' } } : snapshot);
      const daemonSnapshot = getActiveAccountSettingsSnapshot();
      const input = { expectedScopeKey: snapshot.scopeKey, credentials, operationContext };
      expect(await refreshProviderConnectionsCatalogForCli(input)).toMatchObject({ status: 'ready', revision: 5 });
      expect(boundaryError).toBeUndefined();
      if (revision === 'absent') {
        expect(mutations).toMatchObject([{ expectedRevision: 'absent', sourceSettingsVersion: 7 }]);
      } else {
        expect(mutations).toEqual([]);
        expect(requests.filter(path => path !== 'GET /v1/account/entity-rows/provider-connections'
          && path !== 'GET /v1/account/encryption/currentness')).toEqual([]);
        revokeAfterRow = true;
        expect(await refreshProviderConnectionsCatalogForCli(input)).not.toMatchObject({ status: 'ready' });
        expect(revoked).toBe(true);
        expect((operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.providerConnectionsCatalog)
          .not.toMatchObject({ status: 'ready' });
      }
      if (operationContext) expect(getActiveAccountSettingsSnapshot()).toBe(daemonSnapshot);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.each([4, 'absent'] as const)('refreshes demanded Provider authority while preserving absent-destination activation (revision=%s)', async revision => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: `provider-demand-${revision}` })).toString('base64url')}.signature`, encryption: null };
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
    providerConnectionsCatalog: { status: 'ready', revision, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  let activated = revision !== 'absent';
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: activated
      ? { status: 'present', revision: 2, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } }
      : { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    return emptyAccountSettingsHistoryCaptureResponse(path) ?? { status: 404, data: {} };
  });
  const writes = vi.spyOn(axios, 'post').mockImplementation(async (input, body) => {
    expect(new URL(String(input)).pathname).toBe('/v1/account/entity-rows/provider-connections');
    expect(ProviderConnectionsRowMutationV1Schema.parse(body)).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 7 });
    activated = true;
    return { status: 200, data: { status: 'updated', revision: 2, cursor: 1 } };
  });
  await refreshDemandedActiveProviderConnectionsCatalog({ token: credentials.token });
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: 2 });
  if (revision === 'absent') expect(writes).toHaveBeenCalledTimes(1);
  else {
    expect(writes).not.toHaveBeenCalled();
    expect(reads.filter(path => path !== '/v1/account/entity-rows/provider-connections'
      && path !== '/v1/account/encryption/currentness')).toEqual([]);
  }
});

it.each(['readCatalogForMutation', 'readCatalog', 'prepare', 'refresh'] as const)('uses local requester authority for %s and refuses the next read after retirement', async method => {
  const f = await createProjectSessionRuntimeFixture();
  await f.bootstrap.ensureAccountSettingsCurrent();
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let profileReads = 0;
  let rowReads = 0;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') profileReads++;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      rowReads++;
      return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    }
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    return get(url, options);
  });
  const store = createCliProviderConnectionsStoreForOperation({ operationContext: f.bootstrap.savedSecretOperationContext });
  const expectedScopeKey = f.bootstrap.savedSecretOperationContext.readSnapshot()!.scopeKey!;
  const read = () => method === 'prepare' || method === 'refresh'
    ? (method === 'prepare' ? prepareProviderConnectionsCatalogForCli : refreshProviderConnectionsCatalogForCli)({
      expectedScopeKey,
      operationContext: f.bootstrap.savedSecretOperationContext,
    })
    : method === 'readCatalogForMutation' ? store.readCatalogForMutation()
      : store.readCatalog();
  expect(await read()).toMatchObject({ status: 'ready' });
  // The captured requester owns its local lifetime; no remote Profile read
  // reauthorizes the same admitted operation.
  expect(profileReads).toBe(0);
  const admittedRowReads = rowReads;
  expect(admittedRowReads).toBeGreaterThan(0);
  await f.bootstrap.dispose();
  if (method === 'prepare' || method === 'refresh') {
    await expect(read()).resolves.toMatchObject({ status: 'unavailable', reason: 'scope-retired' });
  } else {
    await expect(read()).rejects.toMatchObject({ code: 'scope-retired' });
  }
  expect(rowReads).toBe(admittedRowReads);
  expect(profileReads).toBe(0);
});

it.each([false, true])('requires a live requester before history cleanup within a catalog read (revoked=%s)', async revoked => {
  const f = await createProjectSessionRuntimeFixture();
  await f.bootstrap.savedSecretOperationContext.commitProviderConnectionsCatalog({ expectedSettingsVersion: 0, catalog: {
    status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' },
  } });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let writes = 0;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
      version: 6, contentKind: 'plain', byteLength: 100, createdAt: '2026-01-01T00:00:00.000Z' }] } };
    if (path === '/v2/account/settings/history/6') {
      if (revoked) await f.bootstrap.dispose();
      return { status: 200, data: { version: 6, content: { t: 'plain', v: {
        providerSettingsV1: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} },
      } }, createdAt: '2026-01-01T00:00:00.000Z' } };
    }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    return history ?? get(url, options);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    expect(new URL(String(url)).pathname).toBe('/v2/account/settings/history/6/mutate');
    writes++;
    return { status: 200, data: { status: 'applied' } };
  });
  const store = createCliProviderConnectionsStoreForOperation({ operationContext: f.bootstrap.savedSecretOperationContext });
  if (revoked) await expect(store.readCatalog()).rejects.toMatchObject({ code: 'scope-retired' });
  else expect(await store.readCatalog()).toMatchObject({ status: 'ready', cleanup: { status: 'complete' } });
  expect(writes).toBe(revoked ? 0 : 1);
});

it('keeps one history read checkpoint after public catalog readiness has returned', async () => {
  const f = await createProjectSessionRuntimeFixture();
  await f.bootstrap.savedSecretOperationContext.commitProviderConnectionsCatalog({ expectedSettingsVersion: 0, catalog: {
    status: 'ready', revision: 1, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' },
  } });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let profileReads = 0;
  let historyReads = 0;
  let releaseHistory!: () => void;
  const heldHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
  let finishHistory!: () => void;
  const historyFinished = new Promise<void>(resolve => { finishHistory = resolve; });
  vi.spyOn(logger, 'infoFile').mockImplementation((message, facts) => {
    if (message === '[PROVIDER] Catalog phase' && facts !== null && typeof facts === 'object'
      && 'phase' in facts && facts.phase === 'history' && 'status' in facts && facts.status === 'completed') finishHistory();
  });
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') profileReads++;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 0,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    if (path === '/v2/account/settings/history') {
      historyReads++;
      if (historyReads === 1) await heldHistory;
      return { status: 200, data: { snapshots: [] } };
    }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    return history ?? get(url, options);
  });
  try {
    expect(await refreshProviderConnectionsCatalogForCli({
      expectedScopeKey: f.bootstrap.savedSecretOperationContext.readSnapshot()!.scopeKey!,
      operationContext: f.bootstrap.savedSecretOperationContext,
    })).toMatchObject({ status: 'ready' });
    const beforeRemainingHistory = profileReads;
    releaseHistory();
    await historyFinished;
    expect(historyReads).toBe(1);
    expect(profileReads).toBe(beforeRemainingHistory);
  } finally { releaseHistory(); }
});

it.each([false, true])('refuses Provider source activation after requester disposal inside a read checkpoint (revoked=%s)', async revoked => {
  const raw = { providerSettingsV1: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} } };
  const f = await createProjectSessionRuntimeFixture({ accountSettings: raw });
  const get = vi.mocked(axios.get).getMockImplementation()!;
  let row: unknown = { status: 'absent' };
  let rowRead = false;
  let writes = 0;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/entity-rows/provider-connections') { rowRead = true; return { status: 200, data: row }; }
    if (path === '/v2/account/settings' && rowRead && revoked) await f.bootstrap.dispose();
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    return get(url, options);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (new URL(String(url)).pathname === '/v1/account/entity-rows/provider-connections') {
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      writes++;
      row = { status: 'present', revision: 1, content: mutation.content };
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    }
    // Leave optional source cleanup pending after the admitted activation.
    return { status: 409, data: { success: false, error: 'version-mismatch', currentVersion: 0,
      currentContent: { t: 'plain', v: raw } } };
  });
  const result = await (async () => {
    expect(await f.bootstrap.isCurrent()).toBe(true);
    try { return await createCliProviderConnectionsStoreForOperation({ operationContext: f.bootstrap.savedSecretOperationContext }).readCatalog(); }
    catch (error) { if (!revoked) throw error; return null; }
  })();
  expect(rowRead).toBe(true);
  if (revoked) {
    expect(writes).toBe(0);
    expect(result).not.toMatchObject({ status: 'ready' });
  } else {
    expect(writes).toBe(1);
    expect(result).toMatchObject({ status: 'ready', catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
  }
});

it.each([['cold', false], ['cold', true], ['reobserve', false], ['joined-equal', false], ['joined-reobserve', false], ['repeated-reobserve', false], ['late-reobserve', false]] as const)('admits a newly observed daemon catalog before history cleanup (mode=%s, cancel=%s)', async (mode, cancelCleanup) => {
  const controller = new AbortController();
  const revision = mode === 'joined-equal' ? 6 : 7;
  let observedRevision = revision;
  const credentials = { token: 'provider-cold-demand', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  let raw: Readonly<Record<string, unknown>> = { providerSettingsV1: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, defaultsByAgentTargetKey: {} } };
  let settingsVersion = 4;
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(raw), rawSettings: raw,
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
    ...(mode !== 'cold' ? { providerConnectionsCatalog: { status: 'ready' as const, revision: 6, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } : {}),
  });
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  let releaseRow = () => {};
  let enterRow = () => {};
  let releaseHistory = () => {};
  let enterHistory = () => {};
  const rowReleased = new Promise<void>(resolve => { releaseRow = resolve; });
  const rowEntered = new Promise<void>(resolve => { enterRow = resolve; });
  const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve; });
  const historyEntered = new Promise<void>(resolve => { enterHistory = resolve; });
  let rowReads = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      rowReads++;
      enterRow(); await rowReleased;
      return { status: 200, data: { status: 'present', revision: observedRevision,
        content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
    if (path === '/v2/account/settings/history') {
      enterHistory(); await historyReleased;
      return { status: 200, data: { snapshots: [] } };
    }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected cold Provider HTTP boundary: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(new URL(String(url)).pathname).toBe('/v2/account/settings');
    const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
    if (!mutation.content || mutation.content.t !== 'plain') throw new Error('Plain fixture requires Plain settings');
    raw = mutation.content.v;
    settingsVersion++;
    return { status: 200, data: { success: true, version: settingsVersion } };
  });
  let admitted: Awaited<ReturnType<typeof prepareProviderConnectionsCatalogForCli>> | undefined;
  // Existing active current readers no longer own optional maintenance. Start
  // that explicit work separately to retain its first-ready/joining contract.
  const firstRefresh = mode !== 'cold'
    ? refreshActiveProviderConnectionsCatalog({ credentials }) : undefined;
  if (firstRefresh) await rowEntered;
  const read = mode === 'reobserve' || mode === 'joined-reobserve' || mode === 'repeated-reobserve' || mode === 'late-reobserve'
    ? refreshProviderConnectionsCatalogForCli : prepareProviderConnectionsCatalogForCli;
  const demand = read({ expectedScopeKey: scopeKey, signal: controller.signal })
    .then(catalog => { admitted = catalog; return catalog; });
  await rowEntered;
  const publications: (number | 'absent')[] = [];
  const unsubscribe = subscribeActiveAccountSettingsSnapshot((previous, next) => {
    // Source contraction also publishes a genuine preference change. Count
    // newly admitted row revisions, not all Account publications carrying it.
    if (next?.providerConnectionsCatalog?.status === 'ready'
      && (previous?.providerConnectionsCatalog?.status !== 'ready'
        || previous.providerConnectionsCatalog.revision !== next.providerConnectionsCatalog.revision)) {
      publications.push(next.providerConnectionsCatalog.revision);
    }
  });
  const readers = mode === 'repeated-reobserve' ? Array.from({ length: 12 }, () =>
    refreshProviderConnectionsCatalogForCli({ expectedScopeKey: scopeKey })) : [];
  let completed = false;
  const maintenance = (firstRefresh ?? refreshActiveProviderConnectionsCatalog({ credentials })).then(() => { completed = true; });
  try {
    releaseRow();
    await historyEntered;
    await vi.waitFor(() => expect(admitted).toMatchObject({ status: 'ready', revision }));
    expect(completed).toBe(false);
    if (mode === 'late-reobserve') {
      observedRevision = 8;
      readers.push(...Array.from({ length: 12 }, () => refreshProviderConnectionsCatalogForCli({ expectedScopeKey: scopeKey })));
    }
    if (mode === 'repeated-reobserve' || mode === 'late-reobserve') {
      let settled = false;
      const resolved = Promise.all(readers).then(catalogs => { settled = true; return catalogs; });
      await vi.waitFor(() => expect(settled).toBe(true));
      for (const catalog of await resolved) expect(catalog).toMatchObject({ status: 'ready', revision: observedRevision });
      expect(publications.filter(value => value === revision)).toEqual([revision]);
    }
    if (cancelCleanup) controller.abort();
  } finally { releaseRow(); releaseHistory(); await demand; await maintenance; await Promise.all(readers); unsubscribe(); }
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ status: 'ready', revision: observedRevision });
  if (mode === 'joined-equal') {
    expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({ cleanup: { status: 'complete' } });
  }
  // History cleanup consumes the admitted catalog without re-reading its authority.
  // A later current-only read adds one row read, not another history census.
  expect(rowReads).toBe(mode === 'late-reobserve' ? 2 : 1);
});

it('refuses a custom model list from a credential retired after catalog admission without reading declarations or refreshing projections', async () => {
  const credentials = { token: 'provider-retiring-reader', encryption: null };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 4,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  let current = true;
  let retireAfterAdmission = false;
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://retiring-provider-home.invalid', isCurrent: async () => {
      const admitted = current;
      if (retireAfterAdmission) queueMicrotask(() => { current = false; });
      return admitted;
    } });
  const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_reader', source: { kind: 'custom', template: { v: 1, name: 'Reader',
      endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://reader.invalid/v1', capabilities: {
        streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' } } }, role: 'named', displayName: 'Reader',
      displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 }] });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      retireAfterAdmission = true;
      return { status: 200, data: { status: 'present', revision: 7, content: { t: 'plain', v: catalog } } };
    }
    throw new Error(`Pure model read must not refresh Account projections: ${path}`);
  });
  const execute = createCliAccountProviderActionExecuteV1({ credentials, operationContext,
    serverHttpBaseUrl: 'https://retiring-provider-home.invalid', readDefinitions: async () => {
      throw new Error('Custom source must not load plugin declarations');
    } });
  await expect(execute(parseProviderActionRequestV1('providers.models.list', { connectionId: 'pc_reader' }),
    { surface: 'cli' })).rejects.toMatchObject({ code: 'scope-retired' });
});

it.each(['updated', 'uninitialized', 'conflict', 'rollback', 'outcome_unknown'] as const)('authors a Provider through its captured Account without a machine: %s', async outcome => {
  const credentials = { token: 'provider-account-authoring', encryption: null };
  const retained = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_retained', source: { kind: 'contribution', contributionKey: 'legacy.provider/source' },
      role: 'named', displayName: 'Retained', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 }] });
  let settingsRaw: Record<string, unknown> = outcome === 'uninitialized' ? { unrelatedPreference: 'keep',
    providerSettingsV1: { ...retained, defaultsByAgentTargetKey: {} } } : {};
  let settingsVersion = 4;
  const snapshot = { source: 'network' as const, settings: accountSettingsParse(settingsRaw), rawSettings: settingsRaw,
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://provider-authoring-home.invalid', isCurrent: async () => true });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-ambient-account' });
  let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
  let present = outcome !== 'uninitialized';
  let revision = 7;
  const submitted: unknown[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-authoring-home.invalid');
    if (endpoint.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
      ...(present ? { status: 'present', revision, content: { t: 'plain', v: catalog } } : { status: 'absent' }) } };
    if (endpoint.pathname === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: settingsRaw } } };
    if (endpoint.pathname === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(endpoint.pathname);
    if (history) return history;
    throw new Error(`Unexpected Account Provider read: ${endpoint.pathname}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (new URL(String(url)).pathname === '/v2/account/settings') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(settingsVersion);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must keep Plain preferences');
      settingsRaw = mutation.content.v;
      settingsVersion++;
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    expect(String(url)).toBe('https://provider-authoring-home.invalid/v1/account/entity-rows/provider-connections');
    const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
    submitted.push(mutation);
    expect(mutation.expectedRevision).toBe(present ? revision : 'absent');
    if (outcome === 'conflict') return { status: 409, data: { status: 'conflict', revision: revision + 1 } };
    if (outcome === 'rollback') return { status: 503, data: { error: 'database_transaction_conflict_exhausted', statusCode: 503 } };
    if (mutation.content?.t !== 'plain') throw new Error('Plain Account must keep a Plain catalog');
    catalog = mutation.content.v;
    present = true;
    revision += 1;
    if (outcome === 'outcome_unknown') throw new Error('Lost acknowledgement after durable commit');
    return { status: 200, data: { status: 'updated', revision, cursor: revision } };
  });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), providerActionExecute: createCliProviderActionExecuteV1({ credentials,
    operationContext, serverId: 'provider-home', serverHttpBaseUrl: 'https://provider-authoring-home.invalid',
    callMachineAction: async () => { throw new Error('Account Provider authoring must not call a machine'); } }) });
  const context = { surface: 'cli' as const, serverId: 'provider-home', authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
  const execute = (actionId: Parameters<typeof executor.execute>[0], input: unknown) => executor.execute(actionId, input,
    { ...context, presentUserConfirmation: { actionId } });
  const template = CustomProviderTemplateV1Schema.parse({ v: 1, name: 'Account Provider',
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat', baseUrl: 'https://provider.invalid/v1',
      capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' } }],
    catalog: { source: 'manual', manualModelPolicy: 'allowed' } });
  const result = await execute('providers.connections.create_custom', { action: 'createCustom',
    connectionId: 'pc_account', template, savedSecretId: null, enable: false });
  expect(submitted, JSON.stringify(result)).toHaveLength(outcome === 'uninitialized' ? 2 : 1);
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('unrelated-ambient-account');
  if (outcome === 'rollback') {
    expect(result).toMatchObject({ ok: false, errorCode: 'provider_catalog_unavailable',
      details: { code: 'provider_catalog_unavailable', retryable: true, action: 'retry' } });
    expect(catalog.connections).toEqual([]);
    return;
  }
  if (outcome !== 'updated' && outcome !== 'uninitialized') {
    expect(result).toMatchObject({ ok: false, errorCode: outcome === 'conflict' ? 'provider_connection_changed' : `provider_catalog_${outcome}`,
      ...(outcome === 'conflict' ? { details: { retryable: true, action: 'review_connection' } } : {}) });
    expect(catalog.connections).toHaveLength(outcome === 'conflict' ? 0 : 1);
    return;
  }
  expect(result).toMatchObject({ ok: true, result: { status: 'success', action: 'createCustom', connection: { connectionId: 'pc_account' } } });
  expect(await execute('providers.connections.update', { action: 'update', connectionId: 'pc_account',
    expectedRevision: 0, displayName: 'Renamed Account Provider', displayNameMode: 'custom' })).toMatchObject({ ok: true });
  expect(await execute('providers.models.manual.add', { action: 'manualAdd', connectionId: 'pc_account',
    expectedConnectionRevision: 1, models: [{ id: 'manual-model' }] })).toMatchObject({ ok: true });
  expect(catalog.manualModelsByConnectionId[ProviderConnectionIdSchema.parse('pc_account')]).toMatchObject([{ id: 'manual-model' }]);
  expect(await execute('providers.connections.describe', { connectionId: 'pc_account' })).toMatchObject({
    ok: true, result: { status: 'success', connections: [{ connectionId: 'pc_account', displayName: 'Renamed Account Provider' }] } });
  expect(await execute('providers.connections.delete', { action: 'delete', connectionId: 'pc_account' })).toMatchObject({ ok: true });
  expect(catalog.connections).toEqual(outcome === 'uninitialized' ? retained.connections : []);
  if (outcome === 'uninitialized') expect(settingsRaw).toEqual({ unrelatedPreference: 'keep', providerDefaultModelSelectionsByAgentTargetKeyV1: {} });
  expect(catalog.manualModelsByConnectionId).toEqual({});
});

it.each(['empty', 'retained', 'personal'] as const)('uses personal-reference demand before activating a %s Provider source in its initiating Home', async sourceKind => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'provider-captured-source-owner' })).toString('base64url')}.signature`, encryption: null };
  const sourceCatalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: sourceKind === 'empty' ? [] : [{ v: 1, id: 'pc_source', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'named', displayName: 'Retained source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
    ...(sourceKind === 'personal' ? { secretBindingsByConnectionId: { pc_source: { account: { apiKey: 'locked-unrelated' } } } } : {}) });
  let raw: Record<string, unknown> = { unrelatedPreference: { keep: true }, secrets: [{ id: 'locked-unrelated', name: 'Locked',
    kind: 'token', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'unopenable' } }, createdAt: 1, updatedAt: 1 }],
    ...(sourceKind !== 'empty' ? { providerSettingsV1: { ...sourceCatalog, defaultsByAgentTargetKey: {} } } : {}) };
  let settingsVersion = 4;
  const snapshot = { source: 'network' as const, settings: accountSettingsParse(raw), rawSettings: raw,
    settingsVersion, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://provider-source-home.invalid', isCurrent: async () => true });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-ambient-account' });
  let catalog: typeof sourceCatalog | undefined;
  let resourceReads = 0;
  let unrelatedProfileReads = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-source-home.invalid');
    const path = endpoint.pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: catalog
      ? { status: 'present', revision: 1, content: { t: 'plain', v: catalog } } : { status: 'absent' } };
    if (path === '/v2/account/settings') return { status: 200, data: { version: settingsVersion, content: { t: 'plain', v: raw } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/account/entity-rows/profiles') { unrelatedProfileReads += 1; return { status: 503, data: { error: 'locked_unrelated_source' } }; }
    if (path === '/v1/saved-secrets') { resourceReads += 1; return { status: 403, data: { error: 'forbidden' } }; }
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected captured Provider HTTP boundary: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const endpoint = new URL(String(url));
    expect(endpoint.origin).toBe('https://provider-source-home.invalid');
    if (endpoint.pathname === '/v1/account/entity-rows/provider-connections') {
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe('absent');
      expect(mutation.savedSecretRevisions).toEqual([]);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must write a Plain catalog');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
    }
    if (endpoint.pathname === '/v2/account/settings') {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(body);
      expect(mutation.expectedVersion).toBe(settingsVersion);
      if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must retain Plain Settings');
      raw = mutation.content.v;
      settingsVersion += 1;
      return { status: 200, data: { success: true, version: settingsVersion } };
    }
    throw new Error(`Unexpected captured Provider write: ${endpoint.pathname}`);
  });
  const read = createCliProviderConnectionsStoreForOperation({ operationContext }).readCatalog();
  if (sourceKind === 'personal') {
    expect(await read).toMatchObject({ status: 'unavailable' });
    expect(catalog).toBeUndefined();
    expect(raw.providerSettingsV1).toEqual(snapshot.rawSettings.providerSettingsV1);
  } else {
    expect(await read).toMatchObject({ status: 'ready', revision: 1, catalog: { connections: sourceCatalog.connections } });
    expect(raw).not.toHaveProperty('providerSettingsV1');
  }
  expect(raw.secrets).toEqual(snapshot.rawSettings.secrets);
  expect(raw.unrelatedPreference).toEqual({ keep: true });
  expect(resourceReads).toBe(0);
  expect(unrelatedProfileReads).toBe(sourceKind === 'personal' ? 1 : 0);
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('unrelated-ambient-account');
});

it('opens keyless Plain Provider rows and refuses a late row from a retired Account lifetime', async () => {
  const credentials = { token: 'provider-catalog-owner', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey };
  setActiveAccountSettingsSnapshot(snapshot);
  let release: (() => void) | undefined;
  const rowWait = new Promise<void>(resolve => { release = resolve; });
  let rowEntered: (() => void) | undefined;
  const rowStarted = new Promise<void>(resolve => { rowEntered = resolve; });
  let block = false;
  vi.spyOn(axios, 'get').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      if (block) { rowEntered?.(); await rowWait; }
      return { status: 200, data: { status: 'present', revision: 7, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const historyResponse = emptyAccountSettingsHistoryCaptureResponse(path);
    if (historyResponse) return historyResponse;
    throw new Error(`Unexpected Provider HTTP boundary: ${path}`);
  });
  const store = createCliProviderConnectionsStore({ credentials });
  expect(await store.readCatalog()).toMatchObject({ status: 'ready', revision: 7, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
  block = true;
  const pending = store.readCatalog();
  await rowStarted;
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'replacement', settingsVersion: 1 });
  release?.();
  await expect(pending).rejects.toMatchObject({ code: 'scope-retired' });
  expect(getActiveAccountSettingsSnapshot()?.scopeKey).toBe('replacement');
});

it('reads retained row authority in its issued invocation Home without activating an absent catalog', async () => {
  const phases = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
  const credentials = { token: 'provider-invocation-owner', encryption: null };
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) };
  let current = true;
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: 'https://captured-provider-home.invalid', isCurrent: async () => current });
  setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: 'unrelated-daemon-account' });
  let row: { status: 'absent' } | { status: 'deleted'; revision: number } = { status: 'absent' };
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    expect(String(url)).toBe('https://captured-provider-home.invalid/v1/account/entity-rows/provider-connections');
    return { status: 200, data: row };
  });
  const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected Provider mutation'));
  const store = createCliProviderConnectionsStoreForOperation({ operationContext });
  expect(await store.readRow()).toEqual({ status: 'absent' });
  row = { status: 'deleted', revision: 11 };
  expect(await store.readRow()).toEqual(row);
  const records = phases.mock.calls.filter(([message]) => message === '[PROVIDER] Catalog phase');
  expect(records).toContainEqual(['[PROVIDER] Catalog phase', expect.objectContaining({ phase: 'row', status: 'completed' })]);
  expect(records).toContainEqual(['[PROVIDER] Catalog phase', expect.objectContaining({ phase: 'account_currentness', status: 'completed' })]);
  expect(JSON.stringify(records)).not.toContain(credentials.token);
  expect(JSON.stringify(records)).not.toContain(operationContext.serverHttpBaseUrl);
  expect(post).not.toHaveBeenCalled();
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toBeUndefined();
  current = false;
  await expect(store.readRow()).rejects.toMatchObject({ code: 'scope-retired' });
});

it('reopens an in-flight catalog read after a source visibility mutation before publishing its winner', async () => {
  const credentials = { token: 'provider-pending-read-owner', encryption: null };
  const scopeKey = resolveAccountSettingsScopeKey(credentials);
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 4, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey });
  const initial = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'A', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1 }] });
  let catalog = initial;
  let rowReads = 0;
  let release: (() => void) | undefined;
  const oldRowWait = new Promise<void>(resolve => { release = resolve; });
  let entered: (() => void) | undefined;
  const oldRowStarted = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 4, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      const captured = catalog;
      if (++rowReads === 1) { entered?.(); await oldRowWait; }
      return { status: 200, data: { status: 'present', revision: captured === initial ? 7 : 8, content: { t: 'plain', v: captured } } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { version: 4, content: { t: 'plain', v: {} } } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    const history = emptyAccountSettingsHistoryCaptureResponse(path);
    if (history) return history;
    throw new Error(`Unexpected Provider pending-read HTTP boundary: ${path}`);
  });
  let committed: (() => void) | undefined;
  const mutationCommitted = new Promise<void>(resolve => { committed = resolve; });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/provider-connections');
    const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
    if (mutation.content?.t !== 'plain') throw new Error('Plain fixture must write Plain catalog');
    catalog = mutation.content.v;
    committed?.();
    return { status: 200, data: { status: 'updated', revision: 8, cursor: 8 } };
  });
  const pendingRead = refreshActiveProviderConnectionsCatalog({ credentials });
  await oldRowStarted;
  const execute = createCliProviderActionExecuteV1({ credentials, serverId: 'provider-home',
    serverHttpBaseUrl: 'https://pending-provider-home.invalid',
    callMachineAction: async () => { throw new Error('Visibility must not consult a daemon'); } });
  const action = execute({ actionId: 'providers.models.source_visibility.set', input: {
    action: 'setConnectionVisibility', connectionId: ProviderConnectionIdSchema.parse('pc_a'), shown: false,
  } }, { surface: 'cli', serverId: 'provider-home' });
  await mutationCommitted;
  release?.();
  expect(await action).toEqual({ ok: true, result: { status: 'updated' } });
  await pendingRead;
  expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog).toMatchObject({
    status: 'ready', revision: 8, catalog: { modelPickerVisibilityByConnectionId: { pc_a: false } },
  });
});
