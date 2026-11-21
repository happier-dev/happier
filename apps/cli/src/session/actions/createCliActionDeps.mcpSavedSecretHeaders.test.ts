import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';

import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each(['mcp.servers.import', 'mcp.servers.update'] as const)('%s binds an existing Saved Secret by reference', async actionId => {
  const base = 'https://mcp-saved-secret.example.test';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'fixture-account' })).toString('base64url')}.signature`, encryption: null };
  const resourceId = 'aa111111-1111-4111-8111-111111111111';
  const ref = formatSharedSavedSecretRefV1(resourceId);
  const entry = { id: 'existing', name: 'existing', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
    remote: { url: 'https://mcp.example.test/mcp', headers: {} } } as const;
  await runWithServerHttpBaseUrl(base, async () => {
    installAxiosRequestMethodAdapter();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const reads: string[] = [];
    let catalog: McpServerCatalogV1 = { v: 1, servers: [entry], bindings: [] };
    let revision = 1;
    let relationship: 'owner' | 'recipient' = 'owner';
    let rejectReference = false;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      reads.push(path);
      if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200, data: { v: 1, rows: [] } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: catalog } } };
      if (path === '/v1/account/saved-secrets/resources') return { status: 200, data: { resources: [
        { ref, source: 'shared_resource', relationship, name: 'Fixture', kind: 'token', revision: 7,
          materialStatus: 'ready', capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      ] } };
      throw new Error(`Unexpected Home read: ${path}`);
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe(MCP_SERVER_CATALOG_ROWS_ROUTE_V1);
      if (rejectReference) return { status: 200, data: { status: 'invalid-reference' } };
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe(revision);
      if (mutation.content?.t !== 'plain') throw new Error('Expected a plain MCP row');
      catalog = mutation.content.v;
      return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
      serverId: 'mcp-home', serverHttpBaseUrl: base, sessionId: 'session', mode: 'plain', ctx: null }));
    const invoke = (secretId: string, actionRequestId: string) => {
      const binding = { t: 'savedSecret', secretId };
      return executor.execute(actionId, actionId === 'mcp.servers.import'
        ? { source: { kind: 'paste', text: JSON.stringify({ mcpServers: {
          [actionRequestId]: { url: `https://mcp.example.test/${actionRequestId}`, headers: { Authorization: 'fixture-placeholder' } },
        } }) }, values: { [`${actionRequestId}:header:Authorization`]: binding }, dryRun: false, expectedRevision: revision }
        : { entry: { ...entry, remote: { ...entry.remote, headers: { Authorization: binding } } }, expectedRevision: revision },
      { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'mcp-home', actionRequestId,
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] } }) });
    };
    expect(await invoke(ref, 'qualified-control')).toMatchObject({ ok: true, result: { revision: 2 } });
    expect(await invoke(resourceId, 'existing-secret-id')).toMatchObject({ ok: true, result: { revision: 3 } });
    expect(await invoke('unknown-resource', 'unknown-secret-id')).toMatchObject({ ok: false, errorCode: 'reference_unavailable' });
    relationship = 'recipient';
    expect(await invoke(resourceId, 'received-secret-id')).toMatchObject({ ok: false, errorCode: 'reference_unavailable' });
    expect(writes).toHaveBeenCalledTimes(2);
    for (const [, body] of writes.mock.calls) {
      const mutation = McpServerCatalogRowMutationV1Schema.parse(body);
      expect(mutation).toMatchObject({ referencedSavedSecretIds: [ref],
        savedSecretRevisions: [{ resourceId, expectedRevision: 7 }] });
      expect(mutation.content).toMatchObject({ t: 'plain', v: { servers: expect.arrayContaining([
        expect.objectContaining({ remote: expect.objectContaining({ headers: { Authorization: { t: 'savedSecret', secretId: ref } } }) }),
      ]) } });
    }
    rejectReference = true;
    const refused = await invoke(ref, 'stale-reference');
    expect(refused).toMatchObject(actionId === 'mcp.servers.import'
      ? { ok: false, errorCode: 'invalid-reference' }
      : { ok: true, result: { status: 'invalid-reference' } });
    expect(revision).toBe(3);
    expect(reads.filter(path => path.includes('/saved-secrets/'))).toEqual(
      Array(5).fill('/v1/account/saved-secrets/resources'),
    );
  });
});
